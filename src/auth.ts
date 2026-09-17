// auth.jsonl — secrets live here, never in env (the agent's bash tool
// inherits the process environment, and env vars leak).
//
// One record per line:
//   {"name": "openrouter", "value": "!pass show api/openrouter"}
//
// A value is a literal credential or `!<command>` — resolved by executing
// the command and reading stdout, lazily at the point of use, in-process.
// Resolved values never enter the tool environment, the model context, or
// logs. This module must never log a resolved value.

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { paths } from "./config.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

const recordSchema = z.object({
	name: z.string().min(1),
	value: z.string().min(1),
});

export interface AuthStore {
	// Resolve a named secret. Rejects if absent or if a `!command` fails —
	// callers handle "no such secret" as a configuration error at the
	// boundary that needs it. Async: `!command` resolution shells out and
	// must not block the event loop.
	resolve(name: string): Promise<string>;
	has(name: string): boolean;
	names(): string[];
}

export function loadAuth(): AuthStore {
	const entries = new Map<string, string>();
	let raw: string;
	try {
		raw = readFileSync(paths.auth(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log.warn("auth.jsonl not found — no secrets available", { path: paths.auth() });
			return makeStore(entries);
		}
		throw err;
	}

	// Any group/world bit means the secrets file leaks to other users —
	// refuse to load rather than warn and proceed.
	const mode = statSync(paths.auth()).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(
			`${paths.auth()}: insecure permissions ${mode.toString(8).padStart(4, "0")} — clear group/world bits (chmod 600)`,
		);
	}

	for (const [i, line] of raw.split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			throw new Error(`${paths.auth()}:${i + 1}: invalid JSON — ${(err as Error).message}`);
		}
		const rec = recordSchema.safeParse(parsed);
		if (!rec.success) {
			throw new Error(`${paths.auth()}:${i + 1}: ${z.prettifyError(rec.error)}`);
		}
		if (entries.has(rec.data.name)) {
			log.warn("auth.jsonl: duplicate secret name — last wins", {
				name: rec.data.name,
				line: i + 1,
			});
		}
		entries.set(rec.data.name, rec.data.value);
	}
	return makeStore(entries);
}

function makeStore(entries: Map<string, string>): AuthStore {
	// Promises are cached, not values: concurrent resolves share one
	// `!command` execution, and a rejection evicts itself so a transient
	// failure can be retried.
	const cache = new Map<string, Promise<string>>();
	return {
		has: (name) => entries.has(name),
		names: () => [...entries.keys()],
		resolve(name) {
			const cached = cache.get(name);
			if (cached !== undefined) return cached;
			const value = entries.get(name);
			if (value === undefined) {
				return Promise.reject(new Error(`auth.jsonl: no secret named "${name}"`));
			}
			const resolved = value.startsWith("!")
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

// Runs through the shared bounded runner: a command that ignores SIGTERM is
// escalated to SIGKILL, and a spawned child holding the pipes open can't
// keep EOF pending past the drain window. An unbounded resolve would hang
// buildStep and wedge the conversation lane — /stop can't reach it.
async function resolveCommand(command: string, name: string): Promise<string> {
	let proc: Bun.ReadableSubprocess;
	try {
		proc = spawnProc(["/bin/sh", "-c", command]);
	} catch (err) {
		throw new Error(`auth.jsonl: command for "${name}" failed to spawn — ${(err as Error).message}`);
	}
	const result = await boundedRun(proc, {
		timeoutMs: RESOLVE_TIMEOUT_MS,
		maxOutput: MAX_OUTPUT,
	});
	if (result.timedOut) {
		throw new Error(`auth.jsonl: command for "${name}" timed out after ${RESOLVE_TIMEOUT_MS}ms`);
	}
	if (result.truncated) {
		// Cut or capped output may be an incomplete credential — a wrong
		// secret fails downstream confusingly, so refuse it here.
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
