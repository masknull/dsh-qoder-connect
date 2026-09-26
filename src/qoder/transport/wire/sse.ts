/** Decode Qoder's outer SSE envelope and inner model chunks. */

import {
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderHttpError } from '../../errors.ts'
import { QoderThinkingParser, type QoderContentSegment } from './thinking.ts'
import type { QoderInnerChunk, QoderSseEnvelope } from './wire-types.ts'

const doneMarker = '[DONE]'
export const defaultMaxSseBufferChars = 2 * 1024 * 1024

export interface QoderSseOptions {
  onActivity?: () => void
  maxBufferChars?: number
}

interface TextualBlockState {
  type: 'text' | 'reasoning'
  index: number
  text: string
}

interface ToolCallState {
  id: string
  name: string
  arguments: string
  emittedArguments: number
  blockIndex?: number
}

type SuccessfulFinishKind = 'stop' | 'tool-calls' | 'max-tokens'

function malformed(message: string): QoderLlmError {
  return new QoderLlmError(message, 'MALFORMED_RESPONSE')
}

function parseEnvelope(rawData: string): QoderSseEnvelope {
  let value: unknown
  try {
    value = JSON.parse(rawData)
  } catch {
    throw malformed('Malformed outer SSE JSON payload received from Qoder.')
  }
  if (value === null || typeof value !== 'object') throw malformed('Malformed outer SSE envelope received from Qoder.')
  const envelope = value as QoderSseEnvelope
  if (envelope.statusCodeValue !== undefined && typeof envelope.statusCodeValue !== 'number') {
    throw malformed('Qoder SSE envelope has an invalid status code.')
  }
  if (envelope.statusCodeValue !== undefined
    && (!Number.isInteger(envelope.statusCodeValue)
      || envelope.statusCodeValue < 100
      || envelope.statusCodeValue > 599)) {
    throw malformed('Qoder SSE envelope has an invalid status code.')
  }
  if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
    const status = envelope.statusCodeValue
    // Forward the envelope body into the reported message. Qoder answers a
    // rejected chat with a 200 SSE whose first envelope carries the failure,
    // and that body is where the real reason lives (quota exhausted, region
    // permission, risk control, ...). Dropping it left every such rejection
    // reading as a bare "invalid API key" with nothing to act on.
    //
    // The body is also handed to the classifier itself: a 401/403 envelope
    // whose body carries the queue markers (code 10605, isQueued,
    // queueCount, retryAfterSeconds) is a throttle, not an authorization
    // failure, and must not send the transport into a job-token exchange.
    throw qoderHttpError(
      envelope.body
        ? `Qoder service returned upstream error status ${status}: ${envelope.body}`
        : `Qoder service returned upstream error status ${status}.`,
      { status },
      envelope.body,
    )
  }
  if (envelope.body !== undefined && typeof envelope.body !== 'string') {
    throw malformed('Qoder SSE envelope has an invalid model body.')
  }
  return envelope
}

function parseInner(body: string): QoderInnerChunk {
  try {
    const value = JSON.parse(body) as unknown
    if (value === null || typeof value !== 'object') throw new Error('not an object')
    return value as QoderInnerChunk
  } catch {
    throw malformed('Malformed inner model payload received from Qoder.')
  }
}

function tokenUsage(innerChunk: QoderInnerChunk): TokenUsage | undefined {
  if (!innerChunk.usage) return undefined
  const usage = innerChunk.usage
  const promptTokens = usage.prompt_tokens ?? 0
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.completion_tokens ?? 0,
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

function finishKind(value: string | null | undefined): SuccessfulFinishKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'toolUse') return 'tool-calls'
  if (value === 'content_filter') {
    throw new QoderLlmError('Qoder blocked the response through its content filter.', 'PROVIDER_ERROR')
  }
  throw malformed(`Qoder returned unknown finish reason "${value}".`)
}

export async function* parseQoderSse(
  stream: ReadableStream<Uint8Array>,
  options: QoderSseOptions = {},
): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const thinkingParser = new QoderThinkingParser()
  const toolCalls = new Map<number, ToolCallState>()
  let buffer = ''
  let sourceEnded = false
  let sawDone = false
  let nextBlockIndex = 0
  let activeTextual: TextualBlockState | undefined
  let pendingUsage: TokenUsage | undefined
  let terminalKind: SuccessfulFinishKind = 'stop'
  let sawContent = false
  const maxBufferChars = options.maxBufferChars ?? defaultMaxSseBufferChars

  const closeTextual = (): StreamChunk[] => {
    if (activeTextual === undefined) return []
    const state = activeTextual
    activeTextual = undefined
    return [{
      type: 'block-end',
      index: state.index,
      block: state.type === 'text'
        ? { type: 'text', text: state.text }
        : { type: 'reasoning', text: state.text },
    }]
  }

  const appendSegment = (segment: QoderContentSegment): StreamChunk[] => {
    if (!segment.text) return []
    const chunks: StreamChunk[] = []
    sawContent = true
    if (activeTextual?.type !== segment.type) {
      chunks.push(...closeTextual())
      activeTextual = { type: segment.type, index: nextBlockIndex++, text: '' }
      chunks.push({ type: 'block-start', index: activeTextual.index, blockType: segment.type })
    }
    activeTextual.text += segment.text
    chunks.push(segment.type === 'text'
      ? { type: 'text-delta', index: activeTextual.index, text: segment.text }
      : { type: 'reasoning-delta', index: activeTextual.index, text: segment.text })
    return chunks
  }

  const openToolCall = (state: ToolCallState): StreamChunk[] => {
    if (!state.id || state.blockIndex !== undefined) return []
    const chunks = closeTextual()
    state.blockIndex = nextBlockIndex++
    sawContent = true
    chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'tool-call' })
    const argumentsDelta = state.arguments.slice(state.emittedArguments)
    state.emittedArguments = state.arguments.length
    chunks.push({
      type: 'tool-call-delta',
      index: state.blockIndex,
      id: ToolCallId(state.id),
      ...state.name ? { name: state.name } : {},
      argumentsDelta,
    })
    return chunks
  }

  try {
    while (!sourceEnded && !sawDone) {
      const { done, value } = await reader.read()
      if (done) {
        sourceEnded = true
        buffer += decoder.decode()
        if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        options.onActivity?.()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > maxBufferChars) {
          throw malformed('Qoder SSE frame exceeded its size limit.')
        }
      }

      while (!sawDone) {
        const lineEnd = buffer.indexOf('\n')
        if (lineEnd === -1) break
        let line = buffer.substring(0, lineEnd)
        buffer = buffer.substring(lineEnd + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        line = line.trim()
        if (!line.startsWith('data:')) continue

        const rawData = line.substring(5).trim()
        if (!rawData) continue
        if (rawData === doneMarker) {
          sawDone = true
          break
        }

        const envelope = parseEnvelope(rawData)
        const body = envelope.body?.trim()
        if (!body) continue
        if (body === doneMarker) {
          sawDone = true
          break
        }
        const innerChunk = parseInner(body)
        pendingUsage = tokenUsage(innerChunk) ?? pendingUsage

        for (const choice of innerChunk.choices ?? []) {
          terminalKind = finishKind(choice.finish_reason) ?? terminalKind
          const delta = choice.delta
          if (!delta) continue

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            for (const segment of thinkingParser.pushReasoning(delta.reasoning_content)) {
              for (const chunk of appendSegment(segment)) yield chunk
            }
          }
          if (typeof delta.content === 'string' && delta.content) {
            for (const segment of thinkingParser.pushContent(delta.content)) {
              for (const chunk of appendSegment(segment)) yield chunk
            }
          }

          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw malformed('Qoder tool-call delta is not an array.')
            for (const rawCall of delta.tool_calls) {
              if (typeof rawCall !== 'object' || rawCall === null || Array.isArray(rawCall)) {
                throw malformed('Qoder tool-call delta is not an object.')
              }
              const upstreamIndex = rawCall.index ?? 0
              if (!Number.isInteger(upstreamIndex) || upstreamIndex < 0) {
                throw malformed('Qoder tool-call delta has an invalid index.')
              }
              let state = toolCalls.get(upstreamIndex)
              if (state === undefined) {
                state = { id: '', name: '', arguments: '', emittedArguments: 0 }
                toolCalls.set(upstreamIndex, state)
              }
              if (rawCall.id !== undefined) {
                if (rawCall.id === '' || rawCall.id === null) {
                  // Upstream models and gateways often emit empty or null IDs in parameter deltas.
                  // Tolerate and ignore when an ID is already established, or wait for later chunks.
                } else if (typeof rawCall.id !== 'string') {
                  throw malformed('Qoder tool call has an invalid id.')
                } else {
                  if (state.id && state.id !== rawCall.id) throw malformed('Qoder changed a streamed tool-call id.')
                  state.id = rawCall.id
                }
              }
              let hasNewName = false
              if (rawCall.function?.name !== undefined) {
                const name = rawCall.function.name
                if (name === '' || name === null) {
                  // Upstream models and gateways often emit empty or null names in parameter deltas.
                  // Tolerate and ignore when a name is already established, or wait for later chunks.
                } else if (typeof name !== 'string') {
                  throw malformed('Qoder tool call has an invalid name.')
                } else {
                  if (state.name && state.name !== name) throw malformed('Qoder changed a streamed tool-call name.')
                  if (state.name !== name) {
                    state.name = name
                    hasNewName = true
                  }
                }
              }
              if (rawCall.function?.arguments !== undefined) {
                if (typeof rawCall.function.arguments !== 'string') {
                  throw malformed('Qoder tool-call arguments delta is not a string.')
                }
                state.arguments += rawCall.function.arguments
              }

              const wasOpen = state.blockIndex !== undefined
              for (const chunk of openToolCall(state)) yield chunk
              if (wasOpen && state.blockIndex !== undefined && state.emittedArguments < state.arguments.length) {
                const argumentsDelta = state.arguments.slice(state.emittedArguments)
                state.emittedArguments = state.arguments.length
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  ...state.name ? { name: state.name } : {},
                  argumentsDelta,
                }
              } else if (wasOpen && state.blockIndex !== undefined && hasNewName) {
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  name: state.name,
                  argumentsDelta: '',
                }
              }
            }
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  if (!sawDone) throw new QoderLlmError('SSE stream ended prematurely without [DONE].', 'TRANSPORT')

  for (const segment of thinkingParser.finish()) {
    for (const chunk of appendSegment(segment)) yield chunk
  }
  for (const chunk of closeTextual()) yield chunk

  for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    if (!state.id || !state.name) throw malformed('Qoder completed an unidentifiable tool call.')
    const normalizedArguments = state.arguments.trim() ? state.arguments : '{}'
    try {
      JSON.parse(normalizedArguments)
    } catch {
      throw malformed(`Qoder completed tool call "${state.name}" with malformed JSON arguments.`)
    }
    for (const chunk of openToolCall(state)) yield chunk
    if (state.blockIndex === undefined) throw malformed('Qoder failed to open a completed tool call.')
    if (state.emittedArguments === 0 && normalizedArguments === '{}') {
      yield {
        type: 'tool-call-delta',
        index: state.blockIndex,
        id: ToolCallId(state.id),
        name: state.name,
        argumentsDelta: '{}',
      }
    }
    yield {
      type: 'block-end',
      index: state.blockIndex,
      block: {
        type: 'tool-call',
        id: ToolCallId(state.id),
        name: state.name,
        arguments: normalizedArguments,
      },
    }
  }

  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  if (!sawContent) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'Model returned a completed response with no content.', code: EMPTY_RESPONSE_CODE },
      },
    }
    return
  }
  yield { type: 'finish', reason: { kind: toolCalls.size > 0 ? 'tool-calls' : terminalKind } }
}
