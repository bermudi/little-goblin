// goblin.json5 — the one config file; no secrets (those live in auth.jsonl).

import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { configSchema, type Config } from "./config-schema.ts";
import { durableWriteFile } from "./durable.ts";
import { paths } from "./home-layout.ts";
import { log } from "./log.ts";

// ttsDown is decided once, at boot (ffmpeg probe) — a config mutation
// instead would leak into the mini app's round-trip as an operator "off".
export interface ConfigRef {
	current: Config;
	ttsDown: boolean;
}

// ---------- load / write ----------

function configSyntaxError(err: unknown): Error {
	// JSON5 messages quote input. Only its numeric location is safe to retain.
	const line =
		typeof err === "object" && err !== null && "lineNumber" in err ? err.lineNumber : undefined;
	const location =
		typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? `:${line}` : "";
	return new Error(`${paths.config()}${location}: invalid JSON5`);
}

// Retired delegation keys are the one compatibility exception to the
// unknown-field rule: named here, stripped with a warning on disk load,
// and gone from the next canonical save. Anything else unknown is a
// validation error.
const RETIRED_DELEGATION_KEYS = {
	machine: "delegation.machines.<label>.machine (and root for remote paths)",
	session: "delegation.machines.<label>.session; the own local session is fixed by the service",
	maxRunning: "no replacement — delegation concurrency is not capped by config",
} as const;

function stripRetiredDelegationKeys(raw: unknown, warn: boolean): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const delegation = (raw as Record<string, unknown>).delegation;
	if (typeof delegation !== "object" || delegation === null || Array.isArray(delegation)) {
		return raw;
	}
	let stripped: Record<string, unknown> | null = null;
	for (const [key, replacement] of Object.entries(RETIRED_DELEGATION_KEYS)) {
		if (!Object.hasOwn(delegation, key)) continue;
		if (warn) {
			log.warn("retired delegation config key ignored", {
				path: paths.config(),
				key: `delegation.${key}`,
				replacement,
			});
		}
		stripped ??= { ...(delegation as Record<string, unknown>) };
		delete stripped[key];
	}
	if (stripped === null) return raw;
	return { ...(raw as Record<string, unknown>), delegation: stripped };
}

function parseConfigText(raw: string): unknown {
	try {
		return JSON5.parse(raw);
	} catch (err) {
		throw configSyntaxError(err);
	}
}

// Disk-facing parses for the one compatibility exception (retired
// delegation keys): stripped before strict validation. parseConfigFile
// takes JSON5 text; parseConfigValue takes an already-parsed object for
// callers that separate syntax errors from schema errors (the doctor
// probe reports JSON5 location per its own category contract).
export function parseConfigFile(raw: string, warnRetired = false): Config {
	return parseConfigValue(parseConfigText(raw), warnRetired);
}

export function parseConfigValue(raw: unknown, warnRetired = false): Config {
	return parseConfig(stripRetiredDelegationKeys(raw, warnRetired));
}

// ENOENT → null; every other failure propagates with the path attached.
export function loadConfig(): Config | null {
	let raw: string;
	try {
		raw = readFileSync(paths.config(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		return parseConfigFile(raw, true);
	} catch (error) {
		// Load failures are broken server state, not caller input: HTTP
		// callers map ConfigValidationError to 422, so rethrow it plainly.
		if (error instanceof ConfigValidationError) throw new Error(error.message);
		throw error;
	}
}

// HTTP callers must distinguish invalid edits (422) from I/O failures (500)
// without retaining Zod's input-bearing payload.
export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

// Unknown keys anywhere in the object are rejected, not stripped: a typo
// must fail loudly at load rather than disappear on the next save.
export function parseConfig(raw: unknown): Config {
	const result = configSchema.safeParse(raw);
	if (!result.success) {
		// Nested record keys and issue messages may contain input. Report only
		// schema-owned top-level fields and categories, not the ZodError itself.
		const details = result.error.issues.map((issue) => {
			const field = issue.path[0];
			const safeField =
				typeof field === "string" && Object.hasOwn(configSchema.in.shape, field) ? field : "config";
			return `${safeField}: ${issue.code}`;
		});
		throw new ConfigValidationError(`${paths.config()}: invalid config — ${details.join("; ")}`);
	}
	return result.data;
}

// Synchronous observers see every successful in-process durable write, even
// if a caller's subsequent reload or reconciliation fails. They must not
// throw: the file has already been replaced when they run.
const configWriteObservers = new Set<(config: Config) => void>();
export function observeConfigWrites(observer: (config: Config) => void): () => void {
	configWriteObservers.add(observer);
	return () => {
		configWriteObservers.delete(observer);
	};
}

// A save replaces the whole file with the parsed object in canonical form.
// An existing file is read first and must validate: malformed JSON5 or a
// schema-invalid config is never silently reset to the incoming values.
export function writeConfig(config: Config): void {
	const merged = parseConfig(config);
	const path = paths.config();
	let current: string | null = null;
	try {
		current = readFileSync(path, "utf8");
	} catch (err) {
		// Only a missing file permits initialization. Permission/I/O
		// failures must reach the caller without replacing existing bytes.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (current !== null) {
		try {
			parseConfigFile(current);
		} catch (error) {
			// The save path reports an unreadable incumbent as an I/O/state
			// failure (500), not as an invalid incoming edit (422).
			if (error instanceof ConfigValidationError) throw new Error(error.message);
			throw error;
		}
	}
	durableWriteFile(path, `${JSON5.stringify(merged, null, 2)}\n`);
	for (const observer of configWriteObservers) observer(merged);
}

// Auth record names goblin resolves at boot ("telegram" only while that
// channel is enabled). Single source for the doctor's preflight gate and
// the installer's warm-target rendering — deriving the set twice is how
// they drift.
export function authReferences(config: Config): Set<string> {
	const refs = new Set<string>(config.telegram.enabled ? ["telegram"] : []);
	for (const provider of Object.values(config.providers))
		if ("auth" in provider) refs.add(provider.auth);
	for (const feature of [
		config.memory,
		config.transcription,
		...(config.transcription?.fallbacks ?? []),
		config.tts,
		config.reviewer,
		config.system1,
		...(config.search ?? []),
		...(config.fetch ?? []),
	])
		if (feature && typeof feature === "object" && "auth" in feature && feature.auth)
			refs.add(feature.auth);
	if (config.appToken) refs.add(config.appToken);
	if (config.mail) {
		refs.add(config.mail.clientSecretAuth);
		refs.add(config.mail.sendAuth);
	}
	for (const type of [config.subagents?.worker, config.subagents?.computer]) {
		if (type !== undefined) refs.add(type.model.auth);
	}
	return refs;
}

// The configured auth refs that have no record in auth.jsonl — boot's
// warn sweep (a missing record fails loudly at first use today; name it
// at boot instead) and doctor's missing-keys line share this. Existence
// only — nothing resolves a secret here.
export function missingAuthNames(config: Config, has: (name: string) => boolean): string[] {
	return [...authReferences(config)].filter((name) => !has(name)).sort();
}
