import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../../src/qoder/errors.ts'
import { createQoderTransport } from '../../src/qoder/transport/index.ts'

const catalog = JSON.stringify({ assistant: [{ key: 'cmodel', enable: true, display_name: 'Cantus' }] })

test('QoderTransport shares concurrent model discovery', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const [first, second] = await Promise.all([
    transport.discoverModels(),
    transport.discoverModels(),
  ])
  assert.equal(catalogCalls, 1)
  assert.equal(first, second)
})

test('QoderTransport retries an idempotent model discovery once', async () => {
  let catalogCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-retry'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-retry' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-retry' }))
      if (url.includes('/model/list')) {
        catalogCalls++
        return catalogCalls === 1 ? new Response('', { status: 503 }) : new Response(catalog)
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const models = await transport.discoverModels()
  assert.equal(catalogCalls, 2)
  assert.equal(models[0]?.id, 'cmodel')
})

test('QoderTransport aborts a shared discovery only after its last waiter leaves', async () => {
  let stallCatalog = false
  let upstreamAborted = false
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-shared'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
      if (url.includes('/model/list') && !stallCatalog) return new Response(catalog)
      if (url.includes('/model/list')) {
        notifyStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  await transport.discoverModels()
  stallCatalog = true
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = transport.discoverModels(firstController.signal)
  const second = transport.discoverModels(secondController.signal)
  await started

  firstController.abort()
  await assert.rejects(first, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, false)

  secondController.abort()
  await assert.rejects(second, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(upstreamAborted, true)
})

test('QoderTransport separates response-header timeout from stream idle timeout', async () => {
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-timeout'),
    resolveMachineId: () => 'machine-test',
    responseHeaderTimeoutMs: 5,
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-timeout' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-timeout' }))
      if (url.includes('/agent_chat_generation')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => (
    error instanceof QoderLlmError
    && error.code === 'TIMEOUT'
    && /response header/u.test(error.message)
  ))
})

const visionModel = {
  id: 'cmodel',
  name: 'Cantus Vision',
  supportsImages: true,
}

const imageRef = {
  attachmentId: 'sha256:image-1' as never,
  mediaType: 'image/png' as const,
  bytes: 3,
  width: 1,
  height: 1,
}

function transportAttachments() {
  return {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
    },
    async readImageRequest(attachment: unknown) {
      return {
        variantId: 'sha256:variant-1',
        attachment,
        data: new Uint8Array([1, 2, 3]),
        mediaType: 'image/png',
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      }
    },
  } as never
}

function imageRequest(): GenerateOptions {
  return {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Look' }, { type: 'image', attachment: imageRef }],
      source: { kind: 'user' },
    })],
  } as GenerateOptions
}

test('QoderTransport publishes images to the center service before streaming', async () => {
  let uploads = 0
  let chatBody = ''
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-image'),
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-image' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-image' }))
      if (url.includes('/image/upload')) {
        uploads++
        return new Response(JSON.stringify({ result: { oss_url: 'https://oss.qoder.sh/x.png' } }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatBody = String(init?.body ?? '')
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(uploads, 1)
  // The chat body is WAF-encoded, so assert on size: an inlined base64 image
  // would make it far larger than a short published URL.
  assert.ok(chatBody.length > 0)
  assert.ok(chatBody.length < 4_000, `chat body unexpectedly large: ${chatBody.length}`)
})

test('QoderTransport rejects images for a non-vision model before authenticating', async () => {
  let patCalls = 0
  let fetchCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => {
      patCalls++
      return Promise.resolve('pt-none')
    },
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (): Promise<Response> => {
      fetchCalls++
      return new Response('{}')
    }) as typeof fetch,
  })

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(imageRequest(), { id: 'cmodel', name: 'Text only' })) continue
  }, (error: Error) => (
    error instanceof QoderLlmError && error.code === 'UNSUPPORTED_CONTENT'
  ))
  assert.equal(patCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('QoderTransport still streams when center image publication fails', async () => {
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-degrade'),
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    logger: { warn: () => {} },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-degrade' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-degrade' }))
      if (url.includes('/image/upload')) return new Response('', { status: 500 })
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(chatCalls, 1)
})

test('QoderTransport signs chat with the job token refreshed during image publication', async () => {
  let exchanges = 0
  let uploads = 0
  let chatUser = ''
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: async () => 'pt-refresh',
    resolveMachineId: () => 'machine-test',
    attachments: transportAttachments(),
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/image/upload')) {
        uploads++
        return uploads === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ url: 'https://oss.qoder.sh/x.png' }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatUser = new Headers(init?.headers).get('Cosy-User')!
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  for await (const _chunk of transport.stream(imageRequest(), visionModel)) continue
  assert.equal(exchanges, 2)
  assert.equal(uploads, 2)
  assert.equal(chatUser, 'user-2')
})

test('QoderTransport retries a chat 401 once with a freshly exchanged job token and reports the refresh', async () => {
  let exchanges = 0
  let chatCalls = 0
  let chatUser = ''
  const refreshed: number[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-reauth'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        chatUser = new Headers(init?.headers).get('Cosy-User')!
        // The cached token answers 401 once; the freshly exchanged one streams.
        return chatCalls === 1 ? new Response('', { status: 401 }) : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(chatCalls, 2)
  assert.equal(exchanges, 2)
  // The retry signed with the new job token's owner, not the rejected one.
  assert.equal(chatUser, 'user-2')
  // The self-heal is reported once the fresh token is accepted, which is what
  // the user-visible notice is built from.
  assert.equal(refreshed.length, 1)
  assert.equal(typeof refreshed[0], 'number')
})

test('QoderTransport recovers when only the second round survives the gateway fault window', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-window'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        // The whole fault window: the cached token and the first fresh one
        // are rejected; the paced second round streams.
        return chatCalls < 3 ? new Response('', { status: 401 }) : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(chatCalls, 3)
  assert.equal(exchanges, 3)
})

test('QoderTransport surfaces the auth failure when the re-auth retry is rejected too', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-dead'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'AUTH')
  // Paced rounds: initial + two re-auth retries, then the failure surfaces
  // honestly instead of looping forever on a revoked PAT.
  assert.equal(chatCalls, 3)
  assert.equal(exchanges, 3)
})

// The verbatim body Qoder answered with on 2026-09-26 22:32-22:36, for both
// regions: a saturated per-model queue announced with HTTP 403 (or a 200 SSE
// envelope carrying statusCodeValue 403).
const qoderQueueBody = JSON.stringify({
  code: '10605',
  message: JSON.stringify({
    isQueued: true,
    modelKey: 'qfmodel',
    queueCount: 8887,
    queueType: 'p3',
    retryAfterSeconds: 30,
    serviceAvailable: true,
    waitTime: 274,
  }),
})

test('QoderTransport does not exchange a job token when the upstream answer is a queue', async () => {
  // Coding that 403 as AUTH made the self-heal exchange fresh tokens against a
  // queue no token can jump — three exchanges and a 4-second delay per chat,
  // every chat, for the whole window — and, because the host retries
  // RATE_LIMIT but deliberately never AUTH, it also suppressed the automatic
  // retry that would have ridden out the 30-second window.
  let exchanges = 0
  let chatCalls = 0
  const refreshed: number[] = []
  const refreshFailed: Array<{ at: number; status?: number }> = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    onJobTokenRefreshFailed: info => { refreshFailed.push(info) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response(
          'data: ' + JSON.stringify({ statusCodeValue: 403, body: qoderQueueBody }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.failure.status, 403)
    assert.equal(error.failure.providerRetryAfterMs, 30_000)
    return true
  })
  // One chat attempt, one credential exchange (the initial fetch), no heal:
  // the queue answer surfaces immediately for the host's retry policy.
  assert.equal(chatCalls, 1)
  assert.equal(exchanges, 1)
  assert.equal(refreshed.length, 0)
  assert.equal(refreshFailed.length, 0)
})

test('QoderTransport reads a queued HTTP 403 from the chat error body', async () => {
  // Same classification on the non-envelope path: the HTTP-level 403 body is
  // read before failing so the queue markers reach the classifier.
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-http'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response(qoderQueueBody, { status: 403 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'RATE_LIMIT')
  assert.equal(chatCalls, 1)
  assert.equal(exchanges, 1)
})

test('QoderTransport reports an exhausted self-heal once, not once per host retry', async () => {
  // The observed outage: one upstream rejection that no fresh token could
  // clear, retried 59 times by the host across 75 steps. The transport
  // re-heals inside every one of those, so the notice needs a latch or the
  // conversation fills with identical rows.
  let exchanges = 0
  let chatCalls = 0
  const failures: Array<{ at: number; status?: number }> = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-storm'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshFailed: info => { failures.push(info) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        // Every token, cached or freshly exchanged, is rejected: the 403 the
        // upstream answers inside its SSE envelope, which survives a rotation.
        return new Response(
          'data: ' + JSON.stringify({ statusCodeValue: 403, body: '{"message":"quota exhausted"}' }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  // Three host-level attempts, each running the transport's own heal to exhaustion.
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(async () => {
      for await (const _chunk of transport.stream(request)) continue
    }, (error: Error) => error instanceof QoderLlmError && error.code === 'AUTH')
  }

  assert.equal(failures.length, 1, 'the failed heal is announced once per outage')
  assert.equal(typeof failures[0].at, 'number')
  assert.equal(failures[0].status, 403)
  // The heal genuinely ran each time: initial + two paced rounds per attempt.
  assert.equal(chatCalls, 9)
  assert.equal(exchanges, 7)
})

test('QoderTransport re-arms the failed-heal notice after a chat is accepted', async () => {
  // The latch must not mute a later, separate outage: an accepted chat proves
  // the credential works again, so the next exhaustion is news.
  let exchanges = 0
  let chatCalls = 0
  let acceptNext = false
  const failures: number[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-recover'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshFailed: () => { failures.push(Date.now()) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  // Outage one: exhausted, announced.
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'AUTH')
  assert.equal(failures.length, 1)

  // A chat the upstream accepts re-arms the notice.
  acceptNext = true
  for await (const _chunk of transport.stream(request)) continue

  // Outage two: a different rejection, announced again.
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'AUTH')
  assert.equal(failures.length, 2)
})

test('QoderTransport does not print a stale success notice after a failed heal', async () => {
  // The observed defect: a heal at 16:56 whose own retry was also rejected
  // left its success notice pending. A chat accepted 51 minutes later flushed
  // it, printing "jobToken 已自动刷新（16:56:13）" next to a 17:47 message —
  // directly contradicting the failure row already shown for the same heal.
  let exchanges = 0
  let chatCalls = 0
  let acceptNext = false
  const refreshed: number[] = []
  const failures: number[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-stale'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    onJobTokenRefreshFailed: () => { failures.push(Date.now()) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  // The heal runs to exhaustion: fresh tokens, still rejected.
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'AUTH')
  assert.equal(failures.length, 1)

  // A later chat succeeds. The failed heal must NOT retroactively claim it.
  acceptNext = true
  for await (const _chunk of transport.stream(request)) continue
  assert.equal(refreshed.length, 0, 'a heal that did not recover must not leave a success notice pending')
})

test('QoderTransport drops a success notice whose rotation went stale', async () => {
  // The heal's own retry can lose a race with a transient fault, so the notice
  // is deferred until some chat is accepted. That deferral is bounded: a row
  // appearing long after the rotation it names reads as a clock bug.
  let chatCalls = 0
  let acceptNext = false
  const refreshed: number[] = []
  const realNow = Date.now
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-oldnotice'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-1' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (acceptNext) {
          acceptNext = false
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        // First the cached token is rejected as unauthorized (which is what
        // arms the heal and sets the pending notice); then the heal's own retry
        // hits a transient fault, which is not an authorization rejection, so
        // it surfaces immediately and leaves the notice pending.
        return chatCalls === 1 ? new Response('', { status: 401 }) : new Response('', { status: 502 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'SERVER')

  // Ten minutes pass before any chat is accepted.
  Date.now = () => realNow() + 10 * 60 * 1000
  try {
    acceptNext = true
    for await (const _chunk of transport.stream(request)) continue
  } finally {
    Date.now = realNow
  }
  assert.equal(refreshed.length, 0, 'a rotation older than the notice window is dropped, not printed late')
})

test('QoderTransport prints a fresh success notice when the heal recovers promptly', async () => {
  // The other side of the age bound: a rotation that IS accepted promptly
  // still gets its notice, with the rotation's own timestamp.
  let chatCalls = 0
  const refreshed: number[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-prompt'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => { refreshed.push(info.at) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-1' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return chatCalls === 1 ? new Response('', { status: 401 }) : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  for await (const _chunk of transport.stream(request)) continue
  assert.equal(refreshed.length, 1)
  assert.ok(Math.abs(refreshed[0] - Date.now()) < 60_000, 'the notice carries the rotation time, which is recent')
})

test('QoderTransport does not re-auth on failures that are not authorization rejections', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-server'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response('', { status: 502 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'SERVER')
  assert.equal(chatCalls, 1)
  assert.equal(exchanges, 1)
})

test('QoderUsageReader retries a 401 usage read once with a fresh job token', async () => {
  let exchanges = 0
  let usageCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-usage'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: `user-${exchanges}` }))
      if (url.includes('/quota/usage')) {
        usageCalls++
        // The stale token is rejected once; the refreshed one answers.
        return usageCalls === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ userQuota: { total: 300, used: 0 } }))
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const account = await transport.readAccount({ force: true })
  assert.equal(usageCalls, 2)
  assert.equal(exchanges, 2)
  assert.equal(account.usage?.userQuota?.total, 300)
})

