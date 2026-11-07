import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { qoderCredentialId, QoderCredentialStore, qoderCredentialIdentity } from '../src/auth.ts'
import { fingerprintModel } from '../src/probe-store.ts'
import { normalizeQoderModels } from '../src/qoder/catalog.ts'
import { modelInfoOf } from '../src/upstream.ts'

/**
 * The plugin module, re-imported per case: `src/index.ts` keeps module-level
 * per-identity records, and every case boots a fresh temp root — which would
 * otherwise read as an account switch. The stateless modules stay static.
 */
let Qoder: typeof import('../src/index.ts')
let QoderAuth: typeof import('../src/auth.ts')

/**
 * Catalog lifecycle: what happens across a credential change and a failed fetch.
 *
 * These drive the real `apply()` with a stubbed fetch, because the behaviour
 * lives in the wiring — credential sweep, catalog gate, retry backoff — rather
 * than in any one module. The stub routes Qoder's three discovery hops (PAT
 * exchange, userinfo, model list), keying accounts by the exchanged job token.
 */

class MemorySettings extends SettingsProvider {
  // `writable` is an accessor on SettingsForms; a plain field is a type error.
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

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined

beforeEach(async () => {
  vi.resetModules()
  Qoder = await import('../src/index.ts')
  QoderAuth = await import('../src/auth.ts')
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dispose of CLEANUP.splice(0)) await dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-lifecycle-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** The two PATs these specs sign in with, and the users the fake upstream maps them to. */
const PAT_A = 'pt-alpha-aaaaaaaaaaaaaaaaaaaaaa'
const PAT_B = 'pt-bravo-bbbbbbbbbbbbbbbbbbbbbb'
const IDENTITY_A = qoderCredentialIdentity({ pat: PAT_A })
const IDENTITY_B = qoderCredentialIdentity({ pat: PAT_B })
const USER_A = 'uid-a'
const USER_B = 'uid-b'

/** The Qoder-shaped credential document: version 2, pat, region, savedAt. */
function credentialDocument(pat: string, region: 'china' | 'global' = 'china'): string {
  return JSON.stringify({ version: 2, pat, region, savedAt: Date.now() })
}

/** A v3 document with several saved tokens, one of them active. */
function multiCredentialDocument(activePat: string): string {
  return JSON.stringify({
    version: 3,
    activeId: qoderCredentialId(activePat),
    credentials: [PAT_A, PAT_B].map(pat => ({
      id: qoderCredentialId(pat),
      pat,
      region: 'china',
      savedAt: Date.now(),
    })),
  })
}

/** The model-list envelope the transport's `normalizeQoderModels` parses. */
function catalogEnvelope(modelId: string, name: string): string {
  return catalogEnvelopeMany([{ id: modelId, name }])
}

/** A model-list envelope with several rows (a per-account roster can differ). */
function catalogEnvelopeMany(rows: readonly { id: string; name: string }[]): string {
  return JSON.stringify({
    assistant: rows.map(row => ({
      key: row.id,
      enable: true,
      display_name: row.name,
      max_input_tokens: 100_000,
      max_output_tokens: 1_000,
      is_vl: true,
      price_factor: 1,
    })),
  })
}

/** The row the live catalog serves for an envelope, via the runtime's own translation. */
function liveRowOf(envelope: string) {
  return modelInfoOf(normalizeQoderModels(JSON.parse(envelope))[0]!)
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** State the fake upstream router reads per request; tests flip these. */
interface UpstreamState {
  /** Fail every upstream call while true. */
  fail: () => boolean
  /** Never resolve the model-list call for this user (abandon it to abort). */
  hangListFor: () => string | undefined
  /** Which roster the user's model list answers with. */
  rosterFor: (user: string) => { id: string; name: string }
  /** Extra rows appended to that user's roster (e.g. a per-account-only model). */
  extraRosterFor?: (user: string) => readonly { id: string; name: string }[]
  /** Count of model-list requests seen, so tests can pin "no re-fetch". */
  noteList: () => void
}

/**
 * Fetch stand-in for Qoder's hops (exchange → userinfo → model list), the
 * account carried by the job token and the `Cosy-User` header. Loopback URLs —
 * the plugin's own routes — go to the real fetch.
 */
function qoderFetch(state: UpstreamState): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const realFetch = globalThis.fetch
  const patToUser = new Map<string, string>([[PAT_A, USER_A], [PAT_B, USER_B]])
  return async (url, init) => {
    const href = String(url)
    if (href.startsWith('http://127.0.0.1')) return await realFetch(url, init)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = String(value)
    }
    if (state.fail()) return jsonResponse('upstream down', 503)
    if (href.includes('/api/v1/jobToken/exchange')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { personal_token?: string }
      const user = patToUser.get(body.personal_token ?? '')
      if (user === undefined) return jsonResponse({ message: 'invalid token' }, 401)
      return jsonResponse({ token: `jt-${user}`, expires_in: 86_400_000 })
    }
    if (href.includes('/api/v1/userinfo')) {
      const user = headers['authorization']?.replace(/^Bearer jt-/u, '') ?? ''
      if (user !== USER_A && user !== USER_B) return jsonResponse({ message: 'no such user' }, 404)
      return jsonResponse({ id: user, email: `${user}@example.invalid`, name: user })
    }
    if (href.includes('/algo/api/v2/model/list')) {
      state.noteList()
      const user = headers['cosy-user'] ?? ''
      if (state.hangListFor() === user) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('old account request aborted')), { once: true })
        })
      }
      const roster = state.rosterFor(user)
      const rows = [roster, ...state.extraRosterFor?.(user) ?? []]
      return jsonResponse(JSON.parse(catalogEnvelopeMany(rows)))
    }
    if (href.includes('/api/v2/quota/usage')) {
      return jsonResponse({
        userQuota: { total: 1_000, used: 200, remaining: 800, unit: 'credits' },
        totalUsagePercentage: 20,
        isQuotaExceeded: false,
        expiresAt: Date.now() + 3_600_000,
      })
    }
    if (href.includes('/api/v2/user/plan') || href.includes('/api/v3/user/status')) {
      return jsonResponse({})
    }
    return jsonResponse({ message: 'not found' }, 404)
  }
}

/**
 * Stands in for the Host's webServer so the REAL routes wired by `apply()` (not
 * re-mounted by hand) become callable: the refresh path lives inside those
 * closures, so the `webServer` inject has to fire.
 */
class FakeWebServer extends Service {
  /** Latest instance; the class is plugged per test. */
  static current: FakeWebServer | undefined
  readonly routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    FakeWebServer.current = this
  }

  register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

/** Serve the captured routes over real HTTP, so the handlers see real req/res. */
async function serve(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404).end('{}'); return }
    void handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  CLEANUP.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return { port, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}

async function boot(): Promise<Context> {
  // Shorten the credential sweep so lifecycle transitions are observable; the
  // retry backoff is expressed in sweeps and scales with it.
  vi.stubEnv('DSH_QODER_POLL_MS', '100')
  // Isolate the filesystem roots: the data dir is the plugin's own, and HOME /
  // USERPROFILE keep the transport's machine-id seed inside the temp root.
  const root = CURRENT_ROOT
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  // A stray PAT in the developer's real environment must not sign a variant in.
  vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', '')
  vi.stubEnv('QODER_CN_PERSONAL_ACCESS_TOKEN', '')
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(Qoder, {})
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
  })
  return ctx
}

/** The temp root of the running test; `boot` wires the env to it. */
let CURRENT_ROOT = ''
async function useRoot(): Promise<{ root: string; cnPath: string }> {
  const root = await tempDir()
  CURRENT_ROOT = root
  return { root, cnPath: join(root, Qoder.CHINA_VARIANT.ownFilename) }
}

describe('catalog lifecycle', () => {
  it('serves a live catalog once the first fetch succeeds', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    let lists = 0
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'live-model', name: 'Live Model' }),
      noteList: () => { lists += 1 },
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 10_000 })
    // The upstream roster replaced the built-in fallback entirely.
    expect((await ctx.llm.listModels('qoder')).map(model => model.id)).not.toContain('auto')
    expect(lists).toBe(1)
  })

  it('serves no roster after a failed fetch and retries once the upstream answers', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))

    let failRemaining = 2
    vi.stubGlobal('fetch', qoderFetch({
      // Fail the first exchange attempts outright: the sweep must recover on
      // its own once the upstream answers again.
      fail: () => {
        if (failRemaining > 0) { failRemaining -= 1; return true }
        return false
      },
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'recovered-model', name: 'Recovered' }),
      noteList: () => {},
    }))

    const ctx = await boot()
    // The failed fetch clears the group: no fallback models appear as if live.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder'))).toEqual([])
    }, { timeout: 10_000 })

    // Without the retry, a startup network blip needed a manual refresh to recover.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['recovered-model'])
    }, { timeout: 15_000 })
  })

  it('does not re-fetch the catalog on every credential sweep', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    let lists = 0
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'live-model', name: 'Live' }),
      noteList: () => { lists += 1 },
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 10_000 })
    const afterFirst = lists
    // The invariant: a successful fetch is not repeated for the same identity.
    for (let index = 0; index < 5; index += 1) await ctx.llm.listModels('qoder')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(lists).toBe(afterFirst)
  })

  it('hides the group when the credential disappears and restores it when it returns', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'live-model', name: 'Live' }),
      noteList: () => {},
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 10_000 })

    // Signing out (file removed) must remove the group, not leave it pickable.
    await rm(cnPath)
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('qoder')).toEqual([])
    }, { timeout: 20_000 })

    // Signing back in restores it: the provider stayed registered throughout.
    await writeFile(cnPath, credentialDocument(PAT_A))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['live-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  it('does not show a previous account catalog after the account switches', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: user => user === USER_B
        ? { id: 'account-b-model', name: 'B' }
        : { id: 'account-a-model', name: 'A' },
      noteList: () => {},
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['account-a-model'])
    }, { timeout: 10_000 })

    // Switch accounts in place: a sign-in for another account overwrites the
    // plugin's own credential file.
    await writeFile(cnPath, credentialDocument(PAT_B))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['account-b-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  it('keeps the model switches shared when the active account changes', async () => {
    const { root, cnPath } = await useRoot()
    await writeFile(cnPath, multiCredentialDocument(PAT_A))
    // One configuration for both accounts: the disabled list is written once
    // and is not a property of whichever PAT happens to be active.
    await writeFile(join(root, 'settings.json'), JSON.stringify({ disabledModelsCN: ['b-disabled'] }))
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: user => user === USER_B
        ? { id: 'b-kept', name: 'B kept' }
        : { id: 'a-model', name: 'A' },
      extraRosterFor: user => user === USER_B ? [{ id: 'b-disabled', name: 'B disabled' }] : [],
      noteList: () => {},
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['a-model'])
    }, { timeout: 10_000 })

    // Move the active pointer to the other saved token — the list itself stays.
    await writeFile(cnPath, multiCredentialDocument(PAT_B))
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['b-kept'])
    }, { timeout: 20_000 })
    // `b-disabled` is on B's roster but off in the shared configuration, so it
    // must stay hidden after the switch.
    expect((await ctx.llm.listModels('qoder')).map(model => model.id)).not.toContain('b-disabled')
  }, 45_000)

  /**
   * A failed manual refresh after switching accounts must not leave the previous
   * account's catalog serving under a "live" label: its models and probe
   * observation go, the source says 'fallback' with the error, and the next
   * successful refresh serves the new account.
   */
  it('manual refresh after an account switch drops the old account data even when it fails', async () => {
    const { root, cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))

    // Seed account A's observation: the fingerprint must match the LIVE row, hence normalize+translate.
    const liveRowA = liveRowOf(catalogEnvelope('acct-a-model', 'acct-a-model'))
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', Qoder.QODER_PROBE_FILENAME), JSON.stringify({
      version: 1,
      records: {
        'acct-a-model': {
          fingerprint: fingerprintModel(liveRowA),
          validation: 'validating',
          efforts: ['low'],
          probedAtMs: Date.now(),
          pluginVersion: 'test',
          // Observations are account-bound: `pat:` + hashed hex, or the record is refused.
          account: IDENTITY_A,
        },
      },
    }, null, 2))

    let failCatalog = false
    let rosterModel = 'acct-a-model'
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => failCatalog,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: rosterModel, name: rosterModel }),
      noteList: () => {},
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['acct-a-model'])
    }, { timeout: 10_000 })

    const routes = FakeWebServer.current!.routes
    expect(routes.has('/plugins/dsh-qoder-connect/status')).toBe(true)
    const server = await serve(routes)
    const get = async (path: string) => JSON.parse((await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: `127.0.0.1:${server.port}` } })).text()))
    const post = async (path: string, key: string, body: unknown) =>
      await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'x-qoder-probe-key': key },
        body: JSON.stringify(body),
      })

    // A's observation is live on the card before the switch.
    const before = await get('/plugins/dsh-qoder-connect/status')
    const key = before.probeKey as string
    expect(before.probe.results.map((r: { id: string }) => r.id)).toContain('acct-a-model')
    expect(before.catalog.source).toBe('live')

    // Switch the account in place, and make the catalog fetch fail.
    await writeFile(cnPath, credentialDocument(PAT_B))
    failCatalog = true

    const failed = await post('/plugins/dsh-qoder-connect/probe', key, { action: 'refresh' })
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ state: 'failed' })

    // The invariant: nothing of account A's survives a confirmed switch.
    const after = await get('/plugins/dsh-qoder-connect/status')
    expect(after.probe.results).toEqual([])
    expect(after.catalog.source).toBe('fallback')
    expect(String(after.catalog.error)).toMatch(/503|status/u)
    const serving = (await ctx.llm.listModels('qoder')).map(model => model.id)
    expect(serving).not.toContain('acct-a-model')
    // A failed fetch serves no roster at all — no fallback models masquerading
    // as live ones.
    expect(serving).toEqual([])

    // Recovery: the same manual action once the upstream answers again.
    failCatalog = false
    rosterModel = 'acct-b-model'
    const ok = await post('/plugins/dsh-qoder-connect/probe', key, { action: 'refresh' })
    expect(await ok.json()).toMatchObject({ state: 'refreshed' })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['acct-b-model'])
    }, { timeout: 10_000 })
  }, 45_000)

  /**
   * The save answer must not arrive before the fetch it triggers: the card
   * re-reads the status the moment it lands, so returning early shows the
   * fallback list until a manual refresh or a later poll.
   */
  it('answers a PAT save only after the live catalog the card will read is in place', async () => {
    await useRoot()
    vi.stubEnv('DSH_QODER_POLL_MS', '100')
    const upstream = qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'fresh-model', name: 'Fresh Model' }),
      noteList: () => {},
    })
    // A deliberately slow discovery call, so "the answer waited for the catalog" is not timing luck.
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/algo/api/v2/model/list')) {
        await new Promise(resolve => setTimeout(resolve, 400))
      }
      return await upstream(url, init)
    })

    // No credential file: the card starts on the built-in roster, signed out.
    const ctx = await boot()
    const routes = FakeWebServer.current!.routes
    const server = await serve(routes)
    const get = async (path: string) => JSON.parse((await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: `127.0.0.1:${server.port}` } })).text()))

    const signedOut = await get('/plugins/dsh-qoder-connect/status')
    expect(signedOut.status).toBe('signed-out')
    const authKey = signedOut.authKey as string

    // Sign in through the real route, exactly as the card's Save button does.
    const saved = await fetch(`http://127.0.0.1:${server.port}/plugins/dsh-qoder-connect/auth`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-qoder-auth-key': authKey,
      },
      body: JSON.stringify({ action: 'save-pat', pat: PAT_A }),
    })
    expect(await saved.json()).toMatchObject({ ok: true })

    // No waiting, no polling: the very next read must already be the live list.
    const afterSave = await get('/plugins/dsh-qoder-connect/status')
    expect(afterSave.catalog.source).toBe('live')
    expect(afterSave.models.map((model: { id: string }) => model.id)).toEqual(['fresh-model'])
    expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['fresh-model'])
  }, 45_000)
})

/** The saved catalog: the middle rung between a live fetch and the built-in roster (§4). */
describe('saved catalog', () => {
  it('restores the last successful catalog for the account on a restart with no network', async () => {
    const { root, cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    vi.stubEnv('DSH_QODER_POLL_MS', '100')

    // First run: online, so a live catalog lands and is remembered.
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: () => ({ id: 'saved-model', name: 'Saved' }),
      noteList: () => {},
    }))
    const first = await boot()
    await vi.waitFor(async () => {
      expect((await first.llm.listModels('qoder')).map(model => model.id)).toEqual(['saved-model'])
    }, { timeout: 10_000 })
    // Let the write land before the process is torn down.
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.fiber.dispose()
    context = undefined

    // The saved-catalog file is where the plan says it is: the state directory.
    const savedText = await readFile(join(root, 'state', '.qoder-catalog.json'), 'utf8')
    expect(savedText).toContain(IDENTITY_A)
    expect(savedText).not.toContain(PAT_A)

    // Second run: offline. The saved catalog must serve, not the built-in roster.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const second = await boot()
    await vi.waitFor(async () => {
      expect((await second.llm.listModels('qoder')).map(model => model.id)).toEqual(['saved-model'])
    }, { timeout: 10_000 })
  }, 45_000)
})

describe('identity changes during catalog loading', () => {
  it('does not resurface a signed-out account roster when another account fetch fails', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))

    let fail = false
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => fail,
      hangListFor: () => undefined,
      rosterFor: user => user === USER_B
        ? { id: 'account-b-model', name: 'B' }
        : { id: 'account-a-model', name: 'A' },
      noteList: () => {},
    }))

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['account-a-model'])
    }, { timeout: 10_000 })

    await rm(cnPath)
    await vi.waitFor(async () => { expect(await ctx.llm.listModels('qoder')).toEqual([]) }, { timeout: 20_000 })

    fail = true
    await writeFile(cnPath, credentialDocument(PAT_B))
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('qoder')).map(model => model.id)
      expect(ids).not.toContain('account-a-model')
      expect(ids).toContain('auto')
    }, { timeout: 20_000 })
  }, 45_000)

  it('cancels an old-account request and starts one for the newly selected account', async () => {
    const { cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))

    let lists = 0
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      // The first account's model list hangs until the switch aborts it.
      hangListFor: () => (lists <= 1 ? USER_A : undefined),
      rosterFor: user => user === USER_B
        ? { id: 'account-b-model', name: 'B' }
        : { id: 'account-a-model', name: 'A' },
      noteList: () => { lists += 1 },
    }))

    const ctx = await boot()
    await vi.waitFor(() => { expect(lists).toBe(1) }, { timeout: 10_000 })
    await writeFile(cnPath, credentialDocument(PAT_B))

    await vi.waitFor(async () => {
      expect(lists).toBe(2)
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['account-b-model'])
    }, { timeout: 20_000 })
  }, 45_000)

  it('does not save a resolved credential under an identity read before it changed', async () => {
    const { root, cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))
    vi.stubGlobal('fetch', qoderFetch({
      fail: () => false,
      hangListFor: () => undefined,
      rosterFor: user => user === USER_B
        ? { id: 'account-b-model', name: 'B' }
        : { id: 'account-a-model', name: 'A' },
      noteList: () => {},
    }))

    // Spy on the re-imported module's class: `resetModules()` re-evaluates the tree per case.
    const resolve = QoderAuth.QoderCredentialStore.prototype.resolve
    let switched = false
    vi.spyOn(QoderAuth.QoderCredentialStore.prototype, 'resolve').mockImplementation(async function (this: InstanceType<typeof QoderAuth.QoderCredentialStore>) {
      if (!switched) {
        switched = true
        await writeFile(cnPath, credentialDocument(PAT_B))
      }
      return await resolve.call(this)
    })

    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toEqual(['account-b-model'])
    }, { timeout: 20_000 })
    const saved = JSON.parse(await readFile(join(root, 'state', '.qoder-catalog.json'), 'utf8')) as { entries: Record<string, unknown> }
    expect(saved.entries[IDENTITY_A]).toBeUndefined()
    expect(saved.entries[IDENTITY_B]).toBeDefined()
  }, 45_000)
})
