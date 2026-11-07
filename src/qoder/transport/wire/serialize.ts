/** Build the minimum qodercli request envelope for a validated DSH request. */

import crypto from 'node:crypto'
import { contentHasImage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderLlmError } from '../../errors.ts'
import { translateTools, validateAndTranslateMessages, validateMessageShapes } from './translate.ts'
import type { QoderWireMessage, QoderWireRequest, QoderWireTool } from './wire-types.ts'
import type { QoderCatalogModel } from '../../catalog.ts'
import type { QoderImageAttachments, QoderImageResolver } from './translate.ts'
import type { CosyCredentials } from './cosy.ts'
import { qoderIdeVersion } from './cosy.ts'
import type { QoderTurnIdentity } from './turn-identity.ts'

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash('sha256')
  hash.update(prefix)
  for (const input of inputs) {
    hash.update('\0')
    hash.update(input)
  }
  return hash.digest('hex').slice(0, 16)
}

function stableChatRecordId(
  model: string,
  messages: readonly QoderWireMessage[],
  tools: readonly QoderWireTool[],
  maxTokens: number | undefined,
): string {
  const hash = crypto.createHash('sha256')
  hash.update('qoder-record')
  hash.update('\0')
  hash.update(model)
  hash.update('\0')
  hash.update(JSON.stringify(messages))
  hash.update('\0')
  hash.update(JSON.stringify(tools))
  hash.update('\0')
  hash.update(`mt=${maxTokens ?? 'none'}`)
  return hash.digest('hex').slice(0, 16)
}

/**
 * Reject an unusable request before any credential resolution or provider I/O,
 * so a request the provider cannot serve never reaches the network.
 */
export function validateQoderRequestShape(
  options: GenerateOptions,
  model?: QoderCatalogModel,
): void {
  if (options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort)
    // Only a declared level set may justify a local refusal: an undeclared row is
    // not evidence the model supports none, so it goes upstream for the answer.
    const declared = model?.reasoningEfforts
    if (declared !== undefined && declared.length > 0 && !declared.some(candidate => candidate.id === effort)) {
      throw new QoderLlmError(
        `Qoder model "${options.model}" does not advertise reasoning effort "${effort}".`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
  }
  if (options.messages.some(message => contentHasImage(message.content)) && model?.supportsImages !== true) {
    throw new QoderLlmError(
      `Qoder model "${options.model}" does not advertise image input.`,
      'UNSUPPORTED_CONTENT',
    )
  }
  validateMessageShapes(options.messages)
}

/** Translate a request whose shape has already been validated. */
export function translateQoderMessages(
  options: GenerateOptions,
  attachments?: QoderImageAttachments,
  pipeline?: {
    uploader?: QoderImageResolver | undefined
    credentials?: CosyCredentials | undefined
    preserveThinking?: boolean | undefined
  },
): Promise<QoderWireMessage[]> {
  return validateAndTranslateMessages(
    options.messages,
    options.system,
    attachments,
    options.signal,
    pipeline,
  )
}

export async function validateQoderRequest(
  options: GenerateOptions,
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
): Promise<QoderWireMessage[]> {
  validateQoderRequestShape(options, model)
  return validateAndTranslateMessages(options.messages, options.system, attachments, options.signal)
}

export async function buildQoderRequestBody(
  options: GenerateOptions,
  userId: string,
  translatedMessages?: QoderWireMessage[],
  model?: QoderCatalogModel,
  attachments?: QoderImageAttachments,
  region?: string,
  turn?: QoderTurnIdentity,
): Promise<QoderWireRequest> {
  if (!userId) {
    throw new QoderLlmError('Qoder request identity is missing.', 'AUTH')
  }
  const modelKey = options.model || 'cmodel'
  const messages = translatedMessages ?? await validateQoderRequest(options, model, attachments)
  // Only a declared cap or an explicit caller request becomes a wire limit.
  const declaredMaxTokens = model?.maxTokensDeclared === true ? model.maxTokens : undefined
  const maxTokens = declaredMaxTokens === undefined
    ? options.maxTokens
    : Math.min(options.maxTokens ?? declaredMaxTokens, declaredMaxTokens)
  const isReasoning = options.reasoningEffort !== undefined || (model?.isReasoning ?? false)
  const tools = translateTools(options.tools)
  // Ambiguous defaults stay in discovery metadata, but must not select a request tier.
  const defaultContexts = Object.values(model?.contextOptions ?? {}).filter(option =>
    option.isDefault === true && typeof option.tokenCount === 'number'
    && Number.isFinite(option.tokenCount) && option.tokenCount > 0)
  const contextConfig = model?.contextOptions === undefined || defaultContexts.length !== 1
    ? undefined
    : Object.fromEntries(Object.entries(model.contextOptions).map(([key, value]) => [key, {
      ...value.tokenCount === undefined ? {} : { token_count: value.tokenCount },
      ...value.isDefault === undefined ? {} : { is_default: value.isDefault },
    }]))
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    // index is bounded by messages.length; guard only satisfies noUncheckedIndexedAccess.
    if (message === undefined) continue
    if (message.role === 'user') {
      const content = message.content
      lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(part => part.type === 'text').map(part => part.text).join('')
          : ''
      break
    }
  }

  const stablePart = stableHash('qoder-session', userId, modelKey)
  const sessionId = options.sessionId === undefined
    ? `${stablePart}-${crypto.randomUUID()}`
    : `${stablePart}-${String(options.sessionId)}`
  // One id per attempt. The queue entry and the agent run are keyed by
  // request_set_id, which must survive a replay and cover every step of one turn,
  // so the caller supplies it from the turn it resolved.
  const requestId = crypto.randomUUID()
  const requestSetId = crypto.randomUUID()
  const identity: QoderTurnIdentity = turn ?? {
    // A hand-built caller with no turn: one call is one record, and the queue
    // entry stays tied to the run the way the upstream expects.
    requestSetId,
    businessId: requestSetId,
    beginAt: Date.now(),
    stage: 'start',
    businessName: lastUserText.substring(0, 30),
  }

  return {
    request_id: requestId,
    request_set_id: identity.requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: region === 'china' ? 'qoderclicn' : 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    system: '',
    messages,
    tools,
    parameters: {
      ...maxTokens === undefined ? {} : { max_tokens: maxTokens },
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: String(options.reasoningEffort) },
    },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: {
      key: modelKey,
      is_reasoning: isReasoning,
      ...maxTokens === undefined ? {} : { max_output_tokens: maxTokens },
      source: model?.source || 'system',
      ...contextConfig === undefined ? {} : { context_config: contextConfig },
    },
    business: {
      product: 'cli',
      // The official client stamps its own app version here; it tracks
      // qoderIdeVersion, not a frozen string.
      version: qoderIdeVersion,
      type: 'agent',
      // `start` opens the run, `processing` continues it. The Credits panel
      // aggregates on `id`, so every step of one turn reports the same one.
      stage: identity.stage,
      id: identity.businessId,
      name: identity.businessName,
      // The upstream's credits panel reads the billed model tier from this key,
      // not from model_config.key; without it the run falls into the Auto pool.
      model_key: modelKey,
      begin_at: identity.beginAt,
    },
  }
}
