import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
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

// The queue body, for both regions: a saturated per-model queue announced with
// HTTP 403, or a 200 SSE envelope carrying statusCodeValue 403.
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
  // Coding that 403 as AUTH made the self-heal exchange tokens against a queue no
  // token can jump, and muted the retry that would ride out the 30-second window.
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

test('QoderTransport polls the pending queue entry and replays the same chat body', async () => {
  // Poll the pending entry and replay the same body; a fresh request would join
  // the queue at the tail again.
  let chatCalls = 0
  const bodies: string[] = []
  let polls = 0
  const waits: { attempt: number, waitMs: number, cleared?: boolean, queueCount?: number }[] = []
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-poll'),
    resolveMachineId: () => 'machine-test',
    // Small budget: after the replay is rejected again the wait must run out
    // rather than sit on a real 30-second poll interval.
    queueWaitBudgetMs: () => 60,
    onQueueWait: info => {
      waits.push({
        attempt: info.attempt,
        waitMs: info.waitMs,
        ...info.cleared === true ? { cleared: true } : {},
        ...info.queueCount === undefined ? {} : { queueCount: info.queueCount },
      })
    },
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-poll' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-poll' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        // First poll clears the entry; the ones after the rejected replay keep
        // it queued, so the budget is what ends the wait.
        if (polls === 1) {
          return new Response(JSON.stringify({
            isQueued: false,
            queueCount: 0,
            waitTime: 0,
            retryAfterSeconds: 2,
            serviceAvailable: true,
          }))
        }
        return new Response(JSON.stringify({
          isQueued: true,
          queueCount: 900,
          waitTime: 120,
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        bodies.push(Buffer.from(init?.body as Uint8Array).toString('base64'))
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

  assert.equal(chatCalls, 2)
  assert.ok(polls >= 1)
  // The replay rotates request_id/chat_record_id (the queue key, request_set_id,
  // stays), so the encoded body differs.
  assert.notEqual(bodies[0], bodies[1])
  // The clearing round is the grant, not a wait: it carries no round number, so
  // the row's numbering never skips one, and it is flagged so the caller can
  // close the row instead of leaving it open for the next wait.
  assert.equal(waits[0]?.cleared, true)
  assert.equal(waits[0]?.attempt, 0)
})

test('QoderTransport completes the turn when the queue clears before the replay', async () => {
  let chatCalls = 0
  let polls = 0
  const okChunk = JSON.stringify({
    id: 'chat-1',
    model: 'cmodel',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  const okBody = `data: ${JSON.stringify({ statusCodeValue: 200, body: okChunk })}\n\ndata: [DONE]\n\n`
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-ok'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-ok' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-ok' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({
          isQueued: false,
          queueCount: 0,
          waitTime: 0,
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (chatCalls === 1) return new Response(qoderQueueBody, { status: 403 })
        return new Response(okBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  const chunks = []
  for await (const chunk of transport.stream(request)) chunks.push(chunk)
  assert.equal(polls, 1)
  assert.equal(chatCalls, 2)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined, 'stop')
})

test('QoderTransport gives up when the queue does not clear inside the budget', async () => {
  let polls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-budget'),
    resolveMachineId: () => 'machine-test',
    queueWaitBudgetMs: () => 40,
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-budget' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-budget' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({
          isQueued: true,
          queueCount: 500,
          waitTime: 120,
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }))
      }
      if (url.includes('/agent_chat_generation')) return new Response(qoderQueueBody, { status: 403 })
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
  // One poll answers immediately, one runs after the single budget-sized sleep;
  // neither clears the entry, so the failure is handed to the host.
  assert.equal(polls, 2)
})

test('QoderTransport polls when the queue answer arrives inside the SSE envelope', async () => {
  // The queue answer can arrive as HTTP 200 + statusCodeValue 403, which throws
  // from the SSE parser.
  let chatCalls = 0
  let polls = 0
  const queueEnvelope = `data: ${JSON.stringify({ statusCodeValue: 403, body: qoderQueueBody })}\n\n`
  const okChunk = JSON.stringify({
    id: 'chat-envelope',
    model: 'cmodel',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  const okBody = `data: ${JSON.stringify({ statusCodeValue: 200, body: okChunk })}\n\ndata: [DONE]\n\n`
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-envelope-queue'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-envelope-queue' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-envelope-queue' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({
          isQueued: false,
          queueCount: 0,
          waitTime: 0,
          retryAfterSeconds: 2,
          serviceAvailable: true,
        }))
      }
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        const body = chatCalls === 1 ? queueEnvelope : okBody
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  const chunks = []
  for await (const chunk of transport.stream(request)) chunks.push(chunk)
  assert.equal(polls, 1)
  assert.equal(chatCalls, 2)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined, 'stop')
})

test('QoderTransport stops a queue wait as soon as the caller aborts', async () => {
  const controller = new AbortController()
  let polls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-abort'),
    resolveMachineId: () => 'machine-test',
    onQueueWait: () => controller.abort(),
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-abort' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-abort' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({
          isQueued: true,
          queueCount: 900,
          waitTime: 300,
          retryAfterSeconds: 30,
          serviceAvailable: true,
        }))
      }
      if (url.includes('/agent_chat_generation')) return new Response(qoderQueueBody, { status: 403 })
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    signal: controller.signal,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')
  assert.equal(polls, 1)
})

test('QoderTransport reads the daily-limit 403 as QUOTA and does not re-auth', async () => {
  // End to end: the SSE envelope carries statusCodeValue 403 with the daily
  // billing counter's body — QUOTA, never AUTH, since no fresh PAT fixes it.
  let chatCalls = 0
  let exchanges = 0
  const refreshFailures: number[] = []
  const transport = createQoderTransport({
    region: 'china',
    resolvePat: () => Promise.resolve('pt-daily-limit'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshFailed: info => { refreshFailures.push(info.at) },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        exchanges++
        return new Response(JSON.stringify({ token: `jt-${exchanges}` }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-daily-limit' }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        return new Response(
          'data: ' + JSON.stringify({
            statusCodeValue: 403,
            body: '{"code":"110","message":"Billing daily count exceeded"}',
          }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'qfmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError
    && error.code === 'QUOTA'
    && error.failure.status === 403
    // The digits dsh-llm-pi-ai matches first must be gone, or the user still
    // reads a dead credential.
    && !/\b(?:401|403)\b/u.test(error.message)
    && error.message.includes('Billing daily count exceeded'))

  // A spent daily window is not a rejected credential. The heal exists for a
  // stale job token; a fresh one cannot clear a quota, so it must not run — and
  // it must not report that "the refresh did not recover the chat" either.
  assert.equal(exchanges, 1, 'only the initial exchange; a quota answer must not trigger a re-auth')
  assert.equal(chatCalls, 1, 'the chat is not retried against a spent quota')
  assert.deepEqual(refreshFailures, [], 'no failed-heal notice for a quota answer')
})

test('QoderTransport reports an exhausted self-heal once, not once per host retry', async () => {
  // One rejection no fresh token can clear, retried by the host across many steps:
  // the transport re-heals inside every one, so the notice needs a latch.
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
  // A heal whose own retry was rejected leaves its notice pending; a chat accepted
  // much later must not flush it over the failure row already shown.
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

test('QoderTransport replays when the entry clears even without capacity', async () => {
  // The official client treats isQueued:false as the grant; serviceAvailable is
  // not part of that decision.
  let polls = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-capacity'),
    resolveMachineId: () => 'machine-test',
    queueWaitBudgetMs: () => 80,
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-capacity' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-capacity' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({
          isQueued: false,
          serviceAvailable: false,
          queueCount: 0,
          waitTime: 0,
          retryAfterSeconds: 2,
        }))
      }
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
  assert.ok(polls >= 1)
  // Replayed once: the cleared entry is a grant.
  assert.equal(chatCalls, 2)
})

test('QoderTransport hands the queue answer to the host when the wait is off', async () => {
  let polls = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-queue-off'),
    resolveMachineId: () => 'machine-test',
    queueWait: () => false,
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-off' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-queue-off' }))
      if (url.includes('/ask/queue/status')) {
        polls++
        return new Response(JSON.stringify({ isQueued: false, queueCount: 0, waitTime: 0, retryAfterSeconds: 2 }))
      }
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
  // No poll, no replay: the failure keeps its hint for the host.
  assert.equal(polls, 0)
  assert.equal(chatCalls, 1)
})

test('QoderTransport removes abort listener and cleans up on re-auth backoff abort', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-backoff-abort'),
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

  const controller = new AbortController()
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    signal: controller.signal,
  }

  // Abort during the 2s backoff after the first fresh token is rejected
  setTimeout(() => controller.abort(), 100)

  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(request)) continue
  }, (error: Error) => error instanceof QoderLlmError && error.code === 'ABORTED')

  assert.equal(chatCalls, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('QoderTransport routes sessionId through onJobTokenRefreshed and onJobTokenRefreshFailed', async () => {
  let refreshedSessionId: string | undefined
  let failedSessionId: string | undefined
  let shouldFail = false
  let chatCalls = 0

  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-session-route'),
    resolveMachineId: () => 'machine-test',
    onJobTokenRefreshed: info => {
      refreshedSessionId = info.sessionId
    },
    onJobTokenRefreshFailed: info => {
      failedSessionId = info.sessionId
    },
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-sess' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-sess' }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        if (shouldFail) return new Response('', { status: 401 })
        return chatCalls === 1 ? new Response('', { status: 401 }) : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  // Test successful heal routing
  const reqSuccess: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    sessionId: 'session-alpha-123' as unknown as GenerateOptions['sessionId'],
  }
  for await (const _chunk of transport.stream(reqSuccess)) continue
  assert.equal(refreshedSessionId, 'session-alpha-123')

  // Test failed heal routing
  shouldFail = true
  const reqFail: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    sessionId: 'session-beta-456' as unknown as GenerateOptions['sessionId'],
  }
  await assert.rejects(async () => {
    for await (const _chunk of transport.stream(reqFail)) continue
  }, (error: unknown) => (error as { failure?: { status?: number } })?.failure?.status === 401)
  assert.equal(failedSessionId, 'session-beta-456')
})

test('QoderTransport reports a healed job token however long the retry waited', async () => {
  // The notice used to be dropped when it was stamped over five minutes before
  // acceptance — i.e. whenever the healed retry waited in queue. The clock jumps
  // only while that response is in flight and is restored inside the callback.
  let refreshed: { at: number, sessionId?: string } | undefined
  let chatCalls = 0
  let stamp = Date.now()
  const realNow = Date.now
  try {
    const transport = createQoderTransport({
      region: 'global',
      resolvePat: () => Promise.resolve('pt-long-wait'),
      resolveMachineId: () => 'machine-test',
      onJobTokenRefreshed: info => {
        Date.now = realNow
        refreshed = {
          at: info.at,
          ...(info.sessionId === undefined ? {} : { sessionId: info.sessionId }),
        }
      },
      fetch: (async (input: URL | Request): Promise<Response> => {
        const url = String(input)
        if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-long' }))
        if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-long' }))
        if (url.includes('/agent_chat_generation')) {
          chatCalls++
          if (chatCalls === 1) return new Response('', { status: 401 })
          // The healed retry sits in the upstream queue: minutes pass before its
          // first byte arrives.
          stamp = realNow()
          Date.now = () => stamp + 6 * 60 * 1000
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        throw new Error(`unexpected URL: ${url}`)
      }) as typeof fetch,
    })

    const request: GenerateOptions = {
      provider: 'qoder-official',
      model: 'cmodel',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
      sessionId: 'session-long-wait' as unknown as GenerateOptions['sessionId'],
    }
    for await (const _chunk of transport.stream(request)) continue

    assert.equal(chatCalls, 2)
    assert.equal(refreshed?.sessionId, 'session-long-wait')
    // The row still names the rotation (it happened before the wait), not the
    // acceptance, and the jump does not move that timestamp.
    assert.ok((refreshed?.at ?? Infinity) <= stamp)
  } finally {
    Date.now = realNow
  }
})

test('QoderTransport removes abort listener on re-auth backoff timer resolve', async () => {
  let exchanges = 0
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-backoff-resolve'),
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
        return chatCalls < 3
          ? new Response('', { status: 401 })
          : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const controller = new AbortController()
  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
    signal: controller.signal,
  }

  // Backoff timer expires and resolves normally without aborting
  for await (const _chunk of transport.stream(request)) continue

  assert.equal(chatCalls, 3)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('QoderTransport never replays a stream that already produced chunks before an error', async () => {
  let chatCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => Promise.resolve('pt-no-replay'),
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-replay' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-replay' }))
      if (url.includes('/agent_chat_generation')) {
        chatCalls++
        // Stream that emits a valid reasoning chunk, then a 401 envelope mid-stream.
        // Without the `produced` guard this would trigger a full request replay.
        const okInner = JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] })
        const okEnvelope = JSON.stringify({ statusCodeValue: 200, body: okInner })
        const errEnvelope = JSON.stringify({ statusCodeValue: 401, body: 'unauthorized' })
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${okEnvelope}\n\n`))
            controller.enqueue(new TextEncoder().encode(`data: ${errEnvelope}\n\n`))
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const request: GenerateOptions = {
    provider: 'qoder-official',
    model: 'cmodel',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
  }

  const collected: StreamChunk[] = []
  await assert.rejects(async () => {
    for await (const chunk of transport.stream(request)) {
      collected.push(chunk)
    }
  }, (error: Error) => error instanceof QoderLlmError && error.failure?.status === 401)

  // Produced content must NOT cause a replay: chat was called only once, chunks were emitted
  assert.equal(chatCalls, 1)
  assert.ok(collected.length > 0)
  assert.equal(collected[0]?.type, 'block-start')
})




test('checkIn claims for a named token instead of the active one', async () => {
  // The daily sweep walks every saved PAT. The transport must honour the token it
  // is given, or every account would silently claim through the active one and
  // report the same single result four times.
  const claimed: string[] = []
  let active = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => { active += 1; return Promise.resolve('pt-active') },
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) {
        // The exchange body names the PAT being exchanged; that is how this test
        // tells which account the transport acted for.
        const body = String(init?.body ?? '')
        claimed.push(body.includes('pt-other') ? 'pt-other' : 'pt-active')
        return new Response(JSON.stringify({ token: 'jt-shared' }))
      }
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/me/campaigns/')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }))
      }
      if (url.includes('/me/campaigns')) {
        return new Response(JSON.stringify({
          claimable: true,
          campaigns: [{
            campaignId: 'camp-1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            startAt: Math.floor(Date.now() / 1000) - 60,
            endAt: Math.floor(Date.now() / 1000) + 3600,
            benefit: { amount: 100, kind: 'CREDITS' },
          }],
        }))
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const result = await transport.checkIn(undefined, 'pt-other')
  assert.equal(result.status, 'claimed')
  assert.deepEqual(claimed, ['pt-other'])
  // The active-credential resolver was never consulted for a named claim.
  assert.equal(active, 0)
})

test('checkIn falls back to the active token when none is named', async () => {
  let resolveCalls = 0
  const transport = createQoderTransport({
    region: 'global',
    resolvePat: () => { resolveCalls += 1; return Promise.resolve('pt-active') },
    resolveMachineId: () => 'machine-test',
    fetch: (async (input: URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-1' }))
      if (url.includes('/me/campaigns/')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }))
      }
      if (url.includes('/me/campaigns')) {
        return new Response(JSON.stringify({
          claimable: true,
          campaigns: [{
            campaignId: 'camp-1',
            actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE',
            startAt: Math.floor(Date.now() / 1000) - 60,
            endAt: Math.floor(Date.now() / 1000) + 3600,
            benefit: { amount: 100, kind: 'CREDITS' },
          }],
        }))
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch,
  })

  const result = await transport.checkIn()
  assert.equal(result.status, 'claimed')
  assert.equal(resolveCalls, 1)
})
