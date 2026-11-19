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

// The interim T3 Code transport (issue #607/#608) is itself retired:
// `delegate` runs on Herdr panes again (issue #728). Its config shapes
// fail loud naming the fix — never silently dropped, so a stale block
// cannot boot a goblin with no delegate tool and no hint why.
function retiredDelegationKey(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const delegation = (raw as Record<string, unknown>).delegation;
	if (typeof delegation !== "object" || delegation === null || Array.isArray(delegation)) {
		return null;
	}
	const d = delegation as Record<string, unknown>;
	if (Object.hasOwn(d, "machines")) {
		return "delegation.machines was removed — delegation runs on goblin's local herdr session only; delete the block (issue #728)";
	}
	const harnesses = d.harnesses;
	if (typeof harnesses === "object" && harnesses !== null && !Array.isArray(harnesses)) {
		for (const [name, h] of Object.entries(harnesses)) {
			if (
				typeof h === "object" &&
				h !== null &&
				!Array.isArray(h) &&
				("provider" in h || "model" in h || "options" in h)
			) {
				return `delegation.harnesses.${name} uses the retired T3 Code shape {provider, model, options?} — rewrite it as {kind, args?, askFirst?} for Herdr (issue #728)`;
			}
		}
	}
	return null;
}

function parseConfigText(raw: string): unknown {
	try {
		return JSON5.parse(raw);
	} catch (err) {
		throw configSyntaxError(err);
	}
}

// Disk-facing parses: parseConfigFile takes JSON5 text;
// parseConfigValue takes an already-parsed object for callers that
// separate syntax errors from schema errors (the doctor probe reports
// JSON5 location per its own category contract).
export function parseConfigFile(raw: string): Config {
	return parseConfigValue(parseConfigText(raw), raw);
}

export function parseConfigValue(raw: unknown, sourceText?: string): Config {
	return parseConfig(raw, sourceText);
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
		return parseConfigFile(raw);
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

// The line a key name occupies in the file — a locator, never the name:
// an unrecognized key can carry an operator's private identifier or a
// pasted secret, so errors report positions only. Repeated names report
// every candidate line rather than guessing.
function unrecognizedKeyLines(sourceText: string, key: string): number[] {
	const re = new RegExp(
		`^\\s*(?:"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*:`,
	);
	const lines: number[] = [];
	sourceText.split("\n").forEach((line, i) => {
		if (re.test(line)) lines.push(i + 1);
	});
	return lines;
}

// The Pi Durable runtime is gone (issue #609): a `subagents` block —
// top-level or parked — fails loud and names its replacement, so an
// old config can't boot a goblin with no subagent tools and no hint
// why. Checked before strict validation because the key is no longer
// in the schema at all.
function retiredSubagentsKey(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	if (Object.hasOwn(rec, "subagents")) return "subagents";
	const parked = rec.parked;
	if (
		typeof parked === "object" &&
		parked !== null &&
		!Array.isArray(parked) &&
		Object.hasOwn(parked, "subagents")
	)
		return "parked.subagents";
	return null;
}

// Unknown keys anywhere in the object are rejected, not stripped: a typo
// must fail loudly at load rather than disappear on the next save.
export function parseConfig(raw: unknown, sourceText?: string): Config {
	const retired = retiredSubagentsKey(raw);
	if (retired !== null) {
		throw new ConfigValidationError(
			`${paths.config()}: ${retired} was removed — native subagents replaced it: use the agent tool and its agent types (the computer type for desktops); delete the block (design/agents.md)`,
		);
	}
	const retiredDelegation = retiredDelegationKey(raw);
	if (retiredDelegation !== null) {
		throw new ConfigValidationError(`${paths.config()}: ${retiredDelegation}`);
	}
	const result = configSchema.safeParse(raw);
	if (!result.success) {
		// Nested record keys and issue messages may contain input. Report only
		// schema-owned top-level fields and categories, not the ZodError itself.
		const details = result.error.issues.map((issue) => {
			const field = issue.path[0];
			const safeField =
				typeof field === "string" && Object.hasOwn(configSchema.in.shape, field) ? field : "config";
			if (issue.code === "unrecognized_keys" && sourceText !== undefined && "keys" in issue) {
				const lines = [
					...new Set(issue.keys.flatMap((k) => unrecognizedKeyLines(sourceText, k))),
				].sort((a, b) => a - b);
				if (lines.length > 0) {
					return `${safeField}: unrecognized_keys at ${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}`;
				}
			}
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
	return refs;
}

// The configured auth refs that have no record in auth.jsonl — boot's
// warn sweep (a missing record fails loudly at first use today; name it
// at boot instead) and doctor's missing-keys line share this. Existence
// only — nothing resolves a secret here.
export function missingAuthNames(config: Config, has: (name: string) => boolean): string[] {
	return [...authReferences(config)].filter((name) => !has(name)).sort();
}

// The placeholder operator id shipped in goblin.json5.example. A config
// that still holds it almost certainly never replaced the example — the
// access gate then refuses the real owner. Boot and doctor name it; the
// schema still accepts it (a real id could in principle collide, so the
// refusal stays the only hard gate).
export const EXAMPLE_OPERATOR_ID = 123456789;

export function warnOnExampleOperator(config: Config): void {
	if (!config.operators.includes(EXAMPLE_OPERATOR_ID)) return;
	log.warn(
		"operators still holds the shipped example Telegram id — the bot will refuse its own owner; set your real id in Settings → operators",
		{ exampleId: EXAMPLE_OPERATOR_ID },
	);
}
