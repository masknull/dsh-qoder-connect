import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, isQoderAuthRejection, qoderHttpError, qoderQueueSignal, retryAfterMs } from '../../src/qoder/errors.ts'

test('QoderLlmError is a structured DSH LlmError', () => {
  const error = new QoderLlmError('unavailable', 'SERVER', { status: 503 })
  assert.ok(error instanceof LlmError)
  assert.deepEqual(error.failure, { message: 'unavailable', code: 'SERVER', status: 503 })
})

test('qoderHttpError maps HTTP status classes to DSH error codes', () => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ] as const
  for (const [status, code] of cases) {
    const error = qoderHttpError(`HTTP ${status}`, new Response(null, { status }))
    assert.equal(error.code, code)
    assert.equal(error.failure.status, status)
  }
})

test('retryAfterMs accepts delay-seconds and future HTTP dates', () => {
  const now = Date.parse('2026-09-03T00:00:00Z')
  assert.equal(retryAfterMs('3', now), 3000)
  assert.equal(retryAfterMs('Wed, 03 Sep 2026 00:00:05 GMT', now), 5000)
  assert.equal(retryAfterMs('0', now), undefined)
  assert.equal(retryAfterMs('invalid', now), undefined)
  assert.equal(retryAfterMs('Wed, 02 Sep 2026 00:00:00 GMT', now), undefined)
})

test('qoderHttpError preserves an upstream request id', () => {
  const error = qoderHttpError('unavailable', {
    status: 503,
    headers: new Headers({ 'x-request-id': 'request-42' }),
  })
  assert.equal(error.failure.requestId, 'request-42')
})

test('qoderQueueSignal detects the upstream queue answer', () => {
  // Verbatim body observed 2026-09-26 22:33 against qoder/qfmodel.
  const queueBody = JSON.stringify({
    code: '403',
    message: JSON.stringify({
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
    }),
  })
  assert.deepEqual(qoderQueueSignal(queueBody), { retryAfterMs: 30_000 })
  assert.deepEqual(qoderQueueSignal('{"isQueued":true}'), {})
  assert.deepEqual(qoderQueueSignal('{"serviceAvailable":false}'), {})
  assert.equal(qoderQueueSignal('{"code":"403","message":"invalid job token"}'), undefined)
  assert.equal(qoderQueueSignal(''), undefined)
  assert.equal(qoderQueueSignal(undefined), undefined)
})

test('qoderHttpError reads a queued 401/403 as RATE_LIMIT, not AUTH', () => {
  // The misclassification behind the 2026-09-26 incident: a saturated queue
  // answered 403, was coded AUTH, triggered job-token exchanges that cannot
  // jump a queue, and kept the host's rate-limit retry from engaging.
  const queueBody = JSON.stringify({
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
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${queueBody}`,
    { status: 403 },
    queueBody,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.status, 403)
  assert.equal(error.failure.providerRetryAfterMs, 30_000)
  // The message must not carry the raw 401/403 digits: dsh-llm-pi-ai's
  // classifier matches them in text ahead of its rate-limit test, so a queue
  // message quoting "403" still reported a dead credential two layers up
  // ("API 密钥无效", observed 2026-09-26 23:30 and again at 23:40).
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  assert.match(error.message, /throttled/u)
  // The diagnostic facts survive: 10605 and the queue markers stay readable.
  assert.match(error.message, /10605/u)
  assert.match(error.message, /retryAfterSeconds/u)

  // Without an explicit retryAfterSeconds the throttle still classifies as a
  // rate limit; the backoff then follows the host's own policy.
  const noRetryAfter = qoderHttpError('queued', { status: 401 }, '{"isQueued":true}')
  assert.equal(noRetryAfter.code, 'RATE_LIMIT')
  assert.equal(noRetryAfter.failure.providerRetryAfterMs, undefined)
  assert.doesNotMatch(noRetryAfter.message, /\b(?:401|403)\b/u)

  // A queue answer with no retry-after header falls back to the header.
  const headerFallback = qoderHttpError('queued', {
    status: 403,
    headers: new Headers({ 'retry-after': '7' }),
  }, '{"queueCount":42}')
  assert.equal(headerFallback.code, 'RATE_LIMIT')
  assert.equal(headerFallback.failure.providerRetryAfterMs, 7000)

  // A plain 403 with no queue markers stays an authorization failure, and the
  // body-less classification (status + headers only) is unchanged.
  const plain = qoderHttpError('forbidden', { status: 403 }, '{"message":"quota exhausted"}')
  assert.equal(plain.code, 'AUTH')
  const bodyless = qoderHttpError('HTTP 403', new Response(null, { status: 403 }))
  assert.equal(bodyless.code, 'AUTH')
})

test('isQoderAuthRejection refuses a queued 401/403 even though the status matches', () => {
  // The second half of the same defect: qoderHttpError coded the queue answer
  // RATE_LIMIT but it kept status 403, and the status arm of this predicate
  // still saw an authorization rejection — so the heal ran anyway.
  const queued = qoderHttpError('queued', { status: 403 }, '{"code":"10605","retryAfterSeconds":30}')
  assert.equal(queued.code, 'RATE_LIMIT')
  assert.equal(isQoderAuthRejection(queued), false)
  assert.equal(isQoderAuthRejection(qoderHttpError('forbidden', { status: 403 })), true)
  assert.equal(isQoderAuthRejection(qoderHttpError('forbidden', { status: 401 })), true)
  assert.equal(isQoderAuthRejection(new Error('boom')), false)

  // A quota answer is the same shape of non-credential 401/403 (#10): the daily
  // counter keeps the status while saying the token was fine. The heal would
  // spend an exchange on a day-long window it cannot change, and then report a
  // failed refresh for a condition that resets by itself.
  for (const code of ['110', '113', '118']) {
    const body = JSON.stringify({ code, message: 'limit reached' })
    const quota = qoderHttpError(`HTTP 403: ${body}`, { status: 403 }, body)
    assert.equal(quota.code, 'QUOTA')
    assert.equal(isQoderAuthRejection(quota), false, `code ${code} must not trigger a re-auth`)
  }
  const accountQuota = new QoderLlmError('spent', 'ACCOUNT_QUOTA', { status: 403 })
  assert.equal(isQoderAuthRejection(accountQuota), false)
})

test('qoderHttpError reads a documented request code as a request failure, not AUTH', () => {
  // The same 401/403 trap as #10, in the request/policy family: a content refusal
  // or an over-long input answered with 403 was reported as a dead credential.
  // pi-ai has no code for either (its vocabulary stops at INVALID_REQUEST), so the
  // honest floor is a request failure — never a credential one.
  const refusal = JSON.stringify({ code: '406', message: 'Request blocked because of sensitive content' })
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${refusal}`,
    { status: 403 },
    refusal,
  )
  assert.equal(error.code, 'INVALID_REQUEST')
  // The upstream's real status survives for diagnostics.
  assert.equal(error.failure.status, 403)
  // Without this the digits re-arm pi-ai's first test and the user reads a dead
  // credential again (the S3 lesson from the design).
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  assert.match(error.message, /406/u)
  assert.match(error.message, /sensitive content/u)

  for (const code of ['416', '430', '80411', '80412']) {
    const body = JSON.stringify({ code, message: 'rejected' })
    assert.equal(
      qoderHttpError(`HTTP 403: ${body}`, { status: 403 }, body).code,
      'INVALID_REQUEST',
      `code ${code} must not be read as an authorization failure`,
    )
  }

  // A 401/403 that names no documented code still routes by status, and 105 —
  // the auth family — must stay an authorization failure.
  assert.equal(qoderHttpError('forbidden', { status: 403 }, '{"message":"blocked"}').code, 'AUTH')
  const expired = JSON.stringify({ code: '105', message: 'Login or access token expired' })
  assert.equal(qoderHttpError(`HTTP 401: ${expired}`, { status: 401 }, expired).code, 'AUTH')
})

test('qoderHttpError reads a documented quota code as QUOTA, not AUTH', () => {
  // dsh-qoder-connect#10: the upstream answers an exhausted daily billing
  // counter with HTTP 403 {"code":"110","message":"Billing daily count
  // exceeded"}. Coded AUTH it told the user the PAT was revoked, ran a
  // job-token exchange no fresh token can fix, and suppressed the rate-limit
  // retry — while the counter simply resets the next day.
  const body = JSON.stringify({ code: '110', message: 'Billing daily count exceeded' })
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${body}`,
    { status: 403 },
    body,
  )
  assert.equal(error.code, 'QUOTA')
  // The upstream's real status survives for diagnostics, exactly as it does for
  // the queue answer.
  assert.equal(error.failure.status, 403)
  // No retry hint: a daily counter is not a "try again in N seconds" window, and
  // the host never retries QUOTA anyway.
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  // The message must not carry the 401/403 digits dsh-llm-pi-ai matches ahead of
  // its quota test, or the user still reads "API 密钥无效" (observed 2026-10-08 by
  // injecting this body through the transport).
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  // The cause stays readable: the documented code and the upstream's own words.
  assert.match(error.message, /110/u)
  assert.match(error.message, /Billing daily count exceeded/u)

  // The whole documented quota family routes the same way, not just 110.
  for (const code of ['113', '114', '115', '116', '117', '118', '119', '122']) {
    const familyBody = JSON.stringify({ code, message: 'limit reached' })
    assert.equal(
      qoderHttpError(`HTTP 403: ${familyBody}`, { status: 403 }, familyBody).code,
      'QUOTA',
      `code ${code} must route to QUOTA`,
    )
  }

  // A 403 whose mirrored `code` field is the status, and whose prose mentions a
  // quota, is NOT a documented code: it stays an authorization failure, so a
  // throttling answer that happens to say "quota exhausted" is never parked as an
  // exhausted balance.
  const prose = qoderHttpError('forbidden', { status: 403 }, '{"code":403,"message":"quota exhausted"}')
  assert.equal(prose.code, 'AUTH')
})
