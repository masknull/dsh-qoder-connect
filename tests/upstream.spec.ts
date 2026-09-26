import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../src/qoder/errors.ts'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import type { QoderAccountInfo } from '../src/qoder/account.ts'
import {
  classifyUpstreamError,
  kindFromQoderFailure,
  KIND_STATUS,
  modelInfoOf,
  normalizeCredits,
  QoderUpstreamClient,
  validateApiKey,
  type QoderChatResult,
} from '../src/upstream.ts'

/**
 * Offline unit tests for QoderUpstreamClient.
 *
 * The client speaks OpenAI on one side and the dsh-llm `StreamChunk` vocabulary
 * on the other, so every case here injects a scripted fake transport: no
 * network, no real account, and the exact chunk sequences (including the ones
 * the WorkBuddy-era client never had to answer for) are under test control.
 */

const createTransportMock = vi.hoisted(() => vi.fn())
vi.mock('../src/qoder/transport/index.ts', () => ({ createQoderTransport: createTransportMock }))

afterEach(() => {
  vi.restoreAllMocks()
  createTransportMock.mockReset()
})

// ---------------------------------------------------------------------------
// Fake transport plumbing
// ---------------------------------------------------------------------------

interface StreamCall {
  options: GenerateOptions
  model: QoderCatalogModel | undefined
}

interface FakeSpec {
  chunks?: readonly StreamChunk[]
  /** Throw when `stream()` is called (before any iteration). */
  throwAt?: 'stream' | 'next'
  /** For throwAt='next': throw when the Nth next() is requested (1-based). */
  throwAfter?: number
  error?: unknown
  models?: readonly QoderCatalogModel[]
  discoverError?: unknown
  account?: QoderAccountInfo
}

function makeTransport(spec: FakeSpec = {}): {
  streamCalls: StreamCall[]
  closed: () => boolean
  transport: import('../src/qoder/transport/index.ts').QoderTransport
} {
  const streamCalls: StreamCall[] = []
  let isClosed = false
  const transport = {
    stream(options: GenerateOptions, model?: QoderCatalogModel) {
      streamCalls.push({ options, model })
      if (spec.throwAt === 'stream' && spec.error !== undefined) throw spec.error
      const chunks = spec.chunks ?? []
      let index = 0
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<StreamChunk>> {
              if (spec.throwAt === 'next' && index === (spec.throwAfter ?? 1)) {
                index += 1
                throw spec.error ?? new Error('boom')
              }
              if (index >= chunks.length) return { done: true, value: undefined as never }
              const value = chunks[index] as StreamChunk
              index += 1
              return { done: false, value }
            },
            async return(): Promise<IteratorResult<StreamChunk>> {
              isClosed = true
              return { done: true, value: undefined as never }
            },
          }
        },
      }
    },
    async discoverModels(): Promise<readonly QoderCatalogModel[]> {
      if (spec.discoverError !== undefined) throw spec.discoverError
      return spec.models ?? []
    },
    async readAccount(): Promise<QoderAccountInfo> {
      if (spec.account === undefined) throw new Error('no account scripted')
      return spec.account
    },
  }
  return { streamCalls, closed: () => isClosed, transport: transport as never }
}

function makeClient(spec: FakeSpec = {}, extra?: Partial<ConstructorParameters<typeof QoderUpstreamClient>[0]>) {
  const fake = makeTransport(spec)
  const client = new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport: fake.transport,
    ...extra,
  })
  return { client, fake }
}

/** Successful chatStream, with the SSE body already fully read. */
async function streamOk(client: QoderUpstreamClient, bodyJson: string) {
  const result = await client.chatStream(bodyJson)
  if (!result.ok) throw new Error(`expected ok chatStream, got ${result.kind}: ${result.message}`)
  const text = await result.response.text()
  return { result, frames: framesOf(text) }
}

type ParsedFrame =
  | { kind: 'chunk'; payload: Record<string, unknown> }
  | { kind: 'error'; payload: Record<string, unknown> }
  | { kind: 'done' }

function framesOf(text: string): ParsedFrame[] {
  return text
    .split('\n\n')
    .filter(block => block.startsWith('data: '))
    .map(block => {
      const raw = block.slice('data: '.length)
      if (raw === '[DONE]') return { kind: 'done' as const }
      const payload = JSON.parse(raw) as Record<string, unknown>
      return 'object' in payload ? { kind: 'chunk' as const, payload } : { kind: 'error' as const, payload }
    })
}

const USER_BODY = JSON.stringify({ model: 'ultimate', messages: [{ role: 'user', content: 'hi' }] })

function deltas(frames: ParsedFrame[]): unknown[] {
  return frames
    .filter((frame): frame is { kind: 'chunk'; payload: Record<string, unknown> } => frame.kind === 'chunk')
    .map(frame => (frame.payload['choices'] as { index: number; delta: unknown }[])?.[0]?.delta)
}

// ---------------------------------------------------------------------------
// Request translation: OpenAI body -> GenerateOptions
// ---------------------------------------------------------------------------

describe('chatStream request translation', () => {
  it('translates the narrow OpenAI surface pi-ai sends', async () => {
    const { client, fake } = makeClient({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await streamOk(client, JSON.stringify({
      model: 'qoder/ultimate',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'developer', content: 'b' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc-1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'tc-1', content: [{ type: 'text', text: 'ok' }] },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object' } } }],
      temperature: 0.5,
      max_tokens: 1234.7,
      stop: ['X'],
      reasoning_effort: ' high ',
    }))
    expect(fake.streamCalls).toHaveLength(1)
    const options = fake.streamCalls[0]!.options
    expect(options.provider).toBe('qoder')
    expect(options.model).toBe('qoder/ultimate')
    expect(options.system).toBe('a\nb')
    expect(options.temperature).toBe(0.5)
    expect(options.maxTokens).toBe(1234)
    expect(options.stop).toEqual(['X'])
    expect(options.reasoningEffort).toBe('high')
    expect(options.tools).toEqual([{ name: 'lookup', description: 'd', parameters: { type: 'object' } }])
    expect(options.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    const assistant = options.messages[1]!
    expect(assistant.content.some(block => block.type === 'tool-call' && block.id === 'tc-1')).toBe(true)
    const toolResult = options.messages[2]!
    expect(toolResult.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'tc-1', isError: false })
    expect((toolResult.content[0] as { content: unknown }).content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('accepts a string stop and filters non-string entries from arrays', async () => {
    const { client, fake } = makeClient({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await streamOk(client, JSON.stringify({ model: 'ultimate', messages: [{ role: 'user', content: 'hi' }], stop: 'END' }))
    expect(fake.streamCalls[0]!.options.stop).toEqual(['END'])
    await streamOk(client, JSON.stringify({ model: 'ultimate', messages: [{ role: 'user', content: 'hi' }], stop: ['a', 7, 'b'] }))
    expect(fake.streamCalls[1]!.options.stop).toEqual(['a', 'b'])
  })

  it('answers a malformed OpenAI request as a 400 client failure', async () => {
    const cases: [string, RegExp][] = [
      ['not json', /request body is not valid JSON/],
      ['[]', /request body must be a JSON object/],
      [JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), /model must be a non-empty string/],
      [JSON.stringify({ model: 'x', messages: [] }), /messages must be a non-empty array/],
      [JSON.stringify({ model: 'x', messages: [{ role: 'god', content: 'hi' }] }), /unsupported message role "god"/],
      [JSON.stringify({ model: 'x', messages: [{ role: 'system', content: 'only' }] }), /no model-facing message/],
      [JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 3 }] }), /tool name must be a non-empty string/],
    ]
    for (const [body, message] of cases) {
      const { client, fake } = makeClient()
      const result = await client.chatStream(body)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.kind).toBe('client')
        expect(result.message).toMatch(message)
      }
      expect(fake.streamCalls).toEqual([])
    }
  })

  it('requires the attachment service for image parts and normalizes durable refs', async () => {
    // Remote URLs are never fetched, and a data: URL only becomes an image
    // block through saveImage — the wire transports refs, not bytes.
    const noStore = makeClient()
    const rejected = await noStore.client.chatStream(JSON.stringify({
      model: 'ultimate',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] }],
    }))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.message).toMatch(/requires the DSH attachment service/)

    const saveImage = vi.fn(async () => ({ id: 'att-1', mediaType: 'image/png' }))
    const { client } = makeClient({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] }, {
      attachments: { saveImage } as never,
    })
    await streamOk(client, JSON.stringify({
      model: 'ultimate',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] }],
    }))
    // 'aGk=' is base64 for "hi": the decoded bytes go to saveImage, and the
    // returned reference is what the message block carries.
    expect(saveImage).toHaveBeenCalledWith({ data: new Uint8Array([0x68, 0x69]), mediaType: 'image/png' })
  })

  it('refuses unsupported image encodings before spending a request', async () => {
    for (const url of ['https://evil/x.png', 'data:image/tiff;base64,aGk=', 'data:image/png;base64,', 'garbage']) {
      const { client } = makeClient({}, { attachments: { saveImage: vi.fn() as never } })
      const result = await client.chatStream(JSON.stringify({
        model: 'ultimate',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
      }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    }
  })
})

// ---------------------------------------------------------------------------
// Credential gate and pre-stream failure classification
// ---------------------------------------------------------------------------

describe('chatStream failure classification before the response exists', () => {
  it('answers a missing credential with 401 without touching the transport', async () => {
    const { client, fake } = makeClient({}, { getPat: async () => { throw new Error('MISSING_CREDENTIAL') } })
    const result = await client.chatStream(USER_BODY)
    expect(result).toEqual({
      ok: false,
      status: KIND_STATUS.missing_credential,
      kind: 'missing_credential',
      message: 'no Qoder Personal Access Token is configured',
    })
    expect(fake.streamCalls).toEqual([])
  })

  it('maps a thrown transport failure onto KIND_STATUS', async () => {
    const table: [unknown, number, string][] = [
      [new QoderLlmError('bad pat', 'AUTH', { status: 403 }), 403, 'auth'],
      [new QoderLlmError('rate limited', 'RATE_LIMIT'), KIND_STATUS.soft_rate, 'soft_rate'],
      [new QoderLlmError('no quota', 'QUOTA'), KIND_STATUS.quota_exceeded, 'quota_exceeded'],
      [new QoderLlmError('bad model', 'INVALID_REQUEST'), KIND_STATUS.client, 'client'],
      [new QoderLlmError('upstream down', 'SERVER'), KIND_STATUS.server, 'server'],
      [new Error('socket hang up'), 502, 'server'],
    ]
    for (const [error, status, kind] of table) {
      const { client } = makeClient({ throwAt: 'stream', error })
      const result = await client.chatStream(USER_BODY)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect([result.status, result.kind]).toEqual([status, kind])
        // A structured failure keeps its machine message; a plain thrown error
        // is stringified whole, "Error: " prefix included — the shim's only
        // unclassified path, deliberately loud rather than pretty.
        const expectedMessage = error instanceof LlmError ? error.failure.message : String(error)
        expect(result.message).toBe(expectedMessage)
      }
    }
  })

  it('classifies a terminal first chunk as an HTTP status, not a streamed error', async () => {
    const failure = { message: 'exhausted', code: 'QUOTA', status: 402 }
    const { client, fake } = makeClient({
      chunks: [{ type: 'finish', reason: { kind: 'error', failure } }],
    })
    const result = await client.chatStream(USER_BODY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect([result.status, result.kind, result.message]).toEqual([402, 'quota_exceeded', 'exhausted'])
    // The iterator is released rather than left dangling.
    expect(fake.closed()).toBe(true)
  })
})

describe('kindFromQoderFailure and classifyUpstreamError', () => {
  it('routes on code first, with the HTTP status having the last word for auth/quota families', () => {
    expect(kindFromQoderFailure({ code: 'MISSING_CREDENTIAL' })).toBe('missing_credential')
    expect(kindFromQoderFailure({ code: 'AUTH' })).toBe('auth')
    expect(kindFromQoderFailure({ code: 'SERVER', status: 401 })).toBe('auth')
    expect(kindFromQoderFailure({ code: 'INVALID_REQUEST', status: 402 })).toBe('quota_exceeded')
    expect(kindFromQoderFailure({ code: 'INVALID_IMAGE', status: 415 })).toBe('client')
    expect(kindFromQoderFailure({ code: 'UNSUPPORTED_REASONING_EFFORT' })).toBe('client')
    expect(kindFromQoderFailure({ code: 'ATTACHMENT' })).toBe('client')
    expect(kindFromQoderFailure({ code: 'TIMEOUT' })).toBe('server')
    expect(kindFromQoderFailure({ code: 'WEIRD_NEW_THING' })).toBe('server')
  })

  it('routes Qoder queue answers to soft_rate even with a 401/403 status', () => {
    // The queue answer keeps the 401/403 status that used to claim the auth
    // arm first: kind 'auth' made the shim answer 401 with type "auth", the
    // harness rendered "API 密钥无效", and nothing retried it (observed
    // 2026-09-26 23:30, after the transport-side heal was already fixed).
    expect(kindFromQoderFailure({ code: 'RATE_LIMIT', status: 403 })).toBe('soft_rate')
    expect(kindFromQoderFailure({ code: 'RATE_LIMIT', status: 401 })).toBe('soft_rate')
    expect(kindFromQoderFailure({ code: 'RATE_LIMIT' })).toBe('soft_rate')
    // A real authorization failure is unchanged.
    expect(kindFromQoderFailure({ code: 'AUTH', status: 403 })).toBe('auth')
  })

  it('reads an HTTP answer status-first, then body markers', () => {
    expect(KIND_STATUS).toEqual({
      missing_credential: 401, auth: 401, soft_rate: 429, quota_exceeded: 402, server: 502, client: 400,
    })
    expect(classifyUpstreamError(429, 'quota exceeded, rate limit')).toBe('soft_rate')
    expect(classifyUpstreamError(402, 'you have hit a rate limit')).toBe('quota_exceeded')
    expect(classifyUpstreamError(200, 'Quota Exceeded')).toBe('quota_exceeded')
    expect(classifyUpstreamError(200, 'too many requests, quota exceeded but rate limit')).toBe('quota_exceeded')
    expect(classifyUpstreamError(200, 'Invalid PAT')).toBe('auth')
    // Gateway-side job-token rejection wording also reads as auth, so the
    // shim surfaces it consistently and the retry policies can route on it.
    expect(classifyUpstreamError(200, 'Invalid job token')).toBe('auth')
    expect(classifyUpstreamError(200, 'token has expired, sign in again')).toBe('auth')
    expect(classifyUpstreamError(200, 'Token Expired')).toBe('auth')
    expect(classifyUpstreamError(200, 'please THROTTLEx your retries')).toBe('soft_rate')
    expect(classifyUpstreamError(500, 'boom')).toBe('server')
    expect(classifyUpstreamError(0, 'socket died')).toBe('server')
    expect(classifyUpstreamError(404, 'no such model')).toBe('client')
  })

  it('reads Qoder queue answers as soft_rate, not auth', () => {
    // The verbatim 2026-09-26 window: a 401/403 whose body announces a
    // saturated queue. Status alone said "auth", which parked a healthy
    // account and blocked the retry that would have cleared it.
    const queueBody = JSON.stringify({
      code: '10605',
      message: JSON.stringify({ isQueued: true, modelKey: 'qfmodel', queueCount: 8887, queueType: 'p3', retryAfterSeconds: 30, serviceAvailable: true, waitTime: 274 }),
    })
    expect(classifyUpstreamError(403, queueBody)).toBe('soft_rate')
    expect(classifyUpstreamError(401, queueBody)).toBe('soft_rate')
    expect(classifyUpstreamError(200, queueBody)).toBe('soft_rate')
    expect(classifyUpstreamError(403, '{"serviceAvailable":false,"retryAfterSeconds":27}')).toBe('soft_rate')
    // Real authorization answers keep their classification.
    expect(classifyUpstreamError(403, '{"message":"invalid job token"}')).toBe('auth')
  })

  it('normalizeCredits strips a trailing unit word but keeps the multiplier verbatim', () => {
    expect(normalizeCredits('x1 credits')).toBe('x1')
    expect(normalizeCredits('  x0.50  ')).toBe('x0.50')
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits(undefined)).toBeUndefined()
    // A bare "credits" without a preceding multiplier and without whitespace
    // is not a rate label; the honest answer is "unchanged", not "".
    expect(normalizeCredits('credits')).toBe('credits')
  })
})

// ---------------------------------------------------------------------------
// OpenAI re-serialization of the chunk vocabulary
// ---------------------------------------------------------------------------

describe('chatStream OpenAI re-serialization', () => {
  it('replays a full multi-chunk sequence frame by frame', async () => {
    // The regression this locks: chunks after the first MUST reach the encoder
    // (a block-start emits no frames, so a loop that never re-pulls the
    // iterator would end the stream at the role frame alone).
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'th' },
      { type: 'reasoning-delta', index: 0, text: 'ink' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hello' },
      { type: 'text-delta', index: 1, text: ' world' },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-a' as never, name: 'lookup', argumentsDelta: '{"q"' },
      { type: 'tool-call-delta', index: 2, id: 'call-a' as never, argumentsDelta: ':"x"}' },
      { type: 'tool-call-delta', index: 3, id: 'call-b' as never, name: 'other', argumentsDelta: '{}' },
      { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 7 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { client } = makeClient({ chunks })
    const { frames } = await streamOk(client, USER_BODY)

    expect(frames[frames.length - 1]?.kind).toBe('done')
    const chunkFrames = frames.filter((frame): frame is { kind: 'chunk'; payload: Record<string, unknown> } => frame.kind === 'chunk')
    // Every data frame belongs to one chat.completion.chunk with one id.
    const identities = new Set(chunkFrames.map(frame => {
      const id = frame.payload['id']
      return `${frame.payload['object']}|${frame.payload['model']}|${typeof id === 'string' && id.startsWith('chatcmpl-')}|${id}`
    }))
    const [identity, ...extra] = [...identities]
    expect(extra).toEqual([])
    expect(identity).toMatch(/^chat\.completion\.chunk\|ultimate\|true\|chatcmpl-[0-9a-f]{24}$/)

    expect(deltas(frames)[0]).toEqual({ role: 'assistant' })
    expect(deltas(frames).slice(1, 3)).toEqual([{ reasoning_content: 'th' }, { reasoning_content: 'ink' }])
    expect(deltas(frames).slice(3, 5)).toEqual([{ content: 'Hello' }, { content: ' world' }])

    const toolCallFrames = chunkFrames
      .map(frame => (frame.payload['choices'] as { delta: { tool_calls?: unknown[] } }[] | undefined)?.[0]?.delta?.tool_calls)
      .filter(entries => Array.isArray(entries))
    expect(toolCallFrames).toHaveLength(3)
    // First frame of a tool block carries id/type/name; continuations carry
    // only arguments, and each block gets its own OpenAI-indexed slot.
    expect(toolCallFrames[0]).toEqual([{
      index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q"' },
    }])
    expect(toolCallFrames[1]).toEqual([{ index: 0, function: { arguments: ':"x"}' } }])
    expect(toolCallFrames[2]).toEqual([{
      index: 1, id: 'call-b', type: 'function', function: { name: 'other', arguments: '{}' },
    }])

    // The usage frame: prompt_tokens sums the disjoint input counters, the
    // cache counters ride back out as `prompt_tokens_details` (the harness
    // reads the cache-hit share from there; dropping it pins cache hit to 0%),
    // and it carries no choice at all.
    const usageFrame = chunkFrames.find(frame => frame.payload['usage'] !== undefined)
    expect(usageFrame?.payload['usage']).toEqual({
      prompt_tokens: 107,
      completion_tokens: 7,
      total_tokens: 114,
      prompt_tokens_details: {
        cached_tokens: 5,
        cache_write_tokens: 2,
      },
    })
    expect((usageFrame?.payload['choices'] as unknown[]).length).toBe(0)

    const finishFrame = chunkFrames[chunkFrames.length - 1]
    expect((finishFrame!.payload['choices'] as { delta: unknown; finish_reason: string }[])[0])
      .toMatchObject({ delta: {}, finish_reason: 'tool_calls' })
  })

  it('prefers an upstream-provided total_tokens and passes reasoning tokens details', async () => {
    const { client } = makeClient({
      chunks: [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 999, reasoningTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const { frames } = await streamOk(client, USER_BODY)
    const usage = frames.filter(frame => frame.kind === 'chunk').find(frame => 'usage' in frame.payload)?.payload?.['usage']
    expect(usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 999,
      completion_tokens_details: {
        reasoning_tokens: 2,
      },
    })
  })

  it('omits prompt_tokens_details when the transport reported no cache counters', async () => {
    // Backward-compat lock: a cold request that never saw cache fields keeps
    // the exact pre-fix frame shape, so strict upstreams are not handed a
    // details object full of zeroes.
    const { client } = makeClient({
      chunks: [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const { frames } = await streamOk(client, USER_BODY)
    const usage = frames.filter(frame => frame.kind === 'chunk').find(frame => 'usage' in frame.payload)?.payload?.['usage']
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })
  })

  it('carries a cache-read hit out as cached_tokens so the host can report it', async () => {
    // Regression for issue #3: the transport read `prompt_tokens_details.cached_tokens`
    // from Qoder but the re-serialized usage frame dropped it, so DSH's
    // cache-hit statistic was pinned at 0% for every warm request.
    const { client } = makeClient({
      chunks: [
        { type: 'usage', usage: { inputTokens: 40, cacheReadTokens: 960, outputTokens: 8 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const { frames } = await streamOk(client, USER_BODY)
    const usage = frames.filter(frame => frame.kind === 'chunk').find(frame => 'usage' in frame.payload)?.payload?.['usage']
    expect(usage).toEqual({
      prompt_tokens: 1000, completion_tokens: 8, total_tokens: 1008,
      prompt_tokens_details: { cached_tokens: 960 },
    })
  })

  it('carries both cache details and reasoning tokens details when both are present', async () => {
    const { client } = makeClient({
      chunks: [
        { type: 'usage', usage: { inputTokens: 40, cacheReadTokens: 960, cacheWriteTokens: 20, outputTokens: 8, reasoningTokens: 5 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const { frames } = await streamOk(client, USER_BODY)
    const usage = frames.filter(frame => frame.kind === 'chunk').find(frame => 'usage' in frame.payload)?.payload?.['usage']
    expect(usage).toEqual({
      prompt_tokens: 1020,
      completion_tokens: 8,
      total_tokens: 1028,
      prompt_tokens_details: {
        cached_tokens: 960,
        cache_write_tokens: 20,
      },
      completion_tokens_details: {
        reasoning_tokens: 5,
      },
    })
  })

  it('maps finish kinds to OpenAI finish reasons', async () => {
    for (const [kind, expected] of [['stop', 'stop'], ['max-tokens', 'length'], ['tool-calls', 'tool_calls']] as const) {
      const { client } = makeClient({
        chunks: [{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind } }],
      })
      const { frames } = await streamOk(client, USER_BODY)
      const last = frames.filter(frame => frame.kind === 'chunk').at(-1)
      expect((last?.payload?.['choices'] as { finish_reason: string }[])[0]?.finish_reason).toBe(expected)
      expect(frames.at(-1)?.kind).toBe('done')
    }
  })

  it('closes a source that ends without a finish chunk with a stop fallback', async () => {
    const { client } = makeClient({ chunks: [{ type: 'text-delta', index: 0, text: 'partial' }] })
    const { frames } = await streamOk(client, USER_BODY)
    expect(deltas(frames)).toEqual([{ role: 'assistant' }, { content: 'partial' }, {}])
    const last = frames.filter(frame => frame.kind === 'chunk').at(-1)
    expect((last?.payload?.['choices'] as { finish_reason: string }[])[0]?.finish_reason).toBe('stop')
    expect(frames.at(-1)?.kind).toBe('done')
  })

  it('streams an error frame and [DONE] when the iterator throws mid-flight', async () => {
    const { client } = makeClient({
      chunks: [{ type: 'text-delta', index: 0, text: 'first words' }],
      throwAt: 'next',
      throwAfter: 1,
      error: new QoderLlmError('connection reset', 'SERVER'),
    })
    const { frames } = await streamOk(client, USER_BODY)
    expect(deltas(frames).slice(0, 2)).toEqual([{ role: 'assistant' }, { content: 'first words' }])
    const errorFrame = frames.find(frame => frame.kind === 'error')
    expect(errorFrame?.payload).toEqual({ error: { message: 'connection reset', type: 'server_error', code: 'SERVER' } })
    expect(frames.at(-1)?.kind).toBe('done')
    // Exactly one error frame, then done — nothing after it.
    expect(frames.filter(frame => frame.kind === 'error')).toHaveLength(1)
  })

  it('streams an error frame for an in-band error finish after content', async () => {
    const { client } = makeClient({
      chunks: [
        { type: 'text-delta', index: 0, text: 'half' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'PROVIDER_ERROR', status: 500 } } },
      ],
    })
    const { frames } = await streamOk(client, USER_BODY)
    expect(frames.at(-2)).toMatchObject({ kind: 'error', payload: { error: { message: 'upstream exploded', code: 'PROVIDER_ERROR' } } })
    expect(frames.at(-1)?.kind).toBe('done')
    expect(frames.some(frame => frame.kind === 'chunk' && JSON.stringify(frame.payload).includes('finish_reason": "stop'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Catalog rows and the model that rides the stream call
// ---------------------------------------------------------------------------

describe('fetchModels: QoderCatalogModel -> QoderModelInfo', () => {
  const row: QoderCatalogModel = {
    id: 'ultimate',
    name: 'Qoder Ultimate',
    contextWindow: 200_000,
    maxTokens: 32_000,
    supportsImages: true,
    priceFactor: 1.6,
    source: 'system',
  }

  it('maps billing as an x<n> multiplier, with honest free/unknown states', async () => {
    const { client } = makeClient({ models: [
      row,
      { id: 'lite', name: 'Lite', priceFactor: 0 },
      { id: 'new', name: 'Newcomer' },
    ] })
    const models = await client.fetchModels()
    expect(models[0]).toMatchObject({ billing: { credits: 'x1.6', free: false }, supportsImages: true })
    expect(models[1]).toMatchObject({ billing: { credits: 'x0', free: true }, supportsImages: false })
    expect(models[2]).toMatchObject({ billing: { free: false, rateUnknown: true } })
    // Defaults: no declared capacity falls to the conservative window; no
    // declared output cap falls to the transport's own; an empty name is the id.
    expect(models[2]).toMatchObject({ contextWindow: 180_000, maxTokens: 32_768, name: 'Newcomer' })
    expect(models[0]!.source).toBe('system')
    expect(client.lastCatalog).toMatchObject({ source: 'qoder:discovery' })
  })

  it('translates context_options into windows with the declared default', () => {
    const info = modelInfoOf({
      id: 'c', name: 'C',
      contextOptions: {
        '128k': { tokenCount: 128_000 },
        '256k': { tokenCount: 256_000 },
        '1m': { tokenCount: 1_000_000, isDefault: true },
      },
    })
    expect(info.contextWindow).toBe(1_000_000)
    expect(info.defaultContextWindow).toBe(1_000_000)
    expect(info.supportedContextWindows).toEqual([128_000, 256_000, 1_000_000])
    // An ambiguous default (two flagged) is not a default: the effective
    // window falls to the conservative answer and no default is advertised.
    const twoDefaults = modelInfoOf({
      id: 'c2', name: 'C2',
      contextOptions: { a: { tokenCount: 100, isDefault: true }, b: { tokenCount: 200, isDefault: true } },
    })
    expect(twoDefaults.contextWindow).toBe(180_000)
    expect(twoDefaults.defaultContextWindow).toBeUndefined()
    expect(twoDefaults.supportedContextWindows).toEqual([100, 200])
  })

  it('exposes reasoning only when the row declares it, and never claims off-switch', () => {
    const reasoningRow = modelInfoOf({
      id: 'r', name: 'R', isReasoning: true, supportsEffort: true,
      reasoningEfforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
      defaultReasoningEffort: 'high',
    })
    expect(reasoningRow.reasoning).toEqual({
      supports: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false,
    })
    expect(modelInfoOf({ id: 'p', name: 'P' }).reasoning).toBeUndefined()
    // supportsEffort alone (no isReasoning) still says reasoning is supported.
    expect(modelInfoOf({ id: 'e', name: 'E', supportsEffort: true }).reasoning).toMatchObject({ supports: true })
  })

  it('hands the transport the raw discovered row for a stream, falling back to the external provider', async () => {
    const { client, fake } = makeClient({ models: [row], chunks: [{ type: 'finish', reason: { kind: 'stop' } }] }, {
      catalogProvider: id => id === 'external-model' ? { id: 'external-model', name: 'X' } : undefined,
    })
    await client.fetchModels()
    await streamOk(client, JSON.stringify({ model: 'ultimate', messages: [{ role: 'user', content: 'hi' }] }))
    expect(fake.streamCalls[0]!.model).toBe(row)
    await streamOk(client, JSON.stringify({ model: 'external-model', messages: [{ role: 'user', content: 'hi' }] }))
    expect(fake.streamCalls[1]!.model).toMatchObject({ id: 'external-model' })
    await streamOk(client, JSON.stringify({ model: 'ghost', messages: [{ role: 'user', content: 'hi' }] }))
    expect(fake.streamCalls[2]!.model).toBeUndefined()
    expect(client.catalogModelFor('ultimate')).toBe(row)
  })
})

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

describe('fetchCredits: QoderAccountInfo -> QoderCredits', () => {
  function account(usage: QoderAccountInfo['usage']): QoderAccountInfo {
    return {
      profile: { id: 'u1', name: 'n', email: 'e' },
      ...(usage === undefined ? {} : { usage }),
      updatedAt: 'now',
    }
  }

  it('maps personal and organization packages onto rows, with the aggregate percentage', async () => {
    const { client } = makeClient({
      account: account({
        userQuota: { total: 100, used: 30, remaining: 70, percentage: 30, unit: 'credits' },
        orgResourcePackage: { total: 50, used: 10, remaining: 40, percentage: 20, unit: 'credits' },
        totalUsagePercentage: 42,
        isQuotaExceeded: true,
        expiresAt: '2026-10-01T00:00:00Z',
      }),
    })
    const credits = await client.fetchCredits()
    expect(credits).toEqual({
      total: 42,
      totalSize: 150,
      accounts: [
        { packageName: '个人额度', remain: 70, size: 100, packageEndTime: '2026-10-01T00:00:00Z' },
        { packageName: '组织资源包', remain: 40, size: 50, packageEndTime: '2026-10-01T00:00:00Z' },
      ],
      cycleResetTime: '2026-10-01T00:00:00Z',
    })
  })

  it('falls back to the personal percentage when no aggregate is reported', async () => {
    const { client } = makeClient({
      account: account({ userQuota: { total: 100, used: 60, remaining: 40, percentage: 60, unit: 'credits' } }),
    })
    const credits = await client.fetchCredits()
    expect(credits).toEqual({
      total: 60,
      totalSize: 100,
      accounts: [{ packageName: '个人额度', remain: 40, size: 100 }],
    })
  })

  it('reads total === 0 (not exceeded) as the unlimited account shape', async () => {
    const { client } = makeClient({
      account: account({
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
        isQuotaExceeded: false,
      }),
    })
    await expect(client.fetchCredits()).resolves.toMatchObject({ unlimited: true, total: 0 })
  })

  it('answers zero credits for an account without usage', async () => {
    const { client } = makeClient({ account: account(undefined) })
    await expect(client.fetchCredits()).resolves.toEqual({ total: 0, totalSize: 0, accounts: [] })
  })
})

// ---------------------------------------------------------------------------
// probeEffort
// ---------------------------------------------------------------------------

describe('probeEffort', () => {
  it('answers 401 MISSING_CREDENTIAL without consulting the transport', async () => {
    const { client, fake } = makeClient({}, { getPat: async () => { throw new Error('nope') } })
    const attempt = await client.probeEffort('ultimate', 'high', new AbortController().signal)
    expect(attempt).toEqual({ status: 401, streamed: false, errorCode: 'MISSING_CREDENTIAL', detail: 'no Personal Access Token configured' })
    expect(fake.streamCalls).toEqual([])
  })

  it('reads a locally refused effort as an attributable 400 with a capped detail', async () => {
    const { client } = makeClient({
      throwAt: 'stream',
      error: new QoderLlmError(`model does not advertise effort: ${'x'.repeat(400)}`, 'UNSUPPORTED_REASONING_EFFORT'),
    })
    const attempt = await client.probeEffort('ultimate', 'nope', new AbortController().signal)
    expect(attempt.status).toBe(400)
    expect(attempt.streamed).toBe(false)
    expect(attempt.errorCode).toBe('UNSUPPORTED_REASONING_EFFORT')
    expect(attempt.detail!.length).toBeLessThanOrEqual(300)
  })

  it('counts an accepted value as one streamed request, ended at the first chunk', async () => {
    const { client, fake } = makeClient({ chunks: [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'finish', reason: { kind: 'stop' } }] })
    const attempt = await client.probeEffort('ultimate', 'high', new AbortController().signal)
    expect(attempt).toEqual({ status: 200, streamed: true })
    expect(fake.streamCalls[0]!.options.messages[0]!.content).toEqual([{ type: 'text', text: 'ping' }])
    expect(fake.streamCalls[0]!.options.maxTokens).toBe(1)
    expect(fake.streamCalls[0]!.options.reasoningEffort).toBe('high')
    expect(fake.closed()).toBe(true)
  })

  it('treats an immediately-empty stream as a 502 and non-Llm throws as status 0', async () => {
    const { client } = makeClient({ chunks: [] })
    await expect(client.probeEffort('ultimate', undefined, new AbortController().signal)).resolves.toEqual({ status: 502, streamed: false })
    const throwing = makeClient({ throwAt: 'stream', error: new Error('socket') })
    await expect(throwing.client.probeEffort('ultimate', 'low', new AbortController().signal)).resolves.toEqual({
      status: 0, streamed: false, detail: 'transport error: Error: socket',
    })
  })
})

// ---------------------------------------------------------------------------
// validateApiKey
// ---------------------------------------------------------------------------

describe('validateApiKey', () => {
  it('answers false for a blank token without building a transport', async () => {
    await expect(validateApiKey('   ', 'china')).resolves.toBe(false)
    expect(createTransportMock).not.toHaveBeenCalled()
  })

  it('accepts a token whose discovery call completes', async () => {
    createTransportMock.mockReturnValue({
      stream: () => { throw new Error('not used') },
      discoverModels: async (signal?: AbortSignal) => { void signal; return [] },
      readAccount: async () => { throw new Error('not used') },
    })
    await expect(validateApiKey('pt-good', 'global')).resolves.toBe(true)
    const built = createTransportMock.mock.calls[0]![0] as { region: string; resolvePat: () => Promise<string> }
    expect(built.region).toBe('global')
    expect(await built.resolvePat()).toBe('pt-good')
  })

  it('refuses a token whose discovery call fails — any failure', async () => {
    createTransportMock.mockReturnValue({
      stream: () => { throw new Error('nope') },
      discoverModels: async () => { throw new QoderLlmError('bad pat', 'AUTH', { status: 401 }) },
      readAccount: async () => { throw new Error('nope') },
    })
    await expect(validateApiKey('pt-bad', 'china')).resolves.toBe(false)
  })
})
