import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCredentialStore, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL } from '../src/auth.ts'
import { QoderCatalog, type QoderModelInfo } from '../src/catalog.ts'
import { createQoderShim, type QoderShim } from '../src/shim.ts'
import { KIND_STATUS, type QoderChatResult, type QoderUpstreamClient } from '../src/upstream.ts'
import { CHINA_VARIANT } from '../src/variants.ts'

/**
 * The loopback shim's contract on the Qoder side: four inbound guards (Host,
 * Origin, bearer secret, JSON content-type), a verbatim pass-through of the
 * chat body (the WorkBuddy-era body normalization is gone — the upstream
 * translates, the shim does not), `/v1/models` owned by the variant's
 * providerId, and the `KIND_STATUS` mapping of upstream failures onto HTTP.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

interface Harness {
  shim: QoderShim
  store: QoderCredentialStore
  upstreamBodies: string[]
  upstreamSignals: (AbortSignal | undefined)[]
  upstreamResponse: () => QoderChatResult
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function sseResponse(text: string): QoderChatResult {
  return {
    ok: true,
    response: new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  }
}

async function startShim(
  upstreamResponse: () => QoderChatResult,
  options: { providerId?: string, signedIn?: boolean, catalog?: QoderCatalog } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  // The env fallback must never answer from a developer machine's stray token.
  vi.stubEnv(QODER_PAT_ENV_CN, '')
  vi.stubEnv(QODER_PAT_ENV_GLOBAL, '')
  // The only credential the plugin accepts is its v2 PAT document.
  const own = join(dir, '.qoder-auth.json')
  if (options.signedIn !== false) {
    await writeFile(own, JSON.stringify({
      version: 2,
      pat: 'pt-shim-1234',
      region: 'china',
      savedAt: Date.now(),
    }))
  }
  const store = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: own })
  const harness: Harness = {
    shim: undefined as unknown as QoderShim,
    store,
    upstreamBodies: [],
    upstreamSignals: [],
    upstreamResponse,
  }
  const client: Pick<QoderUpstreamClient, 'chatStream'> = {
    async chatStream(bodyJson: string, signal?: AbortSignal): Promise<QoderChatResult> {
      harness.upstreamBodies.push(bodyJson)
      harness.upstreamSignals.push(signal)
      return harness.upstreamResponse()
    },
  }
  harness.shim = createQoderShim({
    store,
    client,
    catalog: options.catalog ?? new QoderCatalog(),
    providerId: options.providerId ?? 'qoder',
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

const UNUSED_FAILURE: () => QoderChatResult =
  () => ({ ok: false, status: 502, kind: 'server', message: 'unused' })

describe('Qoder shim guards', () => {
  it('binds loopback only', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    expect(harness.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // A rebinding page resolves evil.com to 127.0.0.1; the browser then sends
    // Host: evil.com:<port>. fetch() forbids overriding Host, so use raw http.
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('accepts Host with a loopback name plus port', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a browser Origin from a non-loopback site', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.com',
        'content-type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('origin_not_allowed')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('accepts a loopback browser Origin', async () => {
    const harness = await startShim(() => sseResponse('data: [DONE]\n\n'))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1:3080',
        // The charset the OpenAI SDK actually sends: still application/json.
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a chat POST with a non-JSON Content-Type (simple-request CSRF)', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(415)
    expect(res.body).toContain('unsupported_media_type')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('checks the content type before the credential (415 wins over 401)', async () => {
    // A signed-out shim with a form-encoded body still answers the CSRF-shape
    // guard first, exactly as the handler's order is written.
    const harness = await startShim(UNUSED_FAILURE, { signedIn: false })
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: 'model=auto',
    })
    expect(res.status).toBe(415)
  })

  it('rejects a loopback request without a bearer (local process without the secret)', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // Everything else about this request is legitimate: loopback Host, no
    // Origin (a local process, not a browser), JSON body. Only the bearer is
    // missing — this is the shape a hostile local process would send.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.body).toContain('unauthorized')
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request with a wrong bearer', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a non-Bearer authorization scheme', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const response = await fetch(`${harness.shim.baseUrl()}/healthz`, {
      headers: { authorization: `Basic ${harness.shim.token()}` },
    })
    expect(response.status).toBe(401)
  })

  it('requires the bearer even on /healthz (guards run before routing)', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const anonymous = await fetch(`${harness.shim.baseUrl()}/healthz`)
    expect(anonymous.status).toBe(401)
    const authed = await fetch(`${harness.shim.baseUrl()}/healthz`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({ ok: true })
  })

  it('answers unknown routes with 404', async () => {
    const harness = await startShim(UNUSED_FAILURE)
    const response = await fetch(`${harness.shim.baseUrl()}/v1/nothing`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { type: 'not_found' } })
  })
})

describe('Qoder shim /v1/models', () => {
  it('lists the fallback roster owned by the variant providerId', async () => {
    const harness = await startShim(UNUSED_FAILURE, { providerId: 'qoder' })
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { object: string, data: { id: string, owned_by: string }[] }
    expect(body.object).toBe('list')
    const ids = body.data.map(model => model.id)
    // The built-in roster mirrors the transport's defaultModels.
    expect(ids).toEqual(['cmodel', 'auto', 'ultimate', 'performance', 'efficient', 'lite'])
    expect(new Set(body.data.map(model => model.owned_by))).toEqual(new Set(['qoder']))
  })

  it('reports the global variant providerId for the global arm', async () => {
    const harness = await startShim(UNUSED_FAILURE, { providerId: 'qoder-global' })
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    const body = await response.json() as { data: { owned_by: string }[] }
    expect(body.data.every(model => model.owned_by === 'qoder-global')).toBe(true)
  })

  it('follows the live catalog', async () => {
    const row: QoderModelInfo = {
      id: 'qmodel-x', name: 'Q Model X', contextWindow: 1000, maxTokens: 100,
      supportsImages: false, billing: { free: false },
    }
    const catalog = new QoderCatalog([row])
    const harness = await startShim(UNUSED_FAILURE, { catalog })
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    const body = await response.json() as { data: { id: string }[] }
    expect(body.data.map(model => model.id)).toEqual(['qmodel-x'])
  })
})

describe('Qoder shim chat pass-through', () => {
  it('forwards the request body verbatim and streams the SSE through', async () => {
    const harness = await startShim(() => sseResponse(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
    ))
    const sent = {
      model: 'auto',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'auto' },
    }
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify(sent),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('你好')
    expect(text).toContain('[DONE]')
    // The shim translates nothing any more: the exact bytes reach upstream.
    expect(harness.upstreamBodies.length).toBe(1)
    expect(JSON.parse(harness.upstreamBodies[0] ?? '')).toEqual(sent)
    // And the request's abort signal is handed to the upstream client.
    expect(harness.upstreamSignals[0]).toBeInstanceOf(AbortSignal)
  })

  it('keeps reasoning_effort in the forwarded body', async () => {
    const harness = await startShim(() => sseResponse('data: [DONE]\n\n'))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['reasoning_effort']).toBe('xhigh')
  })

  it('answers 401 not_signed_in before reading a body when no credential exists', async () => {
    const harness = await startShim(UNUSED_FAILURE, { signedIn: false })
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string, code: string, message: string } }
    expect(body.error.type).toBe('not_signed_in')
    expect(body.error.code).toBe('not_signed_in')
    // The store's own MISSING_CREDENTIAL phrasing surfaces in the message...
    expect(body.error.message).toContain('MISSING_CREDENTIAL')
    // ...and nothing was forwarded.
    expect(harness.upstreamBodies).toHaveLength(0)
  })
})

describe('Qoder shim error mapping', () => {
  it('pins the KIND_STATUS table', () => {
    expect(KIND_STATUS).toEqual({
      missing_credential: 401,
      auth: 401,
      soft_rate: 429,
      quota_exceeded: 402,
      server: 502,
      client: 400,
    })
  })

  it('maps a quota_exceeded failure onto HTTP 402', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'quota_exceeded',
      message: 'quota exhausted',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string, code: string, message: string } }
    expect(body.error.type).toBe('quota_exceeded')
    expect(body.error.code).toBe('quota_exceeded')
    expect(body.error.message).toContain('qoder upstream quota_exceeded (http 402)')
    expect(body.error.message).toContain('quota exhausted')
  })

  it('maps auth and soft_rate onto 401 and 429 with the client-visible status', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 401,
      kind: 'auth',
      message: 'invalid token',
    }))
    const auth = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(auth.status).toBe(401)
    expect((await auth.json() as { error: { type: string } }).error.type).toBe('auth')
  })

  it('quotes the outbound status, never the upstream queue 403', async () => {
    // The harness's pi-ai error classifier matches 401/403 in message text
    // ahead of 429/rate-limit. A queue answer reaching it with the upstream's
    // 403 in the text read as "API 密钥无效" (observed 2026-09-26 23:30 and
    // 23:40), so the shim quotes its own outbound code.
    const harness = await startShim(() => ({
      ok: false,
      status: 403,
      kind: 'soft_rate',
      message: 'Qoder is queueing requests (retry after 30s)',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(429)
    const body = await response.json() as { error: { type: string, code: string, message: string } }
    expect(body.error.type).toBe('soft_rate')
    expect(body.error.code).toBe('soft_rate')
    expect(body.error.message).toContain('(http 429)')
    expect(body.error.message).not.toMatch(/\b(?:401|403)\b/u)
  })

  it('truncates a runaway upstream message to 400 characters', async () => {
    const long = 'x'.repeat(1000)
    const harness = await startShim(() => ({
      ok: false,
      status: 502,
      kind: 'server',
      message: long,
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(502)
    const body = await response.json() as { error: { message: string } }
    // The message carries a fixed prefix plus at most 400 chars of upstream text.
    expect(body.error.message.length).toBeLessThanOrEqual('qoder upstream server (http 502): '.length + 400)
    expect(body.error.message).toContain('x'.repeat(400))
    expect(body.error.message).not.toContain(`${'x'.repeat(401)}`)
  })
})
