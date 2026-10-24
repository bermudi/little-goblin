// The auth.jsonl record grammar — shared by the loader (src/auth.ts),
// the health probe (src/health.ts), the installer option scan
// (scripts/install-options.ts) and the pre-install poison gate
// (scripts/check-auth.ts). This leaf stays dependency-free on purpose:
// check-auth runs BEFORE `bun install` on a fresh checkout, so nothing
// here may reach node_modules — node builtins only.

import { basename, join } from "node:path";
import { goblinHome } from "./goblin-home.ts";

// The configured auth.jsonl — duplicated nowhere: paths.auth() in
// config.ts delegates here, and the install gate reads the same path
// without pulling in the config module's json5/zod chain.
export function authFile(): string {
	return join(goblinHome(), "auth.jsonl");
}

export interface AuthRecord {
	name: string;
	value: string;
	line: number; // 1-based line number in auth.jsonl
}

// Hand-rolled equivalent of the loader's record shape — name and value
// are non-empty strings, extra keys strip — emitting zod's issue codes
// ("invalid_type"/"too_small") so every consumer's message stays
// identical whether or not dependencies are installed.
function recordIssues(parsed: unknown): string[] {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return ["record: invalid_type"];
	}
	const issues: string[] = [];
	for (const field of ["name", "value"] as const) {
		const v = (parsed as Record<string, unknown>)[field];
		if (typeof v !== "string") issues.push(`${field}: invalid_type`);
		else if (v === "") issues.push(`${field}: too_small`);
	}
	return issues;
}

// Duplicates included — "last wins" is the caller's rule. Shared with
// scripts/check-auth.ts so the install-time poison scan parses exactly
// like the loader. `value` is secret material: callers may inspect its
// shape (literal vs `!command`) but must never print it, and parse
// errors name the file and line, never the content.
export function parseAuthRecords(raw: string, file: string): AuthRecord[] {
	const records: AuthRecord[] = [];
	for (const [i, line] of raw.split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Native parser messages can quote credentials; never keep them as a cause.
			throw new Error(`${file}:${i + 1}: invalid JSON`);
		}
		const issues = recordIssues(parsed);
		if (issues.length > 0) {
			throw new Error(`${file}:${i + 1}: invalid record — ${issues.join("; ")}`);
		}
		const rec = parsed as { name: string; value: string };
		records.push({ name: rec.name, value: rec.value, line: i + 1 });
	}
	return records;
}

// A `!` command invoking pass-cli would run as the OWNER session —
// full account, no audit trail. A lint, not a sandbox: `pass-cli` at
// command word position, optionally path-prefixed. Deliberately
// conservative — `echo pass-cli` trips it too; the fix is always
// "route through pass-keys".
export function invokesPassCliDirectly(command: string): boolean {
	return /(?:^|[\s;&|()"'`])(?:[^\s;&|()"'`/]*\/)*pass-cli(?:[\s;&|)"'`]|$)/.test(command);
}

// Shared by scripts/install-options.ts and src/health.ts: a `!`
// record whose FIRST word is `pass-keys` (literal or path-prefixed,
// by basename) is a recognized credential command; everything else
// stays a general unverified command. Parsing only — never executes
// the command.
export function passKeysCommandExecutable(value: string): string | undefined {
	if (!value.startsWith("!")) return undefined;
	const executable = value.slice(1).match(/^[^\s;&|()"'`]+/)?.[0];
	if (executable?.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(executable ?? "")) {
		return undefined;
	}
	return executable !== undefined && basename(executable) === "pass-keys" ? executable : undefined;
}

// The one recognized record form: `!<pass-keys> get <profile> <KEY>`
// — two bare arguments, no shell operators, quotes, substitutions or
// wrappers. The executable word must be literal too: expansion or
// glob characters would resolve a different command at exec time than
// the one preflight certified. The profile class is the doctor's
// auth-probe class; key names follow the vault's looser class
// (digit-leading names are real).
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
