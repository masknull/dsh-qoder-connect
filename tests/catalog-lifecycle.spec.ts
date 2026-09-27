import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { QoderCredentialStore, qoderCredentialIdentity } from '../src/auth.ts'
import { fingerprintModel } from '../src/probe-store.ts'
import { normalizeQoderModels } from '../src/qoder/catalog.ts'
import { modelInfoOf } from '../src/upstream.ts'

/**
 * The plugin module, re-imported per case.
 *
 * `src/index.ts` keeps module-level per-identity records (`lastIdentities`,
 * `lastLiveFetchAt`) that exist so a restart of the SAME account — a 0.1.7
 * settings-write fiber reload — neither re-fetches what was just fetched nor
 * clears the records that account owns. Every case here boots a FRESH temp
 * root, so a previous case's recorded identity would otherwise read as an
 * account switch on the next boot: the saved catalog is deleted, probe
 * observations are cleared, and the roster falls back. Re-importing the module
 * gives each case a clean set of records while `auth`/`catalog`/`probe-store`
 * (stateless) stay on their static imports.
 */
let Qoder: typeof import('../src/index.ts')
let QoderAuth: typeof import('../src/auth.ts')

/**
 * Catalog lifecycle: what happens across a credential change and a failed fetch.
 *
 * These use the real plugin `apply()` with a stubbed global fetch, because the
 * behaviour under test lives in the wiring rather than in any one module — the
 * credential sweep, the catalog gate, and the retry backoff all have to agree.
 *
 * The Qoder transport speaks its own three-step discovery dance — PAT exchange,
 * userinfo, model list — so the stub is a small router over those endpoints
 * rather than one canned envelope per call. Accounts are keyed by the PAT in
 * the exchanged body, then followed through the job token and the `Cosy-User`
 * header, which is what lets one roster answer for one account.
 */

class MemorySettings extends SettingsProvider {
  readonly writable = true
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

/** The model-list envelope the transport's `normalizeQoderModels` parses. */
function catalogEnvelope(modelId: string, name: string): string {
  return JSON.stringify({
    assistant: [{
      key: modelId,
      enable: true,
      display_name: name,
      max_input_tokens: 100_000,
      max_output_tokens: 1_000,
      is_vl: true,
      price_factor: 1,
    }],
  })
}

/**
 * The row the live catalog actually serves for one envelope, computed through
 * the same translation the runtime uses — which is what makes a seeded probe
 * fingerprint match instead of merely resemble.
 */
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
  /** Count of model-list requests seen, so tests can pin "no re-fetch". */
  noteList: () => void
}

/**
 * A fetch stand-in for the Qoder endpoints: exchange → userinfo → model list,
 * account carried across the hops by the exchanged job token and the `Cosy-User`
 * signing header. Loopback URLs (the plugin's own routes) go to the real fetch.
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
      return jsonResponse(JSON.parse(catalogEnvelope(roster.id, roster.name)))
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
 * Stands in for the Host's webServer service so the plugin's REAL routes (as
 * wired by `apply()`, not re-mounted by hand) become callable from a test.
 *
 * The manual-refresh path the reviewer flagged lives inside `apply()`'s route
 * closures, so exercising it needs the actual handlers `apply()` registers —
 * which means the `webServer` inject has to fire. This service collects them.
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
  // Shorten the credential sweep so the lifecycle transitions are observable
  // without waiting the production interval. The retry backoff is expressed in
  // sweeps, so it scales down with it.
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

  it('keeps the fallback roster and retries after a failed fetch', async () => {
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
    // The failed fetch leaves the per-variant fallback serving: the group is
    // visible and usable rather than empty.
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toContain('auto')
    }, { timeout: 10_000 })

    // Without the retry this stayed on the fallback list until a manual
    // refresh — a startup network blip should not require user action.
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
    // Several sweeps' worth of time at the overridden 100ms interval passes
    // while the reads below land; the invariant that matters is that a
    // successful fetch is not repeated for the same identity.
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

  /**
   * The reviewer's second finding: after switching to account B, a MANUAL
   * refresh that fails left account A's catalog serving — under a "live" label,
   * too, since a failed fetch never marks the source fallback, so even the
   * sweep's retry would not have recovered it.
   *
   * This drives the real refresh route (mounted by apply() into the fake
   * webServer) end to end: A's roster live, A's probe observation recorded,
   * switch to B, refresh fails → A's models and A's observation must both be
   * gone, fallback serving, source honestly 'fallback' with the error. Then the
   * next refresh succeeds and B's roster lands.
   */
  it('manual refresh after an account switch drops the old account data even when it fails', async () => {
    const { root, cnPath } = await useRoot()
    await writeFile(cnPath, credentialDocument(PAT_A))

    // Seed a probe observation belonging to account A. The fingerprint must
    // match the row the LIVE catalog serves (the fetch succeeds first here), so
    // it is computed through the same normalize+translate the runtime uses.
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
          // Observations are bound to the account that produced them; a record
          // without this is refused by design, so this names account A's PAT
          // identity (`pat:` + hashed hex).
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
    expect(serving).toContain('auto')

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
   * Saving a PAT is the first-run path: until the catalog lands, the card can
   * only render the built-in roster. The save answer must therefore not arrive
   * before the fetch it triggers — the card re-reads the status the moment that
   * answer lands, and returning early left the user looking at the fallback
   * list until a manual refresh or a later poll.
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
    // A deliberately slow discovery call: without it the stub answers so fast
    // that a save returning before its fetch still looks correct, because the
    // fire-and-forget fetch lands during the HTTP round trip. The delay is what
    // makes "the answer waited for the catalog" observable rather than timing
    // luck.
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

/**
 * The saved catalog sits between a live fetch and the built-in roster in the
 * plan's degradation order (§4). Without it a restart always dropped the user
 * to the compiled-in snapshot, even when a good catalog had been fetched
 * moments earlier — which the plan and the README both promise not to happen.
 */
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

    // Spy on the freshly imported module's class: `vi.resetModules()` (above)
    // re-evaluates the plugin's module tree per case, so the prototype the
    // running plugin uses is the one this import hands back, not the static
    // reference the file header carries for its stateless helpers.
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
