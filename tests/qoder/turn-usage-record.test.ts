/**
 * End-to-end check that one DSH turn becomes one Qoder usage record.
 *
 * The chain under test is the real one: the adapter's turn resolver → the
 * attribution carried across the shim hop → the upstream client → the transport's
 * `stream()`. Only the transport itself is a fake, so a wrong hand-off anywhere in
 * between shows up here rather than in the upstream's billing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { QoderUpstreamClient } from '../../src/upstream.ts'
import { QoderTurnTracker, type QoderTurnIdentity } from '../../src/qoder/transport/wire/turn-identity.ts'
import {
  QODER_TURN_HEADER,
  qoderSessionHeaders,
  readQoderTurnHeader,
  withQoderRequestPurpose,
} from '../../src/request-session.ts'
import type { QoderCatalogModel } from '../../src/qoder/catalog.ts'

const userBody = JSON.stringify({ model: 'ultimate', messages: [{ role: 'user', content: 'one turn, many steps' }] })

/** A user prompt as the loop stamps it: durable id plus the human source kind. */
function prompt(text: string, id: string): GenerateOptions['messages'][number] {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  return { ...message, id } as GenerateOptions['messages'][number]
}

/** One host-injected context snapshot, stamped by its own producer. */
function injected(text: string, id: string): GenerateOptions['messages'][number] {
  return {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    id,
    source: { kind: 'time-context', form: 'snapshot', sections: [] },
  } as unknown as GenerateOptions['messages'][number]
}

interface Observed {
  options: GenerateOptions
  turn: QoderTurnIdentity | undefined
}

/** The transport seam, recording every dispatched call's identity. */
function observingTransport(): {
  calls: Observed[]
  transport: { stream: (options: GenerateOptions, model?: QoderCatalogModel, turn?: QoderTurnIdentity) => AsyncIterable<StreamChunk> }
} {
  const calls: Observed[] = []
  return {
    calls,
    transport: {
      stream(options: GenerateOptions, _model?: QoderCatalogModel, turn?: QoderTurnIdentity) {
        calls.push({ options, turn })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', index: 0, text: 'ok' } as unknown as StreamChunk
            yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
          },
        }
      },
    },
  }
}

/**
 * Build this call's headers the way the adapter does, inside the call's own
 * attribution scope, and hand them to the shim-facing entry point.
 */
async function dispatch(
  client: QoderUpstreamClient,
  turn: QoderTurnIdentity,
  sessionId = 'session-1',
): Promise<void> {
  let captured: Record<string, string | null> | undefined
  const probe = (async function* probeStream(): AsyncGenerator<never> {
    captured = qoderSessionHeaders(sessionId)
  })()
  // The scope must cover the header build, exactly as it covers dispatch.
  for await (const _chunk of withQoderRequestPurpose(undefined, probe, turn)) { /* drain */ }
  assert.ok(captured !== undefined)

  const result = await client.chatStream(userBody, undefined, sessionId, undefined, readQoderTurnHeader(captured[QODER_TURN_HEADER] ?? undefined))
  assert.equal(result.ok, true)
  await result.response.text()
}

test('three steps of one turn reach the transport as one agent run', async () => {
  const observed = observingTransport()
  const client = new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport: observed.transport as never,
  })
  const tracker = new QoderTurnTracker()
  const first = prompt('one turn, many steps', 'm1')

  // Step 1: the prompt. Steps 2 and 3: the same prompt with host context appended.
  const steps: GenerateOptions['messages'][] = [
    [first],
    [first, injected('Time sampled while preparing turn 1, step 2: ...', 'i1')],
    [first, injected('background job abc finished', 'i2')],
  ]
  for (const messages of steps) {
    await dispatch(client, tracker.resolve('session-1', messages, 'conversation'))
  }

  assert.equal(observed.calls.length, 3)
  const ids = observed.calls.map(call => call.turn?.businessId)
  assert.ok(ids[0] !== undefined)
  assert.equal(ids[0], ids[1])
  assert.equal(ids[0], ids[2])
  assert.deepEqual(observed.calls.map(call => call.turn?.stage), ['start', 'processing', 'processing'])
})

test('a second human prompt reaches the transport as a second run', async () => {
  const observed = observingTransport()
  const client = new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport: observed.transport as never,
  })
  const tracker = new QoderTurnTracker()
  const first = prompt('first', 'm1')
  const second = prompt('second', 'm2')
  await dispatch(client, tracker.resolve('session-1', [first], 'conversation'))
  await dispatch(client, tracker.resolve('session-1', [first, second], 'conversation'))

  const ids = observed.calls.map(call => call.turn?.businessId)
  assert.notEqual(ids[0], ids[1])
})

test('a call with no attribution carries no turn', async () => {
  const observed = observingTransport()
  const client = new QoderUpstreamClient({
    region: 'china',
    providerId: 'qoder',
    getPat: async () => 'pt-test',
    transport: observed.transport as never,
  })
  const result = await client.chatStream(userBody)
  assert.equal(result.ok, true)
  await result.response.text()
  assert.equal(observed.calls[0]?.turn, undefined)
})

test('a malformed turn header is refused rather than trusted', () => {
  assert.equal(readQoderTurnHeader('%7Bnot-json'), undefined)
  assert.equal(readQoderTurnHeader(undefined), undefined)
  assert.equal(readQoderTurnHeader(''), undefined)
  const identity = { requestSetId: 's', businessId: 'b', beginAt: 1, stage: 'processing', businessName: 'n' }
  assert.deepEqual(readQoderTurnHeader(encodeURIComponent(JSON.stringify(identity))), identity)
})
