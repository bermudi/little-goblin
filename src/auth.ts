// auth.jsonl — secrets live here, never in env (the agent's bash tool
// inherits the process environment, and env vars leak).
// One record per line:
//   {"name": "openrouter", "value": "!pass show api/openrouter"}
// A value is a literal credential or `!<command>` — resolved by
// executing it and reading stdout, lazily at point of use, in-process.
// Resolved values never enter the tool environment, the model context,
// or logs — this module must never log one.

import {
	closeSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeSync,
} from "node:fs";
import {
	invokesPassCliDirectly,
	parseAuthRecords,
	type AuthRecord,
} from "./auth-parse.ts";
import { paths } from "./config.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

// The record grammar lives in ./auth-parse.ts — dependency-free so the
// pre-install poison scan parses exactly like this loader before
// node_modules exists. Re-exported so existing importers keep one door.
export { invokesPassCliDirectly, passKeysCommandExecutable, parsePassKeysGet } from "./auth-parse.ts";
export type { AuthRecord } from "./auth-parse.ts";

// The configured auth file's records — the same as parseAuthRecords
// with paths.auth() named in errors. Callers with an explicit file use
// parseAuthRecords directly so the message names the real path.
export function parseAuthFile(raw: string): AuthRecord[] {
	return parseAuthRecords(raw, paths.auth());
}

export interface AuthStore {
	// Rejects if absent or if a `!command` fails — callers map "no such
	// secret" to a configuration error.
	resolve(name: string): Promise<string>;
	has(name: string): boolean;
	names(): string[];
}

// Write face for the composition root and the secrets route —
// AuthStore-typed consumers can read but never mutate.
export interface WritableAuthStore extends AuthStore {
	// Callers write the file FIRST — a put without the append vanishes
	// at restart. Drops the resolve cache so a rotation takes effect
	// on the next call.
	put(name: string, value: string): void;
	// `!command` records — the secrets route refuses to shadow one (a
	// pass-keys ref is hand-managed).
	isCommand(name: string): boolean;
}

// Last-wins on load makes an appended same-name record a rotation. A
// missing file is born 0600 regardless of umask; an existing one must
// already satisfy the loader's permission rule — group/world-readable
// is refused here exactly like at boot.
export function appendAuthRecord(file: string, name: string, value: string): void {
	const line = `${JSON.stringify({ name, value })}\n`;
	let fd = -1;
	try {
		try {
			fd = openSync(file, "wx+", 0o600);
			fchmodSync(fd, 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			fd = openSync(file, "a+");
		}
		const { mode: fileMode, size } = fstatSync(fd);
		const mode = fileMode & 0o777;
		if ((mode & 0o077) !== 0) {
			throw new Error(
				`${file}: insecure permissions ${mode.toString(8).padStart(4, "0")} — clear group/world bits (chmod 600)`,
			);
		}
		// A valid final JSONL record need not have a newline yet.
		const last = Buffer.alloc(1);
		if (size > 0 && readSync(fd, last, 0, 1, size - 1) !== 1) {
			throw new Error(`${file}: could not read final byte before appending`);
		}
		const buf = Buffer.from(`${size > 0 && last[0] !== 0x0a ? "\n" : ""}${line}`, "utf8");
		let off = 0;
		while (off < buf.length) off += writeSync(fd, buf, off);
		fsyncSync(fd);
	} finally {
		if (fd >= 0) closeSync(fd);
	}
}

export function loadAuth(): WritableAuthStore {
	return loadAuthFile(paths.auth());
}

// The live drift check resolves through an explicit path instead of a
// secret env var; the path is all its environment carries.
export function loadAuthFile(file: string): WritableAuthStore {
	const entries = new Map<string, string>();
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log.warn("auth.jsonl not found — no secrets available", { path: file });
			return makeStore(entries, new Set());
		}
		throw err;
	}

	// Refuse rather than warn-and-proceed — a group/world bit leaks the
	// secrets file to other users.
	const mode = statSync(file).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(
			`${file}: insecure permissions ${mode.toString(8).padStart(4, "0")} — clear group/world bits (chmod 600)`,
		);
	}

	const poisoned = new Set<string>();
	for (const rec of parseAuthRecords(raw, file)) {
		if (entries.has(rec.name)) {
			log.warn("auth.jsonl: duplicate secret name — last wins", {
				name: rec.name,
				line: rec.line,
			});
		}
		entries.set(rec.name, rec.value);
		// Poison, don't refuse the boot: the unit restarts forever and a
		// phone-only operator can't fix a crash loop — the feature fails
		// loud at resolve instead. Last-wins applies to poison: a clean
		// override un-poisons.
		if (rec.value.startsWith("!") && invokesPassCliDirectly(rec.value.slice(1))) {
			poisoned.add(rec.name);
			log.error(
				"auth.jsonl: secret invokes pass-cli directly — it would run as the owner session; route it through pass-keys (DESIGN.md: Proton Pass)",
				undefined,
				{ name: rec.name, line: rec.line },
			);
		} else {
			poisoned.delete(rec.name);
		}
	}
	return makeStore(entries, poisoned);
}

function makeStore(entries: Map<string, string>, poisoned: Set<string>): WritableAuthStore {
	// Promises are cached, not values: concurrent resolves share one
	// `!command` execution, and a rejection evicts itself so a transient
	// failure can be retried.
	const cache = new Map<string, Promise<string>>();
	return {
		has: (name) => entries.has(name),
		names: () => [...entries.keys()],
		put(name, value) {
			entries.set(name, value);
			cache.delete(name);
			// A literal put can only un-poison — command records never
			// enter through this path (the writer takes literals only).
			poisoned.delete(name);
		},
		isCommand: (name) => entries.get(name)?.startsWith("!") ?? false,
		resolve(name) {
			const cached = cache.get(name);
			if (cached !== undefined) return cached;
			const value = entries.get(name);
			if (value === undefined) {
				return Promise.reject(new Error(`auth.jsonl: no secret named "${name}"`));
			}
			// Poisoned records reject without ever spawning their command.
			const resolved = poisoned.has(name)
				? Promise.reject(
						new Error(
							`auth.jsonl: "${name}" invokes pass-cli directly — that runs as the owner session; route it through pass-keys (DESIGN.md: Proton Pass)`,
						),
					)
				: value.startsWith("!")
					? resolveCommand(value.slice(1), name)
					: Promise.resolve(value);
			cache.set(name, resolved);
			resolved.catch(() => cache.delete(name));
			return resolved;
		},
	};
}

const RESOLVE_TIMEOUT_MS = 15_000;
// A secret is a line of text. Far more means the command is wrong — cap it
// rather than buffering a flood.
const MAX_OUTPUT = 64 * 1024;

// An unbounded resolve would hang buildStep and wedge the conversation
// lane — /stop can't reach it.
async function resolveCommand(command: string, name: string): Promise<string> {
	let proc: Bun.ReadableSubprocess;
	try {
		proc = spawnProc(["/bin/sh", "-c", command]);
	} catch (err) {
		throw new Error(
			`auth.jsonl: command for "${name}" failed to spawn — ${(err as Error).message}`,
		);
	}
	const result = await boundedRun(proc, {
		timeoutMs: RESOLVE_TIMEOUT_MS,
		maxOutput: MAX_OUTPUT,
	});
	if (result.timedOut) {
		throw new Error(`auth.jsonl: command for "${name}" timed out after ${RESOLVE_TIMEOUT_MS}ms`);
	}
	if (result.truncated) {
		// Cut or capped output may be an incomplete credential — refuse
		// rather than fail downstream confusingly.
		throw new Error(`auth.jsonl: command for "${name}" produced oversized or cut-off output`);
	}
	if (result.exitCode !== 0) {
		// stderr stays out of the error — a failing credential command can
		// echo the secret it was fed, and errors travel to logs and the
		// model context.
		throw new Error(`auth.jsonl: command for "${name}" exited ${result.exitCode}`);
	}
	const out = result.stdout.trim();
	if (out === "") {
		throw new Error(`auth.jsonl: command for "${name}" produced no output`);
	}
	return out;
}
