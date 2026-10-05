// Pre-seed harness first-run gates for a delegation launch
// (design/delegation.md — "First-run gates"). Harnesses gate on
// dialogs that no-approval flags don't bypass, and the launcher's
// plain shell doesn't carry the operator's alias flags — so the
// launcher's kind is consulted and the corresponding state file gets
// its "already accepted" markers before the agent starts. The
// alternative — scripting answers into the pane — hides a consent
// dialog from the operator; seeding makes explicit what a keypress
// would hide.
//
// Preservation rule: these are the operator's own config files —
// the same ones a hand-edit or a stitch-managed dotfile produced —
// so a launch may add flags but never change or delete what the
// operator wrote, and a file we can't extend safely fails the
// launch loudly rather than corrupt it.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { durableWriteFile } from "./durable.ts";

// Returns a short description of what was seeded (for the launch
// log line) — [] means nothing to do or kind has no known gates.
// A corrupt or unextendable state file throws: failing the launch
// loudly beats silently losing the delegation.
export function seedHarnessTrust(kind: string, cwd: string, homeDir: string): string[] {
	switch (kind) {
		case "claude":
			return seedClaude(cwd, join(homeDir, ".claude.json"));
		case "codex":
			return seedCodex(cwd, join(homeDir, ".codex", "config.toml"));
		default:
			return [];
	}
}

// The settings file may be a symlink (stitch-managed dots); writing
// through the symlink path replaces it with a regular file and forks
// the config. Resolve to the managed target first — a missing file
// resolves to itself and is created at the given path.
function managedPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
		throw err;
	}
}

// ---------- claude: ~/.claude.json ----------

// Claude's own writer replaces this file wholesale on exit (it holds
// install counters, oauth state, tipsShown…), so JSON.parse→stringify
// preserves semantics exactly like claude's own saves do. The gates
// are write-if-absent only: an explicit false is the operator's
// answer to that dialog, and flipping it re-asks nothing — it
// forges consent they recorded refusing.
function seedClaude(cwd: string, file: string): string[] {
	const path = managedPath(file);
	const doc = readJsonObject(path, ".claude.json");
	const set: string[] = [];

	const ensure = (obj: Record<string, unknown>, key: string): void => {
		if (!(key in obj)) {
			obj[key] = true;
			set.push(key);
		}
	};

	ensure(doc, "bypassPermissionsModeAccepted");
	ensure(doc, "hasCompletedOnboarding");

	if (doc.projects !== undefined && !isRecord(doc.projects)) {
		throw new Error(`${path}: 'projects' is not an object — refusing to overwrite`);
	}
	const projects: Record<string, unknown> = doc.projects ?? {};
	doc.projects = projects;
	let entry = projects[cwd];
	if (entry === undefined) {
		entry = {};
		projects[cwd] = entry;
	}
	if (!isRecord(entry)) {
		throw new Error(`${path}: projects entry for ${cwd} is not an object — refusing to overwrite`);
	}
	const before = set.length;
	ensure(entry, "hasTrustDialogAccepted");
	ensure(entry, "hasCompletedProjectOnboarding");
	const touchedProject = set.length > before;

	if (set.length === 0) return [];
	mkdirSync(dirname(path), { recursive: true });
	// 0600 when creating — the file can carry machine identity/oauth.
	durableWriteFile(path, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
	return touchedProject ? [...set, `project ${cwd}`] : set;
}

// ---------- codex: ~/.codex/config.toml ----------

// TOML survives only as text: Bun.TOML.parse validates the file and
// answers "is the entry already trusted?", but a parse→stringify
// round-trip would lose comments and reorder tables — the operator's
// file, not ours to reformat. The write is one line inserted at a
// location the grammar guarantees lands in the right scope: after the
// table's own `[projects."<cwd>"]` header, after its last
// `projects."<cwd>".` dotted key, or as a fresh appended section when
// no entry exists. Anything else — inline tables, forms we can't
// locate — is refused, not rewritten.
function seedCodex(cwd: string, file: string): string[] {
	const path = managedPath(file);
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	let parsed: unknown;
	try {
		parsed = text.trim() === "" ? {} : Bun.TOML.parse(text);
	} catch (err) {
		throw new Error(
			`${path}: invalid TOML — fix by hand before delegating (${err instanceof Error ? err.message : String(err)})`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(`${path}: expected a TOML table at the root — refusing to write`);
	}

	const projects = parsed.projects;
	if (projects !== undefined && !isRecord(projects)) {
		throw new Error(`${path}: 'projects' is not a table — refusing to write`);
	}
	const entry = isRecord(projects) ? projects[cwd] : undefined;
	if (entry !== undefined && !isRecord(entry)) {
		throw new Error(`${path}: projects entry for ${cwd} is not a table — refusing to write`);
	}
	// A trust_level the operator set — including "untrusted" — stands.
	if (isRecord(entry) && entry.trust_level !== undefined) return [];

	const lines = text.split("\n");
	// The key may appear as "escaped" (basic) or 'raw' (literal) — a cwd
	// containing a single quote or a control character only has the
	// basic form.
	const basic = tomlBasic(cwd);
	const quoted = cwd.includes("'")
		? reEscape(basic)
		: `(?:${reEscape(basic)}|'${reEscape(cwd)}')`;

	const out =
		entry !== undefined
			? insertIntoExisting(lines, quoted, basic, cwd, path)
			: appendProjectTable(lines, text, quoted, basic, cwd, path);

	mkdirSync(dirname(path), { recursive: true });
	durableWriteFile(path, out);
	return [`dir trust ${cwd}`];
}

// The entry exists but carries no trust_level — extend it in place.
function insertIntoExisting(
	lines: string[],
	quoted: string,
	basic: string,
	cwd: string,
	path: string,
): string {
	const header = new RegExp(
		`^\\s*\\[\\s*projects\\s*\\.\\s*${quoted}\\s*\\]`,
	);
	for (const [i, line] of lines.entries()) {
		if (header.test(line)) {
			lines.splice(i + 1, 0, 'trust_level = "trusted"');
			return lines.join("\n");
		}
	}
	// Defined by root-level dotted keys — a dotted line after the
	// last one inherits the same scope. That scope is root only when
	// no [table] header precedes the match: under a header the
	// inserted key would land in that table
	// (other.projects."<cwd>".trust_level) with the file still valid
	// TOML — root trust unset, no error anywhere. Refuse instead.
	// (A multi-line string holding a "["-leading line also refuses —
	// the wrong side of that mistake is loud, not silent.)
	const dotted = new RegExp(`^\\s*projects\\s*\\.\\s*${quoted}\\s*\\.`);
	let last = -1;
	for (const [i, line] of lines.entries()) if (dotted.test(line)) last = i;
	if (last >= 0) {
		if (lines.slice(0, last).some((line) => /^\s*\[/.test(line))) {
			throw new Error(
				`${path}: projects entry for ${cwd} exists in a form that can't be extended safely — set trust_level by hand`,
			);
		}
		lines.splice(last + 1, 0, `projects.${basic}.trust_level = "trusted"`);
		return lines.join("\n");
	}
	throw new Error(
		`${path}: projects entry for ${cwd} exists in a form that can't be extended safely — set trust_level by hand`,
	);
}

// No entry: a new [projects."<cwd>"] section appended at EOF is a
// fresh table — legal under every way `projects` was declared except
// the root inline-table form, which no appended text can extend.
function appendProjectTable(
	lines: string[],
	text: string,
	quoted: string,
	basic: string,
	cwd: string,
	path: string,
): string {
	if (/^\s*projects\s*=\s*\{/m.test(text)) {
		throw new Error(
			`${path}: 'projects' is an inline table — add trust_level for ${cwd} by hand`,
		);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	lines.push(`[projects.${basic}]`, 'trust_level = "trusted"', "");
	return lines.join("\n");
}

const TOML_ESCAPES: Record<string, string> = {
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
	'"': '\\"',
	"\\": "\\\\",
};

// TOML basic strings must escape the quote, backslash, and every
// control character — a cwd named with a newline or tab still yields
// a valid key, and the escaped form is what on-disk matching finds.
function tomlBasic(s: string): string {
	return `"${s.replace(/[\\"\x00-\x1f\x7f]/g, (c) =>
		TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function reEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let doc: unknown;
	try {
		doc = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(
			`${path}: invalid JSON — fix by hand before delegating (${err instanceof Error ? err.message : String(err)})`,
		);
	}
	if (!isRecord(doc)) {
		throw new Error(`${path}: ${label} is not a JSON object — refusing to write`);
	}
	return doc;
}
