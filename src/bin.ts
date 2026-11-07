#!/usr/bin/env node
/** Standalone status/diagnostics/PAT CLI for the dsh-qoder-connect bundle. */

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { QoderCredentialStore, qoderCredentialIdentity } from './auth.ts'
import { QoderUpstreamClient, validateApiKey } from './upstream.ts'
import { createQoderTransport } from './qoder/transport/index.ts'
import { FALLBACK_QODER_MODELS } from './catalog.ts'
import { QoderCatalogStore, qoderCatalogPath } from './catalog-store.ts'
import { QoderProbeStore, qoderProbePath } from './probe-store.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, qoderHostHeartbeatPath, readHostHeartbeat } from './host-heartbeat.ts'
import { CHINA_VARIANT, QODER_VARIANTS, variantFor, type QoderVariant } from './variants.ts'

type Action = 'doctor' | 'status' | 'pat' | 'logout' | 'catalog'
type PatCommand = 'set' | 'list' | 'use' | 'rm' | 'clear'
type CatalogCommand = 'refresh'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-qoder-connect <doctor|status|pat|logout|catalog> [--provider <id>] [--json] [--file <path>]',
    '',
    '  doctor         secret-free environment diagnostics',
    '  status         credential state and remaining Qoder credit',
    '  pat set        validate, store, and activate a Personal Access Token (arg, --file, or stdin)',
    '  pat list       list saved tokens and mark the active one',
    '  pat use <id>   switch to a saved token',
    '  pat rm <id>    remove a saved token',
    '  pat clear      remove every saved token',
    '  logout         alias for `pat clear`',
    '  catalog refresh   re-fetch the model list and save it for this account',
    '',
    '  --provider  which product to act on; defaults to qoder',
    `              one of: ${QODER_VARIANTS.map(variant => variant.id).join(', ')}`,
    '  --json      emit one secret-free JSON document (doctor/status only)',
    '  --file      file to read the token from with `pat set`; "-" reads standard input',
    '',
    '  A token can also arrive as the positional argument after `pat set`.',
    '  Environment fallback: QODER_CN_PERSONAL_ACCESS_TOKEN (qoder) or',
    '  QODER_PERSONAL_ACCESS_TOKEN (qoder-global) when no file is saved.',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** One variant's store. */
function makeStore(variant: QoderVariant): QoderCredentialStore {
  return new QoderCredentialStore({ variant })
}

/** One variant's store plus the upstream client riding its transport. */
function makeClient(store: QoderCredentialStore, variant: QoderVariant): QoderUpstreamClient {
  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
  })
  return new QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
  })
}

async function doctor(jsonOutput: boolean, variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const status = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-qoder-connect',
    version: QODER_CONNECT_VERSION,
    node: process.version,
    provider: variant.id,
    displayName: variant.displayName,
    region: variant.region,
    credentialFile: store.ownAuthPath(),
    hostHeartbeat: {
      path: qoderHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    ...status.pat === undefined ? {} : { pat: status.pat },
    ...status.reason === undefined ? {} : { reason: status.reason },
    fallbackModels: FALLBACK_QODER_MODELS.length,
    hints: [
      ...status.state === 'configured'
        ? []
        : [`Save a token with \`dsh-qoder-connect pat set <token> --provider ${variant.id}\`, or from the plugin's settings card.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card is unavailable until DSH starts the plugin; the pat command above still works.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `${variant.displayName} Connect ${QODER_CONNECT_VERSION} on ${process.version}`,
      `Region: ${report.region}`,
      `Credential file: ${report.credentialFile}`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Credential: ${status.state === 'configured' ? `configured (${status.pat?.source ?? 'file'}${status.pat?.patTail === undefined ? '' : `, tail …${status.pat.patTail}`})` : 'missing'}`,
      ...status.reason === undefined ? [] : [`Note: ${status.reason}`],
      `Static fallback models: ${report.fallbackModels}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'configured' ? 0 : 1
}

async function status(jsonOutput: boolean, variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const auth = await store.status()
  const base = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-qoder-connect',
    version: QODER_CONNECT_VERSION,
    provider: variant.id,
    region: variant.region,
    credentialFile: auth.filePath,
    signIn: auth.state,
    ...auth.pat === undefined ? {} : { pat: auth.pat },
    ...auth.reason === undefined ? {} : { reason: auth.reason },
  }
  if (auth.state !== 'configured') {
    if (jsonOutput) printJson({ ...base, credits: undefined })
    else {
      process.stdout.write([
        `${variant.displayName}: no credential configured at ${auth.filePath}`,
        ...auth.reason === undefined ? [] : [`Note: ${auth.reason}`],
        'Save a token with `pat set` or from the plugin\u2019s settings card.',
        '',
      ].join('\n'))
    }
    return 1
  }
  const client = makeClient(store, variant)
  try {
    const credits = await client.fetchCredits()
    if (jsonOutput) printJson({ ...base, credits })
    else {
      process.stdout.write([
        `${variant.displayName} (${variant.region}): token from ${auth.pat?.source ?? 'file'}${auth.pat?.patTail === undefined ? '' : `, tail …${auth.pat.patTail}`}`,
        credits.unlimited ? 'Quota: unlimited for the current cycle' : `Quota: ${Math.max(0, 100 - credits.total).toFixed(1)}% remaining of the cycle allowance`,
        ...credits.accounts.map(account => `  ${account.packageName}: ${account.remain}/${account.size}${account.unlimited ? ' (unlimited)' : ''}`),
        ...credits.cycleResetTime === undefined ? [] : [`  resets: ${credits.cycleResetTime}`],
        '',
      ].join('\n'))
    }
    return 0
  } catch (error: unknown) {
    if (jsonOutput) printJson({ ...base, creditsError: safeMessage(error) })
    else process.stdout.write(`${variant.displayName}: credential stored, but the quota call failed: ${safeMessage(error)}\n`)
    return 1
  }
}

/** Read a token from the positional arg, --file, or standard input. */
async function readPat(source: string | undefined, inline: string | undefined): Promise<string> {
  const raw = source === undefined
    ? inline ?? await readStdin()
    : source === '-' ? await readStdin() : await readFile(source, 'utf8')
  const pat = raw?.trim() ?? ''
  if (pat === '') throw new Error('no token given: pass it as an argument, via --file <path>, or on standard input')
  return pat
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Drop the saved catalog and probe records that belong to one token, exactly as the
 * host does when a token is removed from the card — leaving them would resurrect
 * data for a token the user just deleted.
 */
function forgetAccount(variant: QoderVariant, credential: { pat: string }): void {
  const identity = qoderCredentialIdentity(credential)
  new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) }).delete(identity)
  new QoderProbeStore({
    pluginVersion: QODER_CONNECT_VERSION,
    path: qoderProbePath(variant.probeFilename),
  }).clearFor(identity)
}

async function patSet(variant: QoderVariant, file: string | undefined, inline: string | undefined): Promise<number> {
  const store = makeStore(variant)
  const pat = await readPat(file, inline)
  process.stdout.write(`Validating a token against ${variant.displayName} (${variant.region})…\n`)
  // Validate before writing: a saved file should always be one the plugin believes
  // works. A refusal costs one discovery call; a bad save costs every later request.
  // An unreachable endpoint throws after its retries: that is a network condition,
  // not a refused token, so say which one it was instead of blaming the PAT.
  let verdict: Awaited<ReturnType<typeof validateApiKey>>
  try {
    verdict = await validateApiKey(pat, variant.region)
  } catch {
    process.stderr.write(`dsh-qoder-connect: could not reach ${variant.displayName} (${variant.region}). Nothing was saved.\n`)
    process.stderr.write('The token was never checked; retry once the connection is back.\n')
    return 2
  }
  if (verdict === 'invalid') {
    process.stderr.write(`dsh-qoder-connect: the token was refused by ${variant.displayName} (${variant.region}). Nothing was saved.\n`)
    process.stderr.write('If this token belongs to the other Qoder product, use --provider for that one.\n')
    return 2
  }
  await store.save(pat, 'cli')
  const status = await store.status()
  process.stdout.write([
    `Saved and activated in ${store.ownAuthPath()}${status.pat?.patTail === undefined ? '' : ` (tail …${status.pat.patTail})`}`,
    `${status.profiles?.length ?? 1} saved token(s); switch with \`dsh-qoder-connect pat use <id>\`.`,
    'The running plugin picks the token up on its next sweep; no restart needed.',
    ...verdict === 'no_models' ? ['Warning: the account lists no enabled model — nothing will run until it has a plan with models.'] : [],
    '',
  ].join('\n'))
  return 0
}

/** List the saved tokens, marking the active one; never prints a token. */
async function patList(jsonOutput: boolean, variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const status = await store.status()
  const profiles = status.profiles ?? []
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      provider: variant.id,
      activeId: status.activeId ?? null,
      profiles,
      ...status.pat?.source === 'env' ? { source: 'env' } : {},
    })
    return 0
  }
  if (profiles.length === 0) {
    process.stdout.write(
      status.pat?.source === 'env'
        ? `${variant.displayName}: no saved token; the environment token is in use${status.pat.patTail === undefined ? '' : ` (tail …${status.pat.patTail})`}.\n`
        : `${variant.displayName}: no saved tokens.\n`,
    )
    return 0
  }
  const lines = profiles.map(profile => [
    profile.id === status.activeId ? '*' : ' ',
    profile.id,
    profile.label ?? '(no label)',
    profile.patTail === undefined ? '' : `tail …${profile.patTail}`,
  ].filter(part => part !== '').join('  '))
  process.stdout.write([`${variant.displayName} saved tokens (* = active):`, ...lines, ''].join('\n'))
  return 0
}

/** Make one saved token active. */
async function patUse(variant: QoderVariant, id: string): Promise<number> {
  const store = makeStore(variant)
  const entry = await store.activate(id)
  if (entry === undefined) {
    process.stderr.write(`dsh-qoder-connect: no saved token with id ${JSON.stringify(id)}; run \`pat list\` to see the ids.\n`)
    return 1
  }
  const tail = entry.pat.slice(-4)
  process.stdout.write(`${variant.displayName}: active token is now ${entry.id}${tail.length === 4 ? ` (tail …${tail})` : ''}.\n`)
  return 0
}

/** Remove one saved token and the account-scoped data that belonged to it. */
async function patRemove(variant: QoderVariant, id: string): Promise<number> {
  const store = makeStore(variant)
  const removed = await store.remove(id)
  if (removed === undefined) {
    process.stderr.write(`dsh-qoder-connect: no saved token with id ${JSON.stringify(id)}; run \`pat list\` to see the ids.\n`)
    return 1
  }
  forgetAccount(variant, removed)
  const status = await store.status()
  process.stdout.write([
    `${variant.displayName}: removed ${removed.id}.`,
    status.activeId === undefined
      ? 'No saved token remains; the plugin is signed out of this variant.'
      : `Active token is now ${status.activeId}.`,
    '',
  ].join('\n'))
  return 0
}

async function patClear(variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  // Only this variant's stored credentials are removed, so signing out of one
  // product never affects the other. An environment token is not ours to remove.
  const saved = await store.entries()
  for (const entry of saved) forgetAccount(variant, entry)
  await store.clear()
  const status = await store.status()
  process.stdout.write(
    status.state === 'configured'
      ? `${variant.displayName} Connect: removed ${saved.length} saved token(s), but a token is still active from the environment (${status.pat?.source ?? 'env'}).\n`
      : `${variant.displayName} Connect: signed out; removed ${store.ownAuthPath()}\n`,
  )
  return 0
}

async function catalogRefresh(variant: QoderVariant): Promise<number> {
  const store = makeStore(variant)
  const credential = await store.resolve()
  const client = makeClient(store, variant)
  const models = await client.fetchModels()
  const identity = qoderCredentialIdentity(credential)
  const fetch = client.lastCatalog
  // The CLI writes the same saved-catalog file the host reads, so a refresh here
  // survives a plugin restart exactly like a live fetch would.
  new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) }).set(identity, {
    source: fetch?.source ?? 'unknown',
    fetchedAtMs: fetch?.fetchedAtMs ?? Date.now(),
    models: [...models],
  })
  process.stdout.write(`${variant.displayName}: fetched ${models.length} models; saved for account ${identity}.\n`)
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'status', 'pat', 'logout', 'catalog']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-qoder-connect: expected doctor, status, pat, logout, or catalog; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  // `--provider <id>` (or `--provider=<id>`); absent means the China provider.
  // `--file <path>` names the file `pat set` reads the token from.
  let providerId: string | undefined
  let file: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    if (flag === '--file') {
      file = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--file=')) {
      file = flag.slice('--file='.length)
      continue
    }
    rest.push(flag)
  }
  const variant = providerId === undefined ? CHINA_VARIANT : variantFor(providerId)
  if (variant === undefined) {
    process.stderr.write(
      `dsh-qoder-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${QODER_VARIANTS.map(v => v.id).join(', ')}\n`,
    )
    return 1
  }
  // `pat` and `catalog` carry a subcommand; peel it off `rest` before the
  // flag hygiene below can mistake it for an unknown option.
  let patCommand: PatCommand | undefined
  let catalogCommand: CatalogCommand | undefined
  /** The positional a subcommand takes: the token (`set`) or the entry id. */
  let commandArg: string | undefined
  if (action === 'pat') {
    const sub = rest.shift()
    patCommand = sub === 'set' || sub === 'list' || sub === 'use' || sub === 'rm' || sub === 'clear'
      ? sub
      : undefined
    if (patCommand === undefined) {
      process.stderr.write(`dsh-qoder-connect: pat needs set, list, use, rm, or clear; got ${JSON.stringify(sub ?? '')}\n`)
      return 1
    }
    if (patCommand !== 'list' && patCommand !== 'clear') commandArg = rest.shift()
    if ((patCommand === 'use' || patCommand === 'rm') && (commandArg === undefined || commandArg.startsWith('--'))) {
      process.stderr.write(`dsh-qoder-connect: pat ${patCommand} needs an entry id; run \`pat list\` to see them\n`)
      return 1
    }
  }
  if (action === 'catalog') {
    const sub = rest.shift()
    catalogCommand = sub === 'refresh' ? sub : undefined
    if (catalogCommand === undefined) {
      process.stderr.write(`dsh-qoder-connect: catalog needs refresh; got ${JSON.stringify(sub ?? '')}\n`)
      return 1
    }
  }
  const patListJson = action === 'pat' && patCommand === 'list'
  const unknown = rest.filter(flag => flag !== '--json' && !flag.startsWith('--'))
  if (unknown.length > 0 || (jsonOutput && action !== 'doctor' && action !== 'status' && !patListJson)) {
    process.stderr.write(`dsh-qoder-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  if (action !== 'pat' && file !== undefined) {
    process.stderr.write(`dsh-qoder-connect: --file applies to pat set, not ${action}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, variant)
      case 'status':
        return await status(jsonOutput, variant)
      case 'pat':
        switch (patCommand) {
          case 'set':
            return await patSet(variant, file, commandArg)
          case 'list':
            return await patList(jsonOutput, variant)
          case 'use':
            return await patUse(variant, commandArg as string)
          case 'rm':
            return await patRemove(variant, commandArg as string)
          case 'clear':
            return await patClear(variant)
        }
        return 1
      case 'logout':
        return await patClear(variant)
      case 'catalog':
        return await catalogRefresh(variant)
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-qoder-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
