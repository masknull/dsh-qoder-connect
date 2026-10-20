import test from 'node:test'
import assert from 'node:assert/strict'
import { QoderAuthService } from '../../src/qoder/transport/auth.ts'
import { QoderLlmError } from '../../src/qoder/errors.ts'
import { QoderUsageReader } from '../../src/qoder/transport/account-reader.ts'

test('QoderUsageReader reads subscriber profile and quota usage, and caches within TTL', async () => {
  let quotaCalls = 0
  const diagnostics: string[] = []
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-quota-test', expires_in: 3_600_000 }), { status: 200 })
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-123', email: 'dev@qoder.sh', name: 'Qoder Dev' }))
    }
    if (url.includes('/quota/usage')) {
      quotaCalls++
      return new Response(
        JSON.stringify({
          userId: 'user-123',
          userType: 'teams',
          totalUsagePercentage: 0.03,
          isQuotaExceeded: false,
          expiresAt: 1790756471159,
          userQuota: {
            total: 3000.0,
            used: 84.0,
            remaining: 2916.0,
            percentage: 0.03,
            unit: 'credits',
          },
          orgResourcePackage: {
            used: 0.0,
            remaining: 3000.0,
            percentage: 0.0,
            unit: 'credits',
            cap: 3000.0,
            available: true,
          },
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({
    authService,
    fetch: fetchMock as typeof fetch,
    ttlMs: 60_000,
    logger: {
      debug: (message, ...details) => diagnostics.push(JSON.stringify([message, ...details])),
    },
  })

  const first = await reader.readAccount('pt-test')
  assert.equal(first.profile.id, 'user-123')
  assert.equal(first.profile.name, 'Qoder Dev')
  assert.equal(first.profile.email, 'dev@qoder.sh')
  assert.equal(first.usage?.userQuota?.total, 3000)
  assert.equal(first.usage?.userQuota?.used, 84)
  assert.equal(first.usage?.userQuota?.remaining, 2916)
  assert.equal(first.usage?.orgResourcePackage?.total, 3000)
  assert.equal(first.usage?.orgResourcePackage?.used, 0)
  assert.equal(first.usage?.orgResourcePackage?.remaining, 3000)
  assert.equal(quotaCalls, 1)
  assert.match(diagnostics.join('\n'), /account\.usage/)


  // Cache hit
  const second = await reader.readAccount('pt-test')
  assert.equal(second, first)
  assert.equal(quotaCalls, 1)

  // Force refresh
  const third = await reader.readAccount('pt-test', { force: true })
  assert.equal(quotaCalls, 2)
  assert.equal(third.profile.name, 'Qoder Dev')
})

test('QoderUsageReader surfaces quota failures and does not cache them', async () => {
  let quotaCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-quota-test', expires_in: 3_600_000 }), { status: 200 })
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-456', email: 'error@qoder.sh', name: 'Error Case' }))
    }
    if (url.includes('/quota/usage')) {
      quotaCalls++
      return new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 })
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({
    authService,
    fetch: fetchMock as typeof fetch,
  })

  await assert.rejects(reader.readAccount('pt-error-test'), (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'SERVER')
    assert.equal((error as QoderLlmError).failure.status, 500)
    return true
  })
  await assert.rejects(reader.readAccount('pt-error-test'))
  assert.equal(quotaCalls, 4)
})

test('QoderUsageReader propagates caller cancellation and does not cache the partial account', async () => {
  let quotaCalls = 0
  let quotaCanSucceed = false
  let notifyUsageStarted: (() => void) | undefined
  const usageStarted = new Promise<void>(resolve => { notifyUsageStarted = resolve })
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-abort-test', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-abort', name: 'Abort Case' }))
    }
    if (url.includes('/quota/usage')) {
      quotaCalls++
      if (quotaCanSucceed) {
        return new Response(JSON.stringify({ userQuota: { total: 10, used: 1, remaining: 9, unit: 'credits' } }))
      }
      notifyUsageStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })
  const controller = new AbortController()
  const request = reader.readAccount('pt-abort-test', { signal: controller.signal })
  await usageStarted
  controller.abort()

  await assert.rejects(request, (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'ABORTED')
    return true
  })

  quotaCanSucceed = true
  const retry = await reader.readAccount('pt-abort-test')
  assert.equal(retry.usage?.userQuota?.remaining, 9)
  assert.equal(quotaCalls, 2)
})

test('QoderUsageReader bounds a stalled quota request with its own timeout', async () => {
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-timeout-test', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-timeout', name: 'Timeout Case' }))
    }
    if (url.includes('/quota/usage')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true })
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({
    authService,
    fetch: fetchMock as typeof fetch,
    timeoutMs: 5,
  })

  await assert.rejects(reader.readAccount('pt-timeout-test'), (error: Error) => {
    assert.ok(error instanceof QoderLlmError)
    assert.equal((error as QoderLlmError).code, 'TIMEOUT')
    return true
  })
})

test('QoderUsageReader shares a concurrent quota cache miss', async () => {
  let quotaCalls = 0
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-shared' }))
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-shared' }))
    if (url.includes('/quota/usage')) {
      quotaCalls++
      await new Promise(resolve => setTimeout(resolve, 5))
      return new Response(JSON.stringify({ userQuota: { total: 10, used: 1, remaining: 9 } }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-test',
  })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })

  const [first, second] = await Promise.all([
    reader.readAccount('pt-shared'),
    reader.readAccount('pt-shared'),
  ])
  assert.equal(quotaCalls, 1)
  assert.equal(first, second)
})

test('QoderUsageReader reads subscriber plan and user status with machine fingerprint headers', async () => {
  let statusHeaders: Record<string, string> | undefined
  let planHeaders: Record<string, string> | undefined
  let quotaHeaders: Record<string, string> | undefined
  const fetchMock = async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-plan-test', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-plan-1', email: 'pro@qoder.sh', name: 'Pro Dev' }))
    }
    if (url.includes('/quota/usage')) {
      quotaHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify({ userQuota: { total: 100, used: 20, remaining: 80, unit: 'credits' } }))
    }
    if (url.includes('/user/plan')) {
      planHeaders = init?.headers as Record<string, string>
      return new Response(
        JSON.stringify({
          user_type: 'pro',
          plan_tier_name: 'Pro',
          is_personal_version: false,
          is_highest_tier: true,
          start_date: 1700000000000,
          end_date: 1735689600000,
          organization: {
            org_id: 'org-456',
            org_name: 'DeepSeek Harness Team',
            role_name: 'Owner',
            is_suspended: false,
            can_manage_subscriptions: true,
            resource_package_feature_enabled: true,
          },
          feature_allowed: {
            quest: true,
            wiki: true,
            code_review: true,
          },
        }),
      )
    }
    if (url.includes('/user/status')) {
      statusHeaders = init?.headers as Record<string, string>
      return new Response(
        JSON.stringify({
          featureSwitches: { allow_byok: 2 },
          teamSwitches: { allow_byok: 2 },
          isPrivacyPolicyModifiable: true,
        }),
      )
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'umid-fingerprint-test',
  })
  const reader = new QoderUsageReader({
    authService,
    fetch: fetchMock as typeof fetch,
  })

  const account = await reader.readAccount('pt-full-test')
  assert.equal(account.profile.name, 'Pro Dev')
  assert.equal(account.plan?.userType, 'pro')
  assert.equal(account.plan?.planTierName, 'Pro')
  assert.equal(account.plan?.isPersonalVersion, false)
  assert.equal(account.plan?.isHighestTier, true)
  assert.equal(account.plan?.organization?.orgName, 'DeepSeek Harness Team')
  assert.equal(account.plan?.organization?.isSuspended, false)
  assert.equal(account.plan?.featureAllowed?.codeReview, true)

  assert.equal(account.status?.allowByok, 2)
  assert.equal(account.status?.teamAllowByok, 2)
  assert.equal(account.status?.isPrivacyPolicyModifiable, true)

  assert.equal(planHeaders?.authorization, 'Bearer jt-plan-test')
  assert.equal(statusHeaders?.authorization, 'Bearer jt-plan-test')
  assert.equal(statusHeaders?.['Cosy-MachineToken'], 'umid-fingerprint-test')
  assert.equal(statusHeaders?.['Cosy-MachineType'], 'host')
  assert.equal(planHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(statusHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(quotaHeaders?.['user-agent'], 'qoder/1.1.47')
  assert.equal(planHeaders?.['cosy-clienttype'], '5')
  assert.equal(statusHeaders?.['cosy-clienttype'], '5')
  assert.equal(quotaHeaders?.['cosy-clienttype'], '5')
})

test('QoderUsageReader reads dedicated campaign packages and drops the year-9999 "never" expiry', async () => {
  // The two facts the international account actually answers with, as seen
  // live: `expiresAt` is 253402214400000 — a valid timestamp meaning "no
  // expiry" — and the SOTA grant sits in `dedicatedResourcePackages` with its
  // own epoch and its own localized labels. Reading the sentinel as a date
  // told the user the quota resets in the year 10000; ignoring the array hid
  // 2,000 real credits.
  let usageBody: Record<string, unknown> | undefined
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-dedicated', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-ded', email: 'd@qoder.sh', name: 'Ded Case' }))
    }
    if (url.includes('/plan') || url.includes('/status')) {
      return new Response(JSON.stringify({ error: 'not needed' }), { status: 503 })
    }
    if (url.includes('/quota/usage')) {
      usageBody = {
        userId: 'user-ded',
        userType: 'personal_standard',
        usageType: 'credits',
        totalUsagePercentage: 0.01,
        isQuotaExceeded: false,
        expiresAt: 253402214400000,
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
        addOnQuota: { total: 100, used: 5, remaining: 95, percentage: 0.06, unit: 'credits' },
        dedicatedResourcePackages: [
          {
            id: '01a1426f',
            name: 'act-20261014-129',
            description: 'growth-campaign:act-20261014-129:grant:01a1426f',
            total: 2000,
            used: 0,
            remaining: 2000,
            percentage: 0,
            unit: 'credits',
            expiresAt: 1792375197331,
            available: true,
            status: 'QUOTA_DETAIL_STATUS_ACTIVE',
            displayLabels: [
              { dimension: 'description', value: 'sota model series description', valueI18n: { 'en-US': 'SOTA Exclusive Credits: used first.', 'zh-CN': 'SOTA 专属积分：优先抵扣。' } },
              { dimension: 'title', value: 'sota model series', valueI18n: { 'en-US': 'SOTA Exclusive Credits', 'zh-CN': 'SOTA 专属积分' } },
            ],
          },
          // A malformed entry the reader must survive rather than fail the
          // whole quota answer over.
          null,
        ],
      }
      return new Response(JSON.stringify(usageBody), { status: 200 })
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({ fetch: fetchMock as typeof fetch, resolveMachineId: () => 'machine-ded' })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })

  const account = await reader.readAccount('pt-ded')
  // The sentinel is the absence of an expiry, not a date in the year 10000.
  assert.equal(account.usage?.expiresAt, undefined)
  assert.equal(account.usage?.addOnQuota?.remaining, 95)
  const packs = account.usage?.dedicatedResourcePackages
  assert.equal(packs?.length, 1)
  assert.equal(packs?.[0]?.total, 2000)
  assert.equal(packs?.[0]?.remaining, 2000)
  assert.equal(packs?.[0]?.id, '01a1426f')
  assert.equal(packs?.[0]?.name, 'act-20261014-129')
  assert.equal(packs?.[0]?.status, 'QUOTA_DETAIL_STATUS_ACTIVE')
  assert.equal(packs?.[0]?.available, true)
  // The grant keeps its OWN expiry: the epoch ms the package carried, ISO'd.
  assert.equal(packs?.[0]?.expiresAt, new Date(1792375197331).toISOString())
  // The title comes from `displayLabels` at dimension `title`, keyed by the
  // bare language — never the `act-…` code and never the description label.
  assert.deepEqual(packs?.[0]?.title, { zh: 'SOTA 专属积分', en: 'SOTA Exclusive Credits' })
  // The raw upstream array still rides through for anything unmapped.
  assert.equal((account.usage?.raw as { dedicatedResourcePackages?: unknown[] }).dedicatedResourcePackages?.length, 2)
})

test('QoderUsageReader carries the upstream itemized link for a summed bucket', async () => {
  // The quota endpoint answers the bonus credits as ONE summed bucket with no
  // expiry, and hands the caller a `detailUrl` pointing at the page that does
  // itemize them (with a per-grant expiry each). Dropping that field left the
  // card with nothing honest to say about when the bucket runs out.
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-link', expires_in: 3_600_000 }))
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-link', name: 'Link Case' }))
    if (url.includes('/plan') || url.includes('/status')) return new Response(JSON.stringify({}), { status: 503 })
    if (url.includes('/quota/usage')) {
      return new Response(JSON.stringify({
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
        addOnQuota: {
          total: 400, used: 90, remaining: 310, percentage: 0.23, unit: 'credits',
          detailUrl: 'https://qoder.com/account/usage',
        },
        expiresAt: 253402214400000,
      }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({ fetch: fetchMock as typeof fetch, resolveMachineId: () => 'machine-link' })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })

  const account = await reader.readAccount('pt-link')
  assert.equal(account.usage?.addOnQuota?.detailUrl, 'https://qoder.com/account/usage')
  assert.equal(account.usage?.addOnQuota?.remaining, 310)
  // A bucket the upstream did not link states no link, rather than an empty one.
  assert.equal(account.usage?.userQuota?.detailUrl, undefined)
})

test('QoderUsageReader keeps a real plan expiry that merely looks far out', async () => {
  // Guard against a sentinel test that over-fits: a subscription ending in
  // 2031 is a date the card must print, so the drop keys on the year-9999
  // sentinel alone, not on "a date the user will not live to see".
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-far', expires_in: 3_600_000 }))
    if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'user-far', name: 'Far Case' }))
    if (url.includes('/user/plan')) {
      return new Response(JSON.stringify({
        user_type: 'pro',
        plan_tier_name: 'Pro',
        is_personal_version: true,
        start_date: 1792000000000,
        end_date: Date.parse('2031-01-01T00:00:00Z'),
      }))
    }
    if (url.includes('/user/status')) return new Response(JSON.stringify({ featureSwitches: { allow_byok: 0 } }))
    if (url.includes('/quota/usage')) {
      return new Response(JSON.stringify({
        userQuota: { total: 10, used: 1, remaining: 9, unit: 'credits' },
        expiresAt: Date.parse('2031-01-01T00:00:00Z'),
      }))
    }
    throw new Error(`unexpected URL: ${url}`)
  }
  const authService = new QoderAuthService({ fetch: fetchMock as typeof fetch, resolveMachineId: () => 'machine-far' })
  const reader = new QoderUsageReader({ authService, fetch: fetchMock as typeof fetch })
  const account = await reader.readAccount('pt-far')
  assert.equal(account.usage?.expiresAt, '2031-01-01T00:00:00.000Z')
  assert.equal(account.plan?.endDate, '2031-01-01T00:00:00.000Z')
  assert.equal(account.usage?.dedicatedResourcePackages, undefined)
})

test('QoderUsageReader degrades gracefully when plan or status endpoint returns error', async () => {
  const fetchMock = async (input: URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-degrade-test', expires_in: 3_600_000 }))
    }
    if (url.includes('/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-deg', email: 'deg@qoder.sh', name: 'Degrading Dev' }))
    }
    if (url.includes('/quota/usage')) {
      return new Response(JSON.stringify({ userQuota: { total: 50, used: 10, remaining: 40, unit: 'credits' } }))
    }
    if (url.includes('/user/plan')) {
      return new Response(JSON.stringify({ error: 'Plan service unavailable' }), { status: 503 })
    }
    if (url.includes('/user/status')) {
      return new Response(JSON.stringify({ error: 'Status not found' }), { status: 404 })
    }
    throw new Error(`unexpected URL: ${url}`)
  }

  const authService = new QoderAuthService({
    fetch: fetchMock as typeof fetch,
    resolveMachineId: () => 'machine-deg',
  })
  const reader = new QoderUsageReader({
    authService,
    fetch: fetchMock as typeof fetch,
  })

  const account = await reader.readAccount('pt-degrade-test')
  assert.equal(account.profile.name, 'Degrading Dev')
  assert.equal(account.usage?.userQuota?.remaining, 40)
  assert.equal(account.plan, undefined)
  assert.equal(account.status, undefined)
})
