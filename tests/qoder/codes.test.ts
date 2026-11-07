import test from 'node:test'
import assert from 'node:assert/strict'
import { QODER_RESULT_CODES, qoderResultCode } from '../../src/qoder/codes.ts'

test('QODER_RESULT_CODES carries the documented Qoder result-code table', () => {
  // The official table (docs.qoder.com/cli/sdk/errors), split by the family that
  // decides routing: a quota answer must never read as a dead credential.
  const byFamily = (family: string): string[] => QODER_RESULT_CODES
    .filter(entry => entry.family === family)
    .map(entry => entry.code)

  assert.deepEqual(byFamily('auth'), ['105'])
  assert.deepEqual(byFamily('quota'), ['110', '112', '113', '114', '115', '116', '117', '118', '119', '122'])
  assert.deepEqual(byFamily('request'), ['406', '416', '430', '47902', '48716', '80411', '80412'])
  assert.deepEqual(byFamily('runtime'), ['500', '10408', '10500', '10605'])
  assert.equal(QODER_RESULT_CODES.length, 22)
  for (const entry of QODER_RESULT_CODES) {
    assert.match(entry.code, /^\d+$/u)
    assert.ok(entry.name.trim().length > 0, `code ${entry.code} needs a name`)
  }
})

test('qoderResultCode reads the documented code out of any nesting depth', () => {
  // An exhausted daily billing counter: HTTP 403 whose body names code 110.
  assert.deepEqual(
    qoderResultCode('{"code":"110","message":"Billing daily count exceeded"}'),
    { code: '110', name: 'Daily usage limit reached', family: 'quota' },
  )

  // Qoder double-encodes: the outer code's message field carries escaped JSON,
  // and detection must survive the escaping, exactly like qoderQueueSignal.
  const nested = JSON.stringify({
    code: '10605',
    message: JSON.stringify({ isQueued: true, modelKey: 'qfmodel', retryAfterSeconds: 30 }),
  })
  assert.equal(qoderResultCode(nested)?.family, 'runtime')

  // An unquoted numeric code (the shape the SSE fixtures use) reads too.
  assert.equal(qoderResultCode('{"code":500,"message":"boom"}')?.code, '500')
})

test('qoderResultCode never guesses an undocumented code', () => {
  // 403/429 are HTTP statuses mirrored into `code`; neither is documented, so the
  // reader stays silent and leaves the caller's status routing intact.
  assert.equal(qoderResultCode('{"code":403,"message":"quota exhausted"}'), undefined)
  assert.equal(qoderResultCode('{"code":"429","message":"rate limit"}'), undefined)
  assert.equal(qoderResultCode('{"message":"quota exhausted"}'), undefined)
  assert.equal(qoderResultCode('{"statusCodeValue":403}'), undefined)
  assert.equal(qoderResultCode(''), undefined)
  assert.equal(qoderResultCode(undefined), undefined)
})
