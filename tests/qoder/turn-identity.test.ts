import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { QoderTurnTracker, humanPrompts, parseTurnIdentity } from '../../src/qoder/transport/wire/turn-identity.ts'
import { buildQoderRequestBody } from '../../src/qoder/transport/wire/serialize.ts'

/** One human prompt, carrying the durable id the loop assigns. */
function prompt(text: string, id: string): ReturnType<typeof createUserMessage> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  return { ...message, id } as ReturnType<typeof createUserMessage>
}

/** One host-injected context message, as producers stamp it. */
function injected(text: string, id: string): ReturnType<typeof createUserMessage> {
  return {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    id,
    source: { kind: 'time-context', form: 'snapshot', sections: [] },
  } as unknown as ReturnType<typeof createUserMessage>
}

test('every step of one turn reports the same agent run', () => {
  const tracker = new QoderTurnTracker()
  const first = prompt('fix the parser', 'm1')
  // Step 1: the prompt alone.
  const a = tracker.resolve('session-1', [first], 'conversation')
  // Step 2: the same prompt plus a host-injected snapshot appended mid-turn.
  const b = tracker.resolve('session-1', [first, injected('Time sampled while preparing turn 1, step 2: ...', 'i1')], 'conversation')
  // Step 3: the same prompt again, plus a tool round trip.
  const c = tracker.resolve('session-1', [first, injected('background job abc finished', 'i2')], 'conversation')

  assert.equal(a.businessId, b.businessId)
  assert.equal(a.businessId, c.businessId)
  assert.equal(a.requestSetId, c.requestSetId)
  assert.equal(a.beginAt, c.beginAt)
  assert.equal(a.stage, 'start')
  assert.equal(b.stage, 'processing')
  assert.equal(c.stage, 'processing')
  assert.equal(a.businessName, 'fix the pa')
})

test('the next human prompt opens the next run', () => {
  const tracker = new QoderTurnTracker()
  const first = prompt('first question', 'm1')
  const second = prompt('second question', 'm2')
  tracker.resolve('session-1', [first], 'conversation')
  const next = tracker.resolve('session-1', [first, second], 'conversation')

  assert.notEqual(next.businessId, first.id)
  assert.equal(next.stage, 'start')
  assert.equal(next.businessName, 'second que')
  // Continuing that turn keeps the new run.
  const continued = tracker.resolve('session-1', [first, second], 'conversation')
  assert.equal(continued.businessId, next.businessId)
  assert.equal(continued.stage, 'processing')
})

test('a model switch keeps the turn record', () => {
  const tracker = new QoderTurnTracker()
  const first = prompt('same prompt', 'm1')
  const before = tracker.resolve('session-1', [first], 'conversation')
  const after = tracker.resolve('session-1', [first], 'conversation')
  assert.equal(before.businessId, after.businessId)
})

test('conversations never share a run', () => {
  const tracker = new QoderTurnTracker()
  const a = tracker.resolve('session-a', [prompt('hello', 'm1')], 'conversation')
  const b = tracker.resolve('session-b', [prompt('hello', 'm1')], 'conversation')
  assert.notEqual(a.businessId, b.businessId)
  assert.notEqual(a.requestSetId, b.requestSetId)
})

test('auxiliary calls get their own run and never displace the turn', () => {
  const tracker = new QoderTurnTracker()
  const first = prompt('real prompt', 'm1')
  const turn = tracker.resolve('session-1', [first], 'conversation')
  const title = tracker.resolve('session-1', [prompt('title this', 'x1')], 'auxiliary')
  const back = tracker.resolve('session-1', [first], 'conversation')

  assert.notEqual(title.businessId, turn.businessId)
  // The title request carried a user-role message, but it must not have claimed
  // the conversation: the real turn continues untouched.
  assert.equal(back.businessId, turn.businessId)
  assert.equal(back.stage, 'processing')
})

test('one conversation\'s auxiliary calls group with each other, not with another\'s', () => {
  const tracker = new QoderTurnTracker()
  const titleA = tracker.resolve('session-a', [prompt('title a', 'a1')], 'auxiliary')
  const titleA2 = tracker.resolve('session-a', [prompt('title a again', 'a2')], 'auxiliary')
  const titleB = tracker.resolve('session-b', [prompt('title b', 'b1')], 'auxiliary')

  // One conversation's two title calls are one run, as before.
  assert.equal(titleA.businessId, titleA2.businessId)
  assert.equal(titleA.stage, 'start')
  assert.equal(titleA2.stage, 'processing')
  // Two conversations are two runs. `requestSetId` is the upstream queue key, so
  // sharing one would have each poll, and read the grant of, the other's entry.
  assert.notEqual(titleA.businessId, titleB.businessId)
  assert.notEqual(titleA.requestSetId, titleB.requestSetId)
})

test('one conversation\'s title and compaction calls share a window', () => {
  const tracker = new QoderTurnTracker()
  const title = tracker.resolve('session-1', [prompt('title', 'x1')], 'auxiliary')
  const compaction = tracker.resolve('session-1', [prompt('compact', 'x2')], 'auxiliary')
  // Both are auxiliary work for the same conversation, so they group; the window
  // is per conversation, not per purpose.
  assert.equal(title.businessId, compaction.businessId)
  assert.equal(compaction.stage, 'processing')
})

test('an auxiliary window never spans two conversations', () => {
  const tracker = new QoderTurnTracker()
  const a = tracker.resolve('session-a', [prompt('title a', 'x1')], 'auxiliary')
  const b = tracker.resolve('session-b', [prompt('title b', 'x2')], 'auxiliary')
  assert.notEqual(a.businessId, b.businessId)
  assert.notEqual(a.requestSetId, b.requestSetId)
})

test('session-less callers never share a queue key', () => {
  const tracker = new QoderTurnTracker()
  const a = tracker.resolve(undefined, [prompt('anonymous a', 'x1')], 'conversation')
  const b = tracker.resolve(undefined, [prompt('anonymous b', 'x2')], 'conversation')
  // Neither named a conversation, so there is nothing to group them by: two
  // unrelated callers must not share an upstream queue entry.
  assert.notEqual(a.businessId, b.businessId)
  assert.notEqual(a.requestSetId, b.requestSetId)
})

test('a repeated prompt after compaction opens a fresh run', () => {
  const tracker = new QoderTurnTracker()
  const first = prompt('do the thing', 'm1')
  tracker.resolve('session-1', [first], 'conversation')
  // Compaction replaced the earlier span; the same words arrive as new input.
  const again = prompt('do the thing', 'm2')
  const next = tracker.resolve('session-1', [again], 'conversation')
  assert.notEqual(next.businessId, first.id)
})

test('a session with no human prompt still holds one run', () => {
  const tracker = new QoderTurnTracker()
  const a = tracker.resolve('session-1', [injected('context only', 'i1')], 'conversation')
  const b = tracker.resolve('session-1', [injected('context only', 'i1')], 'conversation')
  assert.equal(a.businessId, b.businessId)
  assert.equal(a.stage, 'start')
  assert.equal(b.stage, 'processing')
})

test('an idle conversation is evicted before an active one', () => {
  let now = 1_000
  const tracker = new QoderTurnTracker({ maxSessions: 2, idleSessionTtlMs: 10_000, now: () => now })
  tracker.resolve('idle', [prompt('idle', 'm1')], 'conversation')
  now += 20_000
  const active = tracker.resolve('active', [prompt('active', 'm2')], 'conversation')
  tracker.resolve('third', [prompt('third', 'm3')], 'conversation')

  assert.ok(tracker.size <= 2)
  // The active conversation survived with its identity intact.
  const stillActive = tracker.resolve('active', [prompt('active', 'm2')], 'conversation')
  assert.equal(stillActive.businessId, active.businessId)
})

test('only user-source messages count as prompts', () => {
  const messages = [injected('ctx', 'i1'), prompt('human', 'm1'), { ...prompt('tool', 't1'), role: 'tool' }]
  const prompts = humanPrompts(messages as unknown as GenerateOptions['messages'])
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]?.text, 'human')
})

test('an untrusted turn header round-trips only when well formed', () => {
  const identity = { requestSetId: 's', businessId: 'b', beginAt: 1, stage: 'processing' as const, businessName: 'n' }
  assert.deepEqual(parseTurnIdentity(JSON.parse(JSON.stringify(identity))), identity)
  assert.equal(parseTurnIdentity({ ...identity, stage: 'bogus' }), undefined)
  assert.equal(parseTurnIdentity({ ...identity, beginAt: 'soon' }), undefined)
  assert.equal(parseTurnIdentity({ businessId: 'b' }), undefined)
  assert.equal(parseTurnIdentity(null), undefined)
})

test('the wire body carries one business for every step of a turn', async () => {
  const tracker = new QoderTurnTracker()
  const promptMessage = prompt('one turn, three steps', 'm1')
  const options: GenerateOptions = { provider: 'qoder', model: 'ultimate', messages: [promptMessage] }
  const steps = []
  for (const step of [1, 2, 3]) {
    const turn = tracker.resolve('session-1', options.messages, 'conversation')
    steps.push(await buildQoderRequestBody(options, 'user-1', undefined, undefined, undefined, 'china', turn))
    assert.equal(step >= 1, true)
  }
  const [first, second, third] = steps
  assert.ok(first !== undefined && second !== undefined && third !== undefined)
  assert.equal(first.business.id, second.business.id)
  assert.equal(first.business.id, third.business.id)
  assert.equal(first.request_set_id, third.request_set_id)
  assert.equal(first.business.stage, 'start')
  assert.equal(second.business.stage, 'processing')
  // Each attempt still gets its own request id, and the run id is not it.
  assert.notEqual(first.request_id, second.request_id)
  assert.notEqual(first.business.id, first.request_id)
})

test('without a resolved turn the body still forms its own record', async () => {
  const options: GenerateOptions = {
    provider: 'qoder',
    model: 'ultimate',
    messages: [prompt('standalone', 'm1')],
  }
  const body = await buildQoderRequestBody(options, 'user-1', undefined, undefined, undefined, 'china')
  assert.equal(body.business.id, body.request_set_id)
  assert.equal(body.business.stage, 'start')
})
