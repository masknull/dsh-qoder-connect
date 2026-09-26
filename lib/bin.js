#!/usr/bin/env node
import { D as FALLBACK_QODER_MODELS, E as qoderCatalogPath, T as QoderCatalogStore, V as qoderCredentialIdentity, b as createQoderTransport, f as QODER_CONNECT_VERSION, i as variantFor, l as qoderHostHeartbeatPath, m as QoderUpstreamClient, r as QODER_VARIANTS, s as isHeartbeatProcessAlive, t as CHINA_VARIANT, u as readHostHeartbeat, y as validateApiKey, z as QoderCredentialStore } from "./variants-DuEgaUad.js";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics/PAT CLI for the dsh-qoder-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-qoder-connect <doctor|status|pat|logout|catalog> [--provider <id>] [--json] [--file <path>]",
		"",
		"  doctor         secret-free environment diagnostics",
		"  status         credential state and remaining Qoder credit",
		"  pat set        validate and store a Personal Access Token (arg, --file, or stdin)",
		"  pat clear      remove the stored credential",
		"  logout         alias for `pat clear`",
		"  catalog refresh   re-fetch the model list and save it for this account",
		"",
		"  --provider  which product to act on; defaults to qoder",
		`              one of: ${QODER_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --json      emit one secret-free JSON document (doctor/status only)",
		"  --file      file to read the token from with `pat set`; \"-\" reads standard input",
		"",
		"  A token can also arrive as the positional argument after `pat set`.",
		"  Environment fallback: QODER_CN_PERSONAL_ACCESS_TOKEN (qoder) or",
		"  QODER_PERSONAL_ACCESS_TOKEN (qoder-global) when no file is saved.",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** One variant's store. */
function makeStore(variant) {
	return new QoderCredentialStore({ variant });
}
/** One variant's store plus the upstream client riding its transport. */
function makeClient(store, variant) {
	const transport = createQoderTransport({
		region: variant.region,
		resolvePat: () => store.patPromise()
	});
	return new QoderUpstreamClient({
		region: variant.region,
		providerId: variant.id,
		getPat: () => store.patPromise(),
		transport
	});
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-connect",
		version: QODER_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		region: variant.region,
		credentialFile: store.ownAuthPath(),
		hostHeartbeat: {
			path: qoderHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		...status.pat === void 0 ? {} : { pat: status.pat },
		...status.reason === void 0 ? {} : { reason: status.reason },
		fallbackModels: FALLBACK_QODER_MODELS.length,
		hints: [...status.state === "configured" ? [] : [`Save a token with \`dsh-qoder-connect pat set <token> --provider ${variant.id}\`, or from the plugin's settings card.`], ...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card is unavailable until DSH starts the plugin; the pat command above still works."]]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`${variant.displayName} Connect ${QODER_CONNECT_VERSION} on ${process.version}`,
		`Region: ${report.region}`,
		`Credential file: ${report.credentialFile}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Credential: ${status.state === "configured" ? `configured (${status.pat?.source ?? "file"}${status.pat?.patTail === void 0 ? "" : `, tail …${status.pat.patTail}`})` : "missing"}`,
		...status.reason === void 0 ? [] : [`Note: ${status.reason}`],
		`Static fallback models: ${report.fallbackModels}`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "configured" ? 0 : 1;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const auth = await store.status();
	const base = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-qoder-connect",
		version: QODER_CONNECT_VERSION,
		provider: variant.id,
		region: variant.region,
		credentialFile: auth.filePath,
		signIn: auth.state,
		...auth.pat === void 0 ? {} : { pat: auth.pat },
		...auth.reason === void 0 ? {} : { reason: auth.reason }
	};
	if (auth.state !== "configured") {
		if (jsonOutput) printJson({
			...base,
			credits: void 0
		});
		else process.stdout.write([
			`${variant.displayName}: no credential configured at ${auth.filePath}`,
			...auth.reason === void 0 ? [] : [`Note: ${auth.reason}`],
			"Save a token with `pat set` or from the plugin’s settings card.",
			""
		].join("\n"));
		return 1;
	}
	const client = makeClient(store, variant);
	try {
		const credits = await client.fetchCredits();
		if (jsonOutput) printJson({
			...base,
			credits
		});
		else process.stdout.write([
			`${variant.displayName} (${variant.region}): token from ${auth.pat?.source ?? "file"}${auth.pat?.patTail === void 0 ? "" : `, tail …${auth.pat.patTail}`}`,
			credits.unlimited ? "Quota: unlimited for the current cycle" : `Quota: ${Math.max(0, 100 - credits.total).toFixed(1)}% remaining of the cycle allowance`,
			...credits.accounts.map((account) => `  ${account.packageName}: ${account.remain}/${account.size}${account.unlimited ? " (unlimited)" : ""}`),
			...credits.cycleResetTime === void 0 ? [] : [`  resets: ${credits.cycleResetTime}`],
			""
		].join("\n"));
		return 0;
	} catch (error) {
		if (jsonOutput) printJson({
			...base,
			creditsError: safeMessage(error)
		});
		else process.stdout.write(`${variant.displayName}: credential stored, but the quota call failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
/** Read a token from the positional arg, --file, or standard input. */
async function readPat(source, rest) {
	const inline = rest.find((argument) => !argument.startsWith("--"));
	const pat = (source === void 0 ? inline ?? await readStdin() : source === "-" ? await readStdin() : await readFile(source, "utf8"))?.trim() ?? "";
	if (pat === "") throw new Error("no token given: pass it as an argument, via --file <path>, or on standard input");
	return pat;
}
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
async function patSet(variant, file, rest) {
	const store = makeStore(variant);
	const pat = await readPat(file, rest);
	process.stdout.write(`Validating a token against ${variant.displayName} (${variant.region})…\n`);
	if (!await validateApiKey(pat, variant.region)) {
		process.stderr.write(`dsh-qoder-connect: the token was refused by ${variant.displayName} (${variant.region}). Nothing was saved.\n`);
		process.stderr.write("If this token belongs to the other Qoder product, use --provider for that one.\n");
		return 2;
	}
	await store.save(pat, "cli");
	const status = await store.status();
	process.stdout.write([
		`Saved to ${store.ownAuthPath()}${status.pat?.patTail === void 0 ? "" : ` (tail …${status.pat.patTail})`}`,
		"The running plugin picks the token up on its next sweep; no restart needed.",
		""
	].join("\n"));
	return 0;
}
async function patClear(variant) {
	const store = makeStore(variant);
	await store.clear();
	const status = await store.status();
	process.stdout.write(status.state === "configured" ? `${variant.displayName} Connect: removed the stored file, but a token is still active from the environment (${status.pat?.source ?? "env"}).\n` : `${variant.displayName} Connect: signed out; removed ${store.ownAuthPath()}\n`);
	return 0;
}
async function catalogRefresh(variant) {
	const store = makeStore(variant);
	const credential = await store.resolve();
	const client = makeClient(store, variant);
	const models = await client.fetchModels();
	const identity = qoderCredentialIdentity(credential);
	const fetch = client.lastCatalog;
	new QoderCatalogStore({ path: qoderCatalogPath(variant.catalogFilename) }).set(identity, {
		source: fetch?.source ?? "unknown",
		fetchedAtMs: fetch?.fetchedAtMs ?? Date.now(),
		models: [...models]
	});
	process.stdout.write(`${variant.displayName}: fetched ${models.length} models; saved for account ${identity}.\n`);
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"status",
		"pat",
		"logout",
		"catalog"
	].includes(rawAction)) {
		process.stderr.write(`dsh-qoder-connect: expected doctor, status, pat, logout, or catalog; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	let file;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		if (flag === "--file") {
			file = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--file=")) {
			file = flag.slice(7);
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CHINA_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-qoder-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${QODER_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	let patCommand;
	let catalogCommand;
	if (action === "pat") {
		const sub = rest.shift();
		patCommand = sub === "set" || sub === "clear" ? sub : void 0;
		if (patCommand === void 0) {
			process.stderr.write(`dsh-qoder-connect: pat needs set or clear; got ${JSON.stringify(sub ?? "")}\n`);
			return 1;
		}
	}
	if (action === "catalog") {
		const sub = rest.shift();
		catalogCommand = sub === "refresh" ? sub : void 0;
		if (catalogCommand === void 0) {
			process.stderr.write(`dsh-qoder-connect: catalog needs refresh; got ${JSON.stringify(sub ?? "")}\n`);
			return 1;
		}
	}
	if (rest.filter((flag) => flag !== "--json" && !flag.startsWith("--")).length > 0 || jsonOutput && action !== "doctor" && action !== "status") {
		process.stderr.write(`dsh-qoder-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	if (action !== "pat" && file !== void 0) {
		process.stderr.write(`dsh-qoder-connect: --file applies to pat set, not ${action}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, variant);
			case "status": return await status(jsonOutput, variant);
			case "pat": return patCommand === "set" ? await patSet(variant, file, rest) : await patClear(variant);
			case "logout": return await patClear(variant);
			case "catalog": return await catalogRefresh(variant);
		}
	} catch (error) {
		process.stderr.write(`dsh-qoder-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
