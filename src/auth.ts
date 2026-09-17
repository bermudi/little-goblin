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

	const mode = statSync(paths.auth()).mode & 0o777;
	if (mode !== 0o600) {
		log.warn("auth.jsonl should be mode 0600", { path: paths.auth(), mode: mode.toString(8) });
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

async function resolveCommand(command: string, name: string): Promise<string> {
	let proc: Bun.ReadableSubprocess;
	try {
		proc = Bun.spawn(["/bin/sh", "-c", command], {
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		throw new Error(`auth.jsonl: command for "${name}" failed to spawn — ${(err as Error).message}`);
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, RESOLVE_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (timedOut) {
			throw new Error(`auth.jsonl: command for "${name}" timed out after ${RESOLVE_TIMEOUT_MS}ms`);
		}
		if (exitCode !== 0) {
			throw new Error(`auth.jsonl: command for "${name}" exited ${exitCode}: ${stderr.trim()}`);
		}
		const out = stdout.trim();
		if (out === "") {
			throw new Error(`auth.jsonl: command for "${name}" produced no output`);
		}
		return out;
	} finally {
		clearTimeout(timer);
	}
}
