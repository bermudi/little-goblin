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
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { paths } from "./config.ts";
import { log } from "./log.ts";

const recordSchema = z.object({
	name: z.string().min(1),
	value: z.string().min(1),
});

export interface AuthStore {
	// Resolve a named secret. Throws if absent — callers handle "no such
	// secret" as a configuration error at the boundary that needs it.
	resolve(name: string): string;
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
		entries.set(rec.data.name, rec.data.value);
	}
	return makeStore(entries);
}

function makeStore(entries: Map<string, string>): AuthStore {
	const cache = new Map<string, string>();
	return {
		has: (name) => entries.has(name),
		names: () => [...entries.keys()],
		resolve(name) {
			const cached = cache.get(name);
			if (cached !== undefined) return cached;
			const value = entries.get(name);
			if (value === undefined) {
				throw new Error(`auth.jsonl: no secret named "${name}"`);
			}
			const resolved = value.startsWith("!") ? resolveCommand(value.slice(1), name) : value;
			cache.set(name, resolved);
			return resolved;
		},
	};
}

function resolveCommand(command: string, name: string): string {
	const result = spawnSync("/bin/sh", ["-c", command], {
		encoding: "utf8",
		timeout: 15_000,
		env: process.env,
	});
	if (result.error) {
		throw new Error(`auth.jsonl: command for "${name}" failed — ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`auth.jsonl: command for "${name}" exited ${result.status}: ${result.stderr.trim()}`,
		);
	}
	const out = result.stdout.trim();
	if (out === "") {
		throw new Error(`auth.jsonl: command for "${name}" produced no output`);
	}
	return out;
}
