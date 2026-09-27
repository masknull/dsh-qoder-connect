import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Qoder from '../src/index.ts'
import { fingerprintModel } from '../src/probe-store.ts'
import { normalizeQoderModels } from '../src/qoder/catalog.ts'
import { modelInfoOf } from '../src/upstream.ts'

/**
 * End-to-end tests for the observation/declaration merge, driven through the
 * real LLM seam rather than an internal helper
 * (`docs/reasoning-effort-probe-plan.md` 搂5).
 *
 * What must hold:
 * - with no observation, an undeclared model still exposes no control (the
 *   shipped behavior is unchanged for anyone who never opts in);
 * - a *validating* observation grants exactly the verified spellings;
 * - a *non-validating* observation grants nothing, because the upstream
 *   accepts values that cannot exist;
 * - a declared set is never overridden, and probing never confers `off`.
 */

const CLEANUP: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-qoder-probe-'))
  CLEANUP.push(root)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const path of CLEANUP.splice(0)) await rm(path, { recursive: true, force: true })
})

/** The PAT these fixtures sign in as; records must carry its hashed identity. */
const PAT = 'pt-merge-0000000000000000000000mm'
const ACCOUNT = Qoder.qoderCredentialIdentity({ pat: PAT })

/**
 * The one temporary root every boot in this spec shares.
 *
 * The plugin keeps module-level per-identity records (`lastIdentities`,
 * `lastLiveFetchAt`) and a file-backed saved catalog, all designed so a
 * restart of the SAME account — a 0.1.7 settings-write fiber reload — neither
 * re-fetches what was just fetched nor drops the records the account owns.
 * A fresh root or a fresh PAT per boot would instead read as an account
 * switch: the saved catalog could not be read from the new root, the startup
 * fetch would be re-issued (or skipped without the file to fall back on), and
 * every observation would be cleared by `adoptIdentity`. Each case therefore
 * boots the same account in the same root, which is the sequence the module
 * state exists to serve.
 */
let root: string

/** Undeclared but reasoning-capable: the merge target. */
const UNDECLARED_ID = 'probe-me'
/** Declares low/high: an observation must never widen or replace it. */
const DECLARED_ID = 'declared-model'

/** A model-list envelope carrying both shapes, served by the fake upstream. */
function catalogEnvelope(): string {
  return JSON.stringify({
    assistant: [
      {
        key: UNDECLARED_ID,
        enable: true,
        display_name: 'Probe Me',
        max_input_tokens: 100_000,
        max_output_tokens: 1_000,
        is_reasoning: true,
        price_factor: 1,
      },
      {
        key: DECLARED_ID,
        enable: true,
        display_name: 'Declared Model',
        max_input_tokens: 100_000,
        max_output_tokens: 1_000,
        is_reasoning: true,
        thinking_config: {
          enabled: {
            efforts: {
              low: { description: 'think a little' },
              high: { description: 'think a lot', is_default: true },
            },
          },
        },
        price_factor: 1,
      },
    ],
  })
}

/** The row the runtime will actually serve for one id of that envelope. */
function liveRowOf(modelId: string) {
  const models = normalizeQoderModels(JSON.parse(catalogEnvelope()))
  const row = models.find(model => model.id === modelId)
  if (row === undefined) throw new Error(`no catalog row for ${modelId}`)
  return modelInfoOf(row)
}

/** A Qoder credential document, written where the plugin's own store reads it. */
function credentialDocument(): string {
  return JSON.stringify({ version: 2, pat: PAT, region: 'china', savedAt: Date.now() })
}

/**
 * Write a probe record for `model` before the plugin boots, then start it.
 *
 * A signed-in credential is required, not incidental: observations are bound to
 * the account that produced them, so a record with no account in effect is (by
 * design) never served. Signing in here is what makes the cases below exercise
 * the merge rather than the account check.
 */
async function boot(options: {
  model?: string
  record?: (fingerprint: string) => Qoder.QoderProbeRecord
}): Promise<Context> {
  vi.stubEnv('DSH_HOME', root)
  // The plugin keeps its files under its own data directory; point that at the
  // same temporary root so the credential below is the one the store reads.
  vi.stubEnv(Qoder.QODER_DATA_DIR_ENV, root)
  // Keep the transport's machine-id seed inside the temp root too.
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  // A stray PAT in the developer's environment must not sign a variant in.
  vi.stubEnv('QODER_PERSONAL_ACCESS_TOKEN', '')
  vi.stubEnv('QODER_CN_PERSONAL_ACCESS_TOKEN', '')
  await writeFile(join(root, Qoder.CHINA_VARIANT.ownFilename), credentialDocument())
  // The upstream only ever answers with this fixed roster: a real fetch would
  // replace it with whatever the live catalog happens to say today.
  const envelope = catalogEnvelope()
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.includes('/api/v1/jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-merge', expires_in: 86_400_000 }), { status: 200 })
    }
    if (href.includes('/api/v1/userinfo')) {
      return new Response(JSON.stringify({ id: 'user-merge', email: 'merge@example.invalid', name: 'merge' }), { status: 200 })
    }
    if (href.includes('/algo/api/v2/model/list')) {
      return new Response(envelope, { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))

  if (options.record !== undefined && options.model !== undefined) {
    // The record file lives in the plugin's state directory; the store writes
    // it through the same default path the running plugin will read.
    await mkdir(join(root, 'state'), { recursive: true })
    const store = new Qoder.QoderProbeStore({ pluginVersion: 'test' })
    store.set(options.model, options.record(fingerprintModel(liveRowOf(options.model))))
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Qoder, {})
  await vi.waitFor(async () => {
    expect((await ctx.llm.listModels('qoder')).map(model => model.id)).toContain(UNDECLARED_ID)
  }, { timeout: 10_000 })
  return ctx
}

/** The resolved efforts for one model, sorted, or undefined when none exist. */
async function effortsFor(ctx: Context, modelId: string): Promise<string[] | undefined> {
  const resolved = await ctx.llm.resolveModelInfo('qoder', modelId)
  return resolved.reasoning?.efforts.map(effort => effort.id).sort()
}

describe('probe results merged into the provider', () => {
  it('leaves an undeclared model without a control when nothing was observed', async () => {
    const ctx = await boot({})
    // The undeclared row: no effort set from upstream, no observation.
    expect(await effortsFor(ctx, UNDECLARED_ID)).toBeUndefined()
    void ctx.fiber.dispose()
  })

  it('grants exactly the verified spellings for a validating observation', async () => {
    const ctx = await boot({
      model: UNDECLARED_ID,
      record: fingerprint => ({
        fingerprint,
        validation: 'validating',
        efforts: ['low', 'high'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
        account: ACCOUNT,
      }),
    })
    const efforts = await effortsFor(ctx, UNDECLARED_ID)
    expect(efforts).toEqual(['high', 'low'])
    // `off` is never conferred by probing, even though the picker knows the level.
    expect(efforts).not.toContain('off')
    expect(efforts).not.toContain('minimal')
    void ctx.fiber.dispose()
  })

  it('grants nothing for a non-validating observation', async () => {
    const ctx = await boot({
      model: UNDECLARED_ID,
      record: fingerprint => ({
        fingerprint,
        validation: 'non-validating',
        efforts: [],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
        account: ACCOUNT,
      }),
    })
    expect(await effortsFor(ctx, UNDECLARED_ID)).toBeUndefined()
    void ctx.fiber.dispose()
  })

  it('never overrides a declared set with an observation', async () => {
    const ctx = await boot({
      model: DECLARED_ID,
      // Fabricate an observation that disagrees with the declaration; the
      // declared set must still win.
      record: fingerprint => ({
        fingerprint,
        validation: 'validating',
        efforts: ['max'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
        account: ACCOUNT,
      }),
    })
    // Assert against the declaration actually in force rather than a hardcoded
    // list: the invariant is that the observation never adds to or replaces
    // the declared set — not which values the fake upstream declares.
    const info = liveRowOf(DECLARED_ID)
    const declared = [...(info.reasoning?.supportedEfforts ?? [])].sort()
    expect(declared.length).toBeGreaterThan(0)
    const expected = info.reasoning?.canDisableThinking === true ? ['off', ...declared].sort() : declared
    const efforts = await effortsFor(ctx, DECLARED_ID)
    expect(efforts).toEqual(expected)
    // `max` was in the fabricated observation; it must not appear uninvited.
    expect(efforts).not.toContain('max')
    void ctx.fiber.dispose()
  })

  it('ignores an observation whose fingerprint no longer matches the catalog', async () => {
    const ctx = await boot({
      model: UNDECLARED_ID,
      record: () => ({
        fingerprint: 'stale-fingerprint',
        validation: 'validating',
        efforts: ['low', 'high'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
        account: ACCOUNT,
      }),
    })
    expect(await effortsFor(ctx, UNDECLARED_ID)).toBeUndefined()
    void ctx.fiber.dispose()
  })

  it('ignores an observation made under a different account', async () => {
    const ctx = await boot({
      model: UNDECLARED_ID,
      record: fingerprint => ({
        fingerprint,
        validation: 'validating',
        efforts: ['low', 'high'],
        probedAtMs: Date.now(),
        pluginVersion: 'test',
        // Another PAT's identity: a bearer secret's hash, so this is a
        // different subscriber's entitlement, not this one's.
        account: 'pat:ffffffffffffffff',
      }),
    })
    expect(await effortsFor(ctx, UNDECLARED_ID)).toBeUndefined()
    void ctx.fiber.dispose()
  })
})
