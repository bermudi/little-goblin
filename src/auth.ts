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
import { basename } from "node:path";
import { z } from "zod";
import { paths } from "./config.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";

const recordSchema = z.object({
	name: z.string().min(1),
	value: z.string().min(1),
});

export interface AuthRecord {
	name: string;
	value: string;
	line: number; // 1-based line number in auth.jsonl
}

// parseAuthFile validates auth.jsonl's record shape and returns the
// records in file order — duplicates included; "last wins" is the
// caller's rule. Shared with scripts/check-auth.ts so the install-time
// poison scan parses exactly like the loader. `value` is secret
// material: callers may inspect its shape (literal vs `!command`) but
// must never print it.
export function parseAuthFile(raw: string): AuthRecord[] {
	const records: AuthRecord[] = [];
	for (const [i, line] of raw.split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Native parser messages can quote credentials; never keep them as a cause.
			throw new Error(`${paths.auth()}:${i + 1}: invalid JSON`);
		}
		const rec = recordSchema.safeParse(parsed);
		if (!rec.success) {
			const details = rec.error.issues.map((issue) => {
				const field = issue.path[0];
				return `${field === "name" || field === "value" ? field : "record"}: ${issue.code}`;
			});
			throw new Error(`${paths.auth()}:${i + 1}: invalid record — ${details.join("; ")}`);
		}
		records.push({ name: rec.data.name, value: rec.data.value, line: i + 1 });
	}
	return records;
}

// A `!` command that invokes pass-cli itself would run as the OWNER
// session — full account, no audit trail (DESIGN.md: Proton Pass).
// This is a lint, not a sandbox: `pass-cli` as a shell word at command
// position — start of the string or after whitespace/`;&|()"'`` —
// optionally path-prefixed like `/x/bin/pass-cli`, followed by a
// separator or end. Deliberately conservative: `echo pass-cli` trips it
// too — the fix is always "route through pass-keys".
export function invokesPassCliDirectly(command: string): boolean {
	return /(?:^|[\s;&|()"'`])(?:[^\s;&|()"'`/]*\/)*pass-cli(?:[\s;&|)"'`]|$)/.test(command);
}

// pass-keys command recognition, shared by the installer's options
// inspection (scripts/install-options.ts) and doctor's snapshot probe
// (src/health.ts): a `!` record whose FIRST word is `pass-keys` — bare
// or literal path-prefixed, identified by basename — is a recognized
// credential command. Everything else stays a general, unverified
// command. This is parsing only: these helpers never execute the
// command.
export function passKeysCommandExecutable(value: string): string | undefined {
	if (!value.startsWith("!")) return undefined;
	const executable = value.slice(1).match(/^[^\s;&|()"'`]+/)?.[0];
	if (executable?.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(executable ?? "")) {
		return undefined;
	}
	return executable !== undefined && basename(executable) === "pass-keys" ? executable : undefined;
}

// The one recognized record form: `!<pass-keys> get <profile> <KEY>`,
// a single direct command with two bare arguments — no shell
// operators, quotes, substitutions, env prefixes or wrappers. The
// executable word must be literal too: expansion, globbing or
// redirection characters would resolve a different command at exec
// time than the one preflight certified. The profile class is the
// doctor's auth-probe class; key names follow the vault's looser
// class (digit-leading names are real).
const PASS_KEYS_GET = /^ get ([a-z][a-z0-9_-]{0,63}) ([A-Za-z0-9_-]+)$/;
const NON_LITERAL_EXECUTABLE = /[$~\\*?[\]{}<>]/;
export function parsePassKeysGet(
	value: string,
): { executable: string; profile: string; key: string } | null {
	const executable = passKeysCommandExecutable(value);
	if (executable === undefined || NON_LITERAL_EXECUTABLE.test(executable)) return null;
	const match = PASS_KEYS_GET.exec(value.slice(1 + executable.length));
	if (match?.[1] === undefined || match[2] === undefined) return null;
	return { executable, profile: match[1], key: match[2] };
}

export interface AuthStore {
	// Resolve a named secret. Rejects if absent or if a `!command` fails —
	// callers handle "no such secret" as a configuration error at the
	// boundary that needs it. Async: `!command` resolution shells out and
	// must not block the event loop.
	resolve(name: string): Promise<string>;
	has(name: string): boolean;
	names(): string[];
}

// The write face only the composition root and the secrets route see —
// consumers typed AuthStore can read but never mutate.
export interface WritableAuthStore extends AuthStore {
	// Install a literal record into the live store: same last-wins rule
	// as a file append, and the resolve cache drops so a rotation takes
	// effect on the next call. Callers write the file FIRST — a put
	// without the append would vanish at restart.
	put(name: string, value: string): void;
	// Whether the record resolves through a `!command` — the secrets
	// route refuses to shadow one (a pass-keys ref is hand-managed).
	isCommand(name: string): boolean;
}

// One JSONL record appended — the file's append-only convention, and
// "last wins" on load makes an appended same-name record a rotation.
// A missing file is born 0600 regardless of umask; an existing one must
// already satisfy the loader's permission rule — a group/world-readable
// secrets file is refused here exactly like at boot.
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

// The same loader at an explicit path — the live drift check resolves
// through this instead of reading a secret env var; the path is the
// only thing its environment carries.
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

	// Any group/world bit means the secrets file leaks to other users —
	// refuse to load rather than warn and proceed.
	const mode = statSync(file).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(
			`${file}: insecure permissions ${mode.toString(8).padStart(4, "0")} — clear group/world bits (chmod 600)`,
		);
	}

	const poisoned = new Set<string>();
	for (const rec of parseAuthFile(raw)) {
		if (entries.has(rec.name)) {
			log.warn("auth.jsonl: duplicate secret name — last wins", {
				name: rec.name,
				line: rec.line,
			});
		}
		entries.set(rec.name, rec.value);
		// Poison, don't refuse the boot: the unit restarts forever and a
		// phone-only operator can't fix a crash loop — the feature needing
		// this key fails loud at resolve instead (DESIGN.md: Proton Pass).
		// "Last wins" applies to poison too: a clean override un-poisons.
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

// Runs through the shared bounded runner: a command that ignores SIGTERM is
// escalated to SIGKILL, and a spawned child holding the pipes open can't
// keep EOF pending past the drain window. An unbounded resolve would hang
// buildStep and wedge the conversation lane — /stop can't reach it.
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
