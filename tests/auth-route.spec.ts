import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAuthKey,
  qoderAuthHandler,
  registerQoderAuthRoute,
  type QoderAuthRouteOptions,
  type QoderAuthSaveResult,
} from '../src/auth-route.ts'
import { validateApiKey } from '../src/upstream.ts'
import { QODER_AUTH_PATH, QODER_GLOBAL_AUTH_PATH } from '../src/status-paths.ts'
import type { QoderAuthStatus } from '../src/auth.ts'

/**
 * Offline tests for the PAT route. Same guards as the probe route: the loopback
 * Host/Origin check drops DNS-rebinding pages, and the in-process key proves the
 * caller was the same-origin card. This route writes a credential to disk. The
 * region is never a request field — `save` closes over one variant.
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

function configuredStatus(pat: string): QoderAuthStatus {
  return {
    state: 'configured',
    region: 'china',
    filePath: '/tmp/.qoder-auth.json',
    pat: { source: 'card', savedAtMs: 1_792_128_236_868, patTail: pat.slice(-4) },
  }
}

/** Mount the handler on an ephemeral port and return its origin and key. */
async function mount(deps?: Partial<QoderAuthRouteOptions>): Promise<{ origin: string; key: string; calls: unknown[] }> {
  const key = createAuthKey()
  const calls: unknown[] = []
  const handler = qoderAuthHandler({
    save: async (pat, label) => {
      calls.push(label === undefined ? ['save', pat] : ['save', pat, label])
      return { ok: true, status: configuredStatus(pat) }
    },
    activate: async id => {
      calls.push(['activate', id])
      return { ok: true, status: configuredStatus('pt-active') }
    },
    remove: async id => {
      calls.push(['remove', id])
      return { ok: true, status: configuredStatus('pt-active') }
    },
    clear: async () => { calls.push(['clear']) },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one PAT action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** POST with full header control, `Host` included: `fetch` refuses to set it. */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('PAT route guards', () => {
  it('rejects anything but POST', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'X-Qoder-Auth-Key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a request whose Host is not loopback', async () => {
    const { origin, key, calls } = await mount()
    // A DNS-rebinding page arrives addressed to the attacker's domain.
    const { status, body } = await postRaw(origin, { action: 'clear' }, { Host: 'evil.example', 'X-Qoder-Auth-Key': key })
    expect(status).toBe(403)
    expect(body.error).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects a browser Origin that is not loopback', async () => {
    const { origin, key, calls } = await mount()
    const { status, body } = await post(origin, { action: 'clear' }, { Origin: 'https://evil.example', 'X-Qoder-Auth-Key': key })
    expect(status).toBe(403)
    expect(body.error).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects missing and wrong keys without touching save/clear', async () => {
    const { origin, calls } = await mount()
    const missing = await post(origin, { action: 'clear' })
    const wrong = await post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': 'not-the-key' })
    expect(missing.status).toBe(403)
    expect(wrong.status).toBe(403)
    expect(missing.body.error).toBe('invalid-auth-key')
    expect(calls).toEqual([])
  })

  it('compares the key without treating a same-length mismatch specially', async () => {
    // The key check rejects on length first, then timingSafeEqual: a wrong key of
    // any length is a plain 403, never a crash and never a partial success.
    const { origin, key, calls } = await mount()
    const sameLength = key === '' ? 'x' : key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')
    expect(sameLength).not.toBe(key)
    for (const presented of ['short', sameLength, key + 'ff']) {
      const { status, body } = await post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': presented })
      expect(status).toBe(403)
      expect(body.error).toBe('invalid-auth-key')
    }
    expect(calls).toEqual([])
    // The real key still works after the failed attempts.
    await expect(post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': key })).resolves.toMatchObject({ status: 200 })
  })

  it('accepts a same-origin request carrying the key', async () => {
    const { origin, key } = await mount()
    const { status } = await post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
  })

  it('rejects a body over the 16KB ceiling', async () => {
    const { origin, key, calls } = await mount()
    // A PAT is a short string, so the body ceiling is small and a runaway body is never buffered.
    const { status } = await post(origin, { action: 'save-pat', pat: 'x'.repeat(20 * 1024) }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(413)
    expect(calls).toEqual([])
  })
})

describe('PAT route actions', () => {
  it('passes a pasted token to save and carries its status back', async () => {
    const { origin, key, calls } = await mount()
    const { status, body } = await post(origin, { action: 'save-pat', pat: 'pt-good-1234' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    expect(calls).toEqual([['save', 'pt-good-1234']])
    expect(body).toMatchObject({ ok: true, status: { state: 'configured', pat: { patTail: '1234' } } })
    expect(JSON.stringify(body)).not.toContain('pt-good-1234')
  })

  it('passes an optional display label to save', async () => {
    const { origin, key, calls } = await mount()
    await post(origin, { action: 'save-pat', pat: 'pt-labeled', label: '  工作号  ' }, { 'X-Qoder-Auth-Key': key })
    expect(calls).toEqual([['save', 'pt-labeled', '  工作号  ']])
  })

  it('refuses a save-pat with a blank token before calling save', async () => {
    const { origin, key, calls } = await mount()
    for (const pat of [undefined, '', '   ', 42]) {
      const { status, body } = await post(origin, { action: 'save-pat', ...pat === undefined ? {} : { pat } }, { 'X-Qoder-Auth-Key': key })
      expect(status).toBe(400)
      expect(body.error).toBe('invalid action')
    }
    expect(calls).toEqual([])
  })

  it('rejects an unknown action', async () => {
    const { origin, key, calls } = await mount()
    const { status } = await post(origin, { action: 'takeover' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(400)
    expect(calls).toEqual([])
  })

  it('reports a refused token as a 200 answer with the stable code', async () => {
    // A rejected PAT is an answer, not a transport failure: the card re-prompts
    // on `qoder_invalid_pat` rather than showing "host unreachable".
    const { origin, key } = await mount({
      save: async () => ({ ok: false, error: 'qoder_invalid_pat' }) satisfies QoderAuthSaveResult,
    })
    const { status, body } = await post(origin, { action: 'save-pat', pat: 'pt-bad' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: false, error: 'qoder_invalid_pat' })
  })

  it('clears the stored token', async () => {
    const { origin, key, calls } = await mount()
    const { status, body } = await post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(calls).toEqual([['clear']])
  })

  it('activates and removes one saved entry by id', async () => {
    const { origin, key, calls } = await mount()
    const activated = await post(origin, { action: 'activate', id: 'id-second' }, { 'X-Qoder-Auth-Key': key })
    expect(activated.status).toBe(200)
    expect(activated.body).toMatchObject({ ok: true, status: { state: 'configured' } })
    const removed = await post(origin, { action: 'remove', id: 'id-second' }, { 'X-Qoder-Auth-Key': key })
    expect(removed.status).toBe(200)
    expect(removed.body).toMatchObject({ ok: true })
    expect(calls).toEqual([['activate', 'id-second'], ['remove', 'id-second']])
  })

  it('reports an unknown saved id as a stable refusal, not a transport error', async () => {
    const { origin, key } = await mount({
      activate: async () => ({ ok: false, error: 'qoder_unknown_pat' }) satisfies QoderAuthSaveResult,
    })
    const { status, body } = await post(origin, { action: 'activate', id: 'gone' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: false, error: 'qoder_unknown_pat' })
  })

  it('refuses activate/remove without an id before calling the host', async () => {
    const { origin, key, calls } = await mount()
    for (const action of ['activate', 'remove']) {
      for (const id of [undefined, '', '   ', 42]) {
        const { status, body } = await post(origin, { action, ...id === undefined ? {} : { id } }, { 'X-Qoder-Auth-Key': key })
        expect(status).toBe(400)
        expect(body.error).toBe('invalid action')
      }
    }
    expect(calls).toEqual([])
  })

  it('answers a throwing operation as a result, not as a transport error', async () => {
    const { origin, key } = await mount({
      clear: async () => { throw new Error('unlink failed: EBUSY') },
    })
    const { status, body } = await post(origin, { action: 'clear' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    expect(body).toEqual({ ok: false, error: 'unlink failed: EBUSY' })
  })

  it('never carries a token-like string to the browser', async () => {
    const { origin, key } = await mount({
      save: async () => {
        throw new Error('upstream rejected pat=SECRETVALUE with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature')
      },
    })
    const { status, body } = await post(origin, { action: 'save-pat', pat: 'pt-x' }, { 'X-Qoder-Auth-Key': key })
    expect(status).toBe(200)
    const message = String((body as { error?: string }).error)
    expect(message).not.toContain('SECRETVALUE')
    expect(message).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(message).toContain('[redacted')
  })
})

describe('route identity is the variant', () => {
  interface FakeCtx {
    effect: (fn: () => (() => void) | void, label: string) => void
    webServer: { register: (r: { path: string; kind: string }) => () => void }
  }

  function fakeCtx(): { ctx: FakeCtx; registered: { path: string; kind: string }[] } {
    const registered: { path: string; kind: string }[] = []
    const ctx: FakeCtx = {
      effect: fn => { const dispose = fn(); void dispose },
      webServer: {
        register: route => { registered.push({ path: route.path, kind: route.kind }); return () => {} },
      },
    }
    return { ctx, registered }
  }

  it('mounts the China path by default and the called path verbatim', () => {
    const deps: QoderAuthRouteOptions = {
      save: async () => ({ ok: true, status: configuredStatus('pt-1') }),
      activate: async () => ({ ok: true, status: configuredStatus('pt-1') }),
      remove: async () => ({ ok: true, status: configuredStatus('pt-1') }),
      clear: async () => {},
    }
    const china = fakeCtx()
    registerQoderAuthRoute(china.ctx as never, deps, 'k')
    expect(china.registered).toEqual([{ path: QODER_AUTH_PATH, kind: 'exact' }])
    expect(QODER_AUTH_PATH).toBe('/plugins/dsh-qoder-connect/auth')

    const global = fakeCtx()
    registerQoderAuthRoute(global.ctx as never, { ...deps, path: QODER_GLOBAL_AUTH_PATH }, 'k')
    expect(global.registered).toEqual([{ path: QODER_GLOBAL_AUTH_PATH, kind: 'exact' }])
    expect(QODER_GLOBAL_AUTH_PATH).toBe('/plugins/dsh-qoder-connect/global/auth')
  })

  it('never reads a region from the body: the save closure owns it', async () => {
    // A token pasted into the global card is validated and stored for the
    // global arm only because that arm's route calls the global save closure.
    const savedFor: string[] = []
    const { origin, key } = await mount({
      save: async pat => {
        savedFor.push(pat)
        return { ok: true, status: configuredStatus(pat) }
      },
    })
    await post(origin, { action: 'save-pat', pat: 'pt-cross-arm', region: 'china' }, { 'X-Qoder-Auth-Key': key })
    expect(savedFor).toEqual(['pt-cross-arm'])
  })
})

describe('save wiring: validateApiKey decides what reaches the store', () => {
  it('validateApiKey answers false for a blank token without touching the network', async () => {
    const fetchMock = vi.fn()
    await expect(validateApiKey('   ', 'china', { fetch: fetchMock })).resolves.toBe('invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a fake-validated token flows route → save → store-shaped status', async () => {
    // Mirrors index.ts's save closure: validate first, persist only on success.
    const store = {
      saved: [] as string[],
      async save(pat: string): Promise<QoderAuthStatus> {
        this.saved.push(pat)
        return configuredStatus(pat)
      },
      async clear(): Promise<void> {},
    }
    const validate = vi.fn(async (pat: string, region: string) => pat === 'pt-valid' && region === 'china')
    const { origin, key } = await mount({
      save: async pat => {
        if (!await validate(pat, 'china')) return { ok: false, error: 'qoder_invalid_pat' as const }
        return { ok: true, status: await store.save(pat) }
      },
      clear: () => Promise.resolve(),
    })

    const rejected = await post(origin, { action: 'save-pat', pat: 'pt-wrong' }, { 'X-Qoder-Auth-Key': key })
    expect(rejected.status).toBe(200)
    expect(rejected.body).toEqual({ ok: false, error: 'qoder_invalid_pat' })
    expect(store.saved).toEqual([])

    const accepted = await post(origin, { action: 'save-pat', pat: 'pt-valid' }, { 'X-Qoder-Auth-Key': key })
    expect(accepted.body).toMatchObject({ ok: true })
    expect(store.saved).toEqual(['pt-valid'])
    expect(validate).toHaveBeenCalledWith('pt-wrong', 'china')
  })
})
