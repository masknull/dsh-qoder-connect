import { createServer, request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qoderCredentialId, QoderCredentialStore, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL } from '../src/auth.ts'
import { type QoderModelInfo } from '../src/catalog.ts'
import { qoderStatusHandler, qoderWebStatus, QODER_STATUS_PATH, type QoderStatusRouteOptions } from '../src/web-status.ts'
import { CHINA_VARIANT } from '../src/variants.ts'

/**
 * The same-origin status route on its Qoder shape: the signed-in document
 * carries a redacted PAT summary (`{source, savedAtMs?, patTail?}`), region,
 * credits (or a degraded `creditsError`), catalog provenance, model snapshots
 * with their capacity facts, and the in-process control keys — while the
 * signed-out arm keeps the diagnosis of a stale legacy file and still hands
 * the card its `authKey`.
 */

const CLEANUP: (() => Promise<void>)[] = []

const SAVED_AT = 1_792_128_236_868

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

beforeEach(() => {
  // Never let a developer machine's exported PAT answer these fixtures.
  vi.stubEnv(QODER_PAT_ENV_CN, '')
  vi.stubEnv(QODER_PAT_ENV_GLOBAL, '')
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-status-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function storeAt(ownPath: string): QoderCredentialStore {
  return new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath })
}

/** The plugin's v2 document: version, pat, region, savedAt — nothing else. */
async function writePatDoc(own: string, pat = 'pt-secret-abcd'): Promise<void> {
  await writeFile(own, JSON.stringify({ version: 2, pat, region: 'china', savedAt: SAVED_AT }))
}

function baseDeps(ownPath: string): QoderStatusRouteOptions {
  return {
    store: storeAt(ownPath),
    client: { fetchCredits: async () => ({ total: 0, accounts: [] }) },
    models: () => [],
  }
}

function model(overrides: Partial<QoderModelInfo>): QoderModelInfo {
  return {
    id: 'm',
    name: 'M',
    contextWindow: 100_000,
    maxTokens: 1024,
    supportsImages: false,
    billing: { free: false },
    ...overrides,
  }
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function requestOnce(options: {
  port: number
  method: string
  headers: Record<string, string>
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: QODER_STATUS_PATH,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function startStatusServer(overrides: Partial<QoderStatusRouteOptions> = {}): Promise<number> {
  const dir = await tempDir()
  // The plugin's own credential file: the store reads nothing else.
  const own = join(dir, '.qoder-auth.json')
  await writePatDoc(own)
  const deps: QoderStatusRouteOptions = { ...baseDeps(own), ...overrides }
  const server = createServer(qoderStatusHandler(deps))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  CLEANUP.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return port
}

describe('signed-in document assembly', () => {
  it('reports the redacted PAT summary, region, and credits', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writePatDoc(own, 'pt-secret-abcd')
    const doc = await qoderWebStatus({
      ...baseDeps(own),
      client: { fetchCredits: async () => ({
        total: 42,
        totalSize: 100,
        accounts: [{ packageName: '个人额度', remain: 58, size: 100, packageEndTime: '2026-10-01T00:00:00Z' }],
        cycleResetTime: '2026-10-01T00:00:00Z',
      }) },
      authKey: 'auth-key-1',
    })
    expect(doc.status).toBe('signed-in')
    if (doc.status !== 'signed-in') return // narrowing for the asserts below
    expect(doc.region).toBe('china')
    expect(doc.pat).toMatchObject({ source: 'card', savedAtMs: SAVED_AT, patTail: 'abcd' })
    // The saved-token list (redacted) rides the same document: the card's
    // account select is built from it.
    expect(doc.activePatId).toBe(qoderCredentialId('pt-secret-abcd'))
    expect(doc.patProfiles).toEqual([{
      id: qoderCredentialId('pt-secret-abcd'),
      patTail: 'abcd',
      savedAtMs: SAVED_AT,
    }])
    expect(doc.authKey).toBe('auth-key-1')
    expect(doc.credits).toMatchObject({ total: 42, totalSize: 100 })
    // The token material never crosses to the browser.
    expect(JSON.stringify(doc)).not.toContain('pt-secret-abcd')
  })

  it('shows an env-sourced PAT with no savedAt', async () => {
    vi.stubEnv(QODER_PAT_ENV_CN, 'pt-env-wxyz')
    const doc = await qoderWebStatus({ ...baseDeps(join(await tempDir(), 'absent.json')), authKey: 'k' })
    expect(doc.status).toBe('signed-in')
    if (doc.status !== 'signed-in') return
    expect(doc.pat).toEqual({ source: 'env', patTail: 'wxyz' })
  })

  it('attaches probe state, probeKey, and the window preference only together', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writePatDoc(own)
    const probe = () => ({ consent: false, running: false, candidates: [], results: [] })
    const withProbe = await qoderWebStatus({ ...baseDeps(own), probe })
    expect(withProbe.status).toBe('signed-in')
    if (withProbe.status !== 'signed-in') return
    expect(withProbe.probe).toEqual({ consent: false, running: false, candidates: [], results: [] })
    // No probeKey was supplied, so none rides the document; no callback means
    // no preference field either.
    expect(withProbe.probeKey).toBeUndefined()
    expect(withProbe.useMaximumContextWindow).toBeUndefined()

    const keyed = await qoderWebStatus({
      ...baseDeps(own),
      probe,
      probeKey: 'probe-key-9',
      useMaximumContextWindow: () => true,
    })
    expect(keyed.status).toBe('signed-in')
    if (keyed.status !== 'signed-in') return
    expect(keyed.probeKey).toBe('probe-key-9')
    expect(keyed.useMaximumContextWindow).toBe(true)

    // probeKey without a probe provider: the key has nothing to describe.
    const orphan = await qoderWebStatus({ ...baseDeps(own), probeKey: 'probe-key-9' })
    expect(orphan.status).toBe('signed-in')
    if (orphan.status !== 'signed-in') return
    expect(orphan.probeKey).toBeUndefined()
  })

  it('degrades a credit failure to creditsError without failing the document', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writePatDoc(own)
    const doc = await qoderWebStatus({
      ...baseDeps(own),
      client: { fetchCredits: async () => {
        throw new Error('upstream said: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4 and pat=pt-live-abc code=deadbeef')
      } },
    })
    expect(doc.status).toBe('signed-in')
    if (doc.status !== 'signed-in') return
    expect(doc.credits).toBeUndefined()
    // Token-like material is redacted before it crosses to the browser.
    expect(doc.creditsError).toContain('[redacted token]')
    expect(doc.creditsError).toContain('pat=[redacted]')
    expect(doc.creditsError).toContain('code=[redacted]')
    expect(doc.creditsError).not.toContain('pt-live-abc')
  })
})

describe('signed-out document', () => {
  it('says signed-out with the authKey and nothing else', async () => {
    const dir = await tempDir()
    const doc = await qoderWebStatus({ ...baseDeps(join(dir, 'absent.json')), authKey: 'auth-key-2' })
    expect(doc).toEqual({ status: 'signed-out', authKey: 'auth-key-2' })
  })

  it('carries the stale-WorkBuddy diagnosis through to the card', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writeFile(own, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', domain: 'www.codebuddy.cn' }))
    const doc = await qoderWebStatus(baseDeps(own))
    expect(doc.status).toBe('signed-out')
    if (doc.status !== 'signed-out') return
    expect(doc.reason).toMatch(/stale WorkBuddy credential file/)
    expect(doc.reason).toMatch(/Personal Access Token/)
    expect(doc.authKey).toBeUndefined()
  })
})

describe('model snapshot reporting', () => {
  /**
   * Capacity and rate facts ride verbatim: no rounding, no invented tiers, and no
   * numbers where the upstream was silent.
   */
  it('reports capacity, efforts, and price factor per row', async () => {
    const port = await startStatusServer({
      models: () => [
        model({
          id: 'glm-x', name: 'GLM X', contextWindow: 200_000, maxTokens: 48_000,
          reasoning: { supports: true, supportedEfforts: ['low', 'high'], defaultEffort: 'low', canDisableThinking: false },
          billing: { credits: 'x0.79', free: false }, source: 'system',
        }),
        model({
          id: 'wide', name: 'Wide', contextWindow: 1_000_000, defaultContextWindow: 200_000,
          supportedContextWindows: [200_000, 1_000_000],
          supportsImages: true, billing: { credits: 'x0', free: true },
        }),
        model({ id: 'unknown-rate', name: 'Unknown Rate', billing: { free: false, rateUnknown: true } }),
        model({ id: 'broken', name: 'Broken', contextWindow: 0, maxTokens: 1_000 }),
      ],
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as { models?: readonly Record<string, unknown>[] }
    const models = new Map((body.models ?? []).map(row => [String(row['id']), row] as [string, Record<string, unknown>]))

    const glm = models.get('glm-x')
    expect(glm?.['contextWindow']).toBe(200_000)
    expect(glm?.['isReasoning']).toBe(true)
    expect(glm?.['reasoningEfforts']).toEqual(['low', 'high'])
    expect(glm?.['defaultReasoningEffort']).toBe('low')
    expect(glm?.['priceFactor']).toBe(0.79)
    expect(glm?.['supportsImages']).toBe(false)
    expect(glm?.['source']).toBe('system')
    // No declared windows means no window fields invented.
    expect(glm?.['defaultContextWindow']).toBeUndefined()
    expect(glm?.['supportedContextWindows']).toBeUndefined()

    const wide = models.get('wide')
    expect(wide?.['contextWindow']).toBe(1_000_000)
    expect(wide?.['defaultContextWindow']).toBe(200_000)
    expect(wide?.['supportedContextWindows']).toEqual([200_000, 1_000_000])
    expect(wide?.['priceFactor']).toBe(0)
    expect(wide?.['supportsImages']).toBe(true)
    expect(wide?.['isReasoning']).toBeUndefined()

    // rateUnknown is reported as "no price factor", never as x1.
    expect(models.get('unknown-rate')?.['priceFactor']).toBeUndefined()
    // A non-positive capacity is not reported rather than shown as "0".
    expect(models.get('broken')?.['contextWindow']).toBeUndefined()
  })

  it('omits the models field when the catalog is empty but keeps provenance', async () => {
    const port = await startStatusServer({
      models: () => [],
      catalog: () => ({ source: 'saved', fetchedAt: 123 }),
    })
    const body = JSON.parse((await requestOnce({
      port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` },
    })).body) as Record<string, unknown>
    // "no models" is precisely the case a user needs explained.
    expect(body['status']).toBe('signed-in')
    expect(body['models']).toBeUndefined()
    expect(body['catalog']).toEqual({ source: 'saved', fetchedAt: 123 })
  })
})

describe('web status route gate', () => {
  it('serves a same-origin GET without an Origin header', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'signed-in',
      pat: { source: 'card', savedAtMs: SAVED_AT, patTail: 'abcd' },
    })
  })

  it('accepts localhost hosts and explicit loopback Origins', async () => {
    const port = await startStatusServer()
    const viaLocalhost = await requestOnce({ port, method: 'GET', headers: { host: `localhost:${String(port)}` } })
    expect(viaLocalhost.status).toBe(200)
    const viaOrigin = await requestOnce({
      port,
      method: 'GET',
      headers: { host: `127.0.0.1:${String(port)}`, origin: `http://127.0.0.1:${String(port)}` },
    })
    expect(viaOrigin.status).toBe(200)
  })

  it('drops a DNS-rebinding style request whose Host is not loopback', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'GET', headers: { host: 'evil.example:3080' } })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'request-not-trusted' })
  })

  it('drops a request whose Origin is not loopback even on a loopback Host', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({
      port,
      method: 'GET',
      headers: { host: `127.0.0.1:${String(port)}`, origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
  })

  it('answers 405 for non-GET methods', async () => {
    const port = await startStatusServer()
    const response = await requestOnce({ port, method: 'POST', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(405)
  })

  it('turns a document-building failure into a redacted 500', async () => {
    const port = await startStatusServer({
      probe: () => { throw new Error('probe state exploded, pat=pt-live-abc') },
    })
    const response = await requestOnce({ port, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    expect(response.status).toBe(500)
    const body = JSON.parse(response.body) as { error: string }
    expect(body.error).toContain('probe state exploded')
    expect(body.error).toContain('pat=[redacted]')
    expect(body.error).not.toContain('pt-live-abc')
  })
})

describe('skipped dependency self-check', () => {
  // A skipped check must be declared on the card, not only in a log.
  const REASON = 'cannot identify the running profile, so the peer version check was skipped'

  it('declares the skip on a signed-in document', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writePatDoc(own)
    const doc = await qoderWebStatus({
      ...baseDeps(own),
      peerCheckSkipped: () => REASON,
    })
    expect(doc.status).toBe('signed-in')
    if (doc.status !== 'signed-in') return
    expect(doc.peerCheckSkipped).toBe(REASON)
  })

  it('declares the skip on a signed-out document too', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    // No credential written: the store answers signed-out with a reason.
    const doc = await qoderWebStatus({
      ...baseDeps(own),
      peerCheckSkipped: () => REASON,
    })
    expect(doc.status).toBe('signed-out')
    if (doc.status !== 'signed-out') return
    expect(doc.peerCheckSkipped).toBe(REASON)
  })

  it('omits the field when the check ran', async () => {
    const own = join(await tempDir(), '.qoder-auth.json')
    await writePatDoc(own)
    const doc = await qoderWebStatus(baseDeps(own))
    expect(doc.status).toBe('signed-in')
    if (doc.status !== 'signed-in') return
    expect('peerCheckSkipped' in doc).toBe(false)
  })
})
