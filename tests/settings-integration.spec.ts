import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as Qoder from '../src/index.ts'
import { normalizeQoderModels } from '../src/qoder/catalog.ts'
import { modelInfoOf } from '../src/upstream.ts'
import { QODER_SETTINGS_FACE_PATH } from '../src/status-paths.ts'

/**
 * Host-settings integration for the assembled plugin: which providers register,
 * what configuration the settings face serves, where writes land, and how the
 * global variant's maximum-context preference survives restarts.
 *
 * Since DSH 0.1.7 the host no longer serves per-plugin settings SECTIONS: this
 * plugin's configuration lives in its own `<profile>/.dsh-qoder-connect/
 * settings.json`, served to the browser card over the plugin-owned settings
 * face (`GET/POST /plugins/dsh-qoder-connect/settings`), and the card writes go
 * through that route. These tests therefore drive configuration through the
 * same face the card uses, and assert the file it lands in.
 *
 * WorkBuddy-era cases (device login, app-version telemetry, client identity,
 * the per-product credential-domain realm check) have no Qoder counterpart and
 * were dropped with the features they tested; the realm case is re-expressed
 * as the legacy-credential-file refusal, which is what survives of its intent.
 */

class MemorySettings extends SettingsProvider {
  // 0.1.7 declares `writable` as an accessor on SettingsForms; overriding it
  // with a plain field is a type error, so the stub keeps the same shape.
  override get writable(): boolean {
    return true
  }
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A Qoder credential document as the card's save would have written it. */
function credentialDocument(pat: string, region: 'china' | 'global'): string {
  return JSON.stringify({ version: 2, pat, region, savedAt: Date.now() })
}

/** The PATs this spec signs in with; identities only ever as hashed keys. */
const PAT_CN = 'pt-settings-cn-0000000000000000aa'
const PAT_GLOBAL = 'pt-settings-global-000000000000bb'

/** Isolate the plugin's file roots and silence any real environment PAT. */
function stubEnvRoot(): void {
  vi.stubEnv('DSH_HOME', root!)
  vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root!)
  vi.stubEnv('HOME', root!)
  vi.stubEnv('USERPROFILE', root!)
  vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', '')
  vi.stubEnv('QODER_CN_PERSONAL_ACCESS_TOKEN', '')
}

/**
 * A stand-in for the host's web server service: the plugin registers its
 * routes on it, exactly as it does on the real one, and a test drives the
 * settings face through the captured handler.
 */
class FakeWebServer {
  readonly routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []

  register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }
}

/** A live catalog whose one model declares two context windows (300k default, 1M maximum). */
function bigContextEnvelope(): string {
  return JSON.stringify({
    assistant: [{
      key: 'big-context',
      enable: true,
      display_name: 'Big Context',
      max_input_tokens: 1_000_000,
      max_output_tokens: 1_000,
      is_vl: true,
      price_factor: 1,
      context_config: {
        small: { token_count: 300_000, is_default: true },
        large: { token_count: 1_000_000 },
      },
    }],
  })
}

function liveCatalogFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.includes('/api/v1/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-settings', expires_in: 86_400_000 }), { status: 200 })
    }
    if (href.includes('/api/v1/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-settings', email: 's@example.invalid', name: 's' }), { status: 200 })
    }
    if (href.includes('/algo/api/v2/model/list')) {
      return new Response(bigContextEnvelope(), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

/** One settings-face call: the HTTP status and the JSON document it answered. */
interface FaceAnswer { status: number; document: Record<string, unknown> }

/**
 * Drive the plugin's settings face the way the browser card does: a node-http
 * shaped request/response pair through the captured handler, loopback Host so
 * the trust guard passes, no Origin (a non-browser caller is trusted).
 */
async function callFace(
  handler: (req: unknown, res: unknown) => Promise<void>,
  method: 'GET' | 'POST',
  patch?: Record<string, unknown>,
  key?: string,
): Promise<FaceAnswer> {
  const body = patch === undefined ? undefined : JSON.stringify(patch)
  const request = new Readable({ read() {} })
  Object.assign(request, {
    method,
    headers: {
      host: '127.0.0.1:39271',
      ...body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      ...key === undefined ? {} : { 'x-qoder-settings-key': key },
    },
  })
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => { status = code },
    end: (text: string) => { payload = text },
  }
  const settled = handler(request, response).then(() => ({ status, document: JSON.parse(payload || '{}') as Record<string, unknown> }))
  if (body !== undefined) request.push(body)
  request.push(null)
  return settled
}

/** The settings-face handler a booted plugin registered, or a thrown failure. */
function faceHandler(web: FakeWebServer): (req: unknown, res: unknown) => Promise<void> {
  const route = web.routes.find(entry => entry.path === QODER_SETTINGS_FACE_PATH)
  if (route === undefined) throw new Error('settings face route was not registered')
  return route.handler
}

/** GET the face, then POST one patch authorized with the document's write key. */
async function facePatch(web: FakeWebServer, patch: Record<string, unknown>): Promise<FaceAnswer> {
  const handler = faceHandler(web)
  const read = await callFace(handler, 'GET')
  const key = String(read.document['key'])
  return callFace(handler, 'POST', patch, key)
}

describe('Qoder Host settings integration', () => {
  it('restores the saved maximum-window preference after restarting and can disable it', async () => {
    root = await mkdtemp(join(tmpdir(), 'qoder-context-restart-'))
    const settingsFile = join(root, 'settings.json')
    const globalAuthPath = join(root, Qoder.GLOBAL_VARIANT.ownFilename)
    await writeFile(settingsFile, '{}')
    await writeFile(globalAuthPath, credentialDocument(PAT_GLOBAL, 'global'))
    stubEnvRoot()
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    vi.stubGlobal('fetch', liveCatalogFetch())
    const boot = async (): Promise<{ ctx: Context; web: FakeWebServer }> => {
      const ctx = new Context()
      context = ctx
      const web = new FakeWebServer()
      ctx.provide('webServer')
      ctx.set('webServer', web as never)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(MemorySettings)
      await ctx.plugin(Qoder, {})
      // Wait for the LIVE roster, not merely a visible group: the fallback
      // names no `big-context`, so only this proves the fetch landed.
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('qoder-global')).map(model => model.id)).toContain('big-context')
      }, { timeout: 15_000 })
      return { ctx, web }
    }
    let booted = await boot()
    // Fresh profile, setting never touched: the default is on, so the model
    // resolves at its largest declared window before any update is written.
    expect((await booted.ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)
    await booted.ctx.fiber.dispose()
    booted = await boot()
    // Still on across a restart with nothing stored (schema default, not state).
    expect((await booted.ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)
    // An explicit opt-out must survive restarts: the flipped default may not
    // resurrect the preference the user turned off.
    await facePatch(booted.web, { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await booted.ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
    // The write landed in the plugin's own settings file, which is the source
    // of truth a restart reads.
    const saved = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
    expect(saved['useMaximumContextWindow']).toBe(false)
    await booted.ctx.fiber.dispose()
    booted = await boot()
    expect((await booted.ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
  })

  it('exposes the provider directory entry, the settings face, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-settings-'))
    stubEnvRoot()
    // This case asserts the fallback roster, which is served only to a
    // signed-in variant. Pinning a credential of its own keeps that independent
    // of anything else on this machine: the store reads the plugin's own file
    // under the data dir, and without one the group stays hidden (empty model
    // list) rather than serving the roster.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument(PAT_CN, 'china'))
    // Signing in would otherwise make this case perform a real discovery
    // request; these tests must not touch the network, and the roster asserted
    // below is the compiled-in fallback, so the fetch fails instead.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    const web = new FakeWebServer()
    ctx.provide('webServer')
    ctx.set('webServer', web as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
    // The Models settings page resolves `settingsNs` against the host's served
    // forms. In this harness no profile entry id is available, so the row falls
    // back to the provider's own id — a name this plugin actually owns.
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'qoder',
      displayName: 'Qoder',
      settingsNs: 'qoder',
      settingsPath: [],
      declared: false,
    })

    // The settings face serves the whole configuration: value = effective
    // (schema defaults here), base = the defaults themselves, user = the file
    // layer, which the startup seed fills with the schema defaults so the
    // stored layer stays complete. The Models page and the card both join on it.
    const face = await callFace(faceHandler(web), 'GET')
    expect(face.status).toBe(200)
    expect(face.document['value']).toMatchObject({ useMaximumContextWindowCN: true, quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS })
    expect(face.document['base']).toMatchObject({ quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS })
    expect(face.document['user']).toMatchObject({ probeConsent: false, useMaximumContextWindowCN: true, quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS })

    const models = await ctx.llm.listModels('qoder')
    // The fallback roster mirrors the transport's built-in Qoder pool.
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['cmodel', 'auto', 'ultimate', 'performance', 'efficient', 'lite']))

    // Billing display: the fallback rows declare no rate the plugin can stand
    // behind, so their names carry the rate-unavailable words rather than a
    // fabricated rate — an empty slot would read as a rendering bug.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('auto')?.name).toBe('Qoder Auto · 价格暂不可用')
    expect(byId.get('auto')?.description).toBeUndefined()

    // Thinking controls are declaration-driven: no fallback row declares a
    // reasoning section, so none exposes an effort picker.
    const autoResolved = await ctx.llm.resolveModelInfo('qoder', 'auto')
    expect(autoResolved.reasoning).toBeUndefined()

    // Image modalities follow the per-model catalog flag (fallback list here).
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('lite')).toEqual(['text'])

    // A card write validates against the schema and persists to the plugin's
    // own settings file; the face answers with the new effective view, and the
    // file is what a restart reads.
    const written = await facePatch(web, { probeConsent: true })
    expect(written.status).toBe(200)
    expect((written.document['value'] as Record<string, unknown>)['probeConsent']).toBe(true)
    const saved = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved['probeConsent']).toBe(true)
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants and keeps each variant identity separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-dual-'))
    stubEnvRoot()
    // Shorten the credential sweep: a group appears only once the sweep has
    // adopted the credential it finds in the temporary home.
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    // One real-shaped credential per product, each in the file its own variant
    // owns under the plugin data dir; both arms answer with the live roster.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument(PAT_CN, 'china'))
    await writeFile(join(root, Qoder.GLOBAL_VARIANT.ownFilename), credentialDocument(PAT_GLOBAL, 'global'))
    vi.stubGlobal('fetch', liveCatalogFetch())

    const ctx = new Context()
    context = ctx
    const web = new FakeWebServer()
    ctx.provide('webServer')
    ctx.set('webServer', web as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(async () => {
      // Both arms must be serving the LIVE roster before the per-variant
      // window assertions below: the fallback would pass a bare non-empty check.
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toContain('big-context')
      expect((await ctx.llm.listModels('qoder-global')).map(model => model.id)).toContain('big-context')
    }, { timeout: 15_000 })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
      expect.arrayContaining(['qoder', 'qoder-global']),
    )

    // Each provider carries its own display name, which is the model group
    // heading the picker renders — and its OWN settings namespace: the Models
    // page resolves `settingsNs` against the served forms, so a shared ns would
    // render both providers onto one card.
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      { provider: 'qoder', displayName: 'Qoder', settingsNs: 'qoder', settingsPath: [], declared: false },
      { provider: 'qoder-global', displayName: 'Qoder Global', settingsNs: 'qoder-global', settingsPath: [], declared: false },
    ]))

    // Check model disabling via settings
    await facePatch(web, { disabledModelsCN: ['big-context'] })
    await vi.waitFor(async () => {
      const modelsCN = (await ctx.llm.listModels('qoder')).map(m => m.id)
      expect(modelsCN).not.toContain('big-context')
      const modelsGlobal = (await ctx.llm.listModels('qoder-global')).map(m => m.id)
      expect(modelsGlobal).toContain('big-context')
    })

    await facePatch(web, { disabledModelsCN: [] })
    await vi.waitFor(async () => {
      const modelsCN = (await ctx.llm.listModels('qoder')).map(m => m.id)
      expect(modelsCN).toContain('big-context')
    })

    // A write through the face must reach only THAT variant. The same live
    // roster is served to both arms, and each now carries its own maximum-window
    // preference, so the two toggles are independent observables: flipping the
    // GLOBAL one must move only the global variant's window, and the China
    // answer must stay where its own toggle put it.
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(1_000_000)
    }, { timeout: 10_000 })
    expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(1_000_000)
    await facePatch(web, { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder-global', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
    // The China toggle is untouched: still serving the maximum.
    expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(1_000_000)
    await facePatch(web, { useMaximumContextWindowCN: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('qoder', 'big-context')).context?.contextWindow).toBe(300_000)
    }, { timeout: 10_000 })
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour the plan calls out: a signed-out provider must not
   * publish fallback models that could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-empty-'))
    // The temporary data dir is empty: neither variant's own credential file
    // exists and no environment PAT is set, which is what "nobody has signed
    // in" now means.
    stubEnvRoot()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('qoder')).toEqual([])
    })
    expect(await ctx.llm.listModels('qoder-global')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['qoder', 'qoder-global']))
  })

  /**
   * The environment PAT fallback from the naming contract: a file remains the
   * authority, and without one the arm's own env variable signs it in.
   */
  it('signs in a variant from its environment PAT when no file exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-env-'))
    stubEnvRoot()
    vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', 'pt-from-environment')
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder-global')).length).toBeGreaterThan(0)
    }, { timeout: 15_000 })
    // The China arm reads only its own variable: one env token signs in one
    // variant, and the other stays hidden.
    expect(await ctx.llm.listModels('qoder')).toEqual([])
  })

  /**
   * A stale WorkBuddy-era credential file is refused, and the refusal is what
   * the card would show. Silently treating it as "signed out" would send the
   * user to re-authenticate without naming the actual fix; at plugin level the
   * observable contract is that such a file never reveals models.
   */
  it('refuses a legacy credential file instead of treating it as a PAT', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-legacy-'))
    stubEnvRoot()
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    // The WorkBuddy-era shape: an accessToken document where a Qoder PAT
    // belongs. The store must call it invalid, not migrate or trust it.
    await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
    // Refused, so the group stays hidden rather than serving a roster the stale
    // token cannot actually reach. Give the sweep time to have adopted a valid
    // credential had it accepted this one.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await ctx.llm.listModels('qoder')).toEqual([])
    expect(await ctx.llm.listModels('qoder-global')).toEqual([])
  })

  /**
   * The quota card's fields persist through the settings face: a write lands in
   * the plugin's own settings file and answers with the new effective view.
   */
  it('validates and persists the quota section', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-quota-'))
    stubEnvRoot()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    const web = new FakeWebServer()
    ctx.provide('webServer')
    ctx.set('webServer', web as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })

    const written = await facePatch(web, { sidebarQuotaCN: true })
    expect(written.status).toBe(200)
    expect((written.document['value'] as Record<string, unknown>)['sidebarQuotaCN']).toBe(true)
    const saved = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved['sidebarQuotaCN']).toBe(true)

    // The face refuses what the schema refuses, before anything is written.
    const rejected = await facePatch(web, { quotaPollMs: 'nope' })
    expect(rejected.status).toBe(400)

    // The poll floor is enforced by the schema itself, not by the card. The
    // schema instance is callable: it validates and applies defaults.
    expect(Qoder.QUOTA_POLL_DEFAULT_MS).toBe(300_000)
    expect(Qoder.QUOTA_POLL_MIN_MS).toBe(60_000)
    expect(Qoder.Config({})).toMatchObject({ quotaPollMs: Qoder.QUOTA_POLL_DEFAULT_MS })
    expect(() => Qoder.Config({ quotaPollMs: 1_000 })).toThrow()
    expect(Qoder.Config({ quotaPollMs: Qoder.QUOTA_POLL_MIN_MS })).toMatchObject({ quotaPollMs: Qoder.QUOTA_POLL_MIN_MS })
  })

  it('defaults its model rows to the live-catalog shape the stores fingerprint', async () => {
    // Cross-check the fixture translation used by the probe specs: the same
    // envelope produces a QoderModelInfo with the fallback's own defaults when
    // the upstream declares nothing.
    const row = modelInfoOf(normalizeQoderModels(JSON.parse(bigContextEnvelope())).at(0)!)
    expect(row.contextWindow).toBe(300_000)
    expect(row.defaultContextWindow).toBe(300_000)
    expect(row.supportedContextWindows).toEqual([300_000, 1_000_000])
    expect(row.billing).toEqual({ credits: 'x1', free: false })
    expect(row.reasoning).toBeUndefined()
    // The roster lives where the plan says it does, one file per variant.
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-ident-'))
    await mkdir(join(root, 'state'), { recursive: true })
    stubEnvRoot()
    expect(Qoder.qoderCatalogPath(Qoder.GLOBAL_VARIANT.catalogFilename))
      .toBe(join(root, 'state', '.qoder-global-catalog.json'))
    expect(Qoder.qoderProbePath(Qoder.CHINA_VARIANT.probeFilename))
      .toBe(join(root, 'state', '.qoder-probe.json'))
  })

  it('supplies an attachment facade covering imageLimits, readImageRequest, and saveImage to transport and client', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-qoder-connect-attachments-'))
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', 'auth-qoder.json'), credentialDocument(PAT_CN, 'china'))
    stubEnvRoot()

    const ctx = new Context()
    context = ctx

    const fakeAttachmentStore = {
      imageLimits: {
        maxImagePixels: 1000,
        maxImageBytes: 2000,
        maxImagesPerMessage: 5,
        maxMessageImageBytes: 10000,
      },
      readImageRequest: vi.fn().mockResolvedValue({
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
      }),
      saveImage: vi.fn().mockResolvedValue({
        id: 'test-attachment-id',
        bytes: 3,
        mediaType: 'image/png',
      }),
    }

    ctx.provide('attachments')
    ctx.set('attachments', fakeAttachmentStore as never)

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Qoder, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })
  })
})
