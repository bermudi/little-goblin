// Harness trust seeding (DESIGN.md, "Delegation" — startup dialogs are
// the known trap). A delegated agent launches full-auto inside the
// operator's shell, where first-run dialogs park the pane before the
// prompt ever lands: claude's bypass disclaimer and per-directory
// trust prompt, codex's directory trust. Launch seeds each harness's
// own state files so the gates never appear — keyed on the herdr
// `kind` because the gate belongs to the binary, not our harness name.
//
// Two rules keep this safe against the operator's own files: only
// ever SET acceptance flags — an explicit value he wrote stands,
// untouched — and every write goes through durableWriteFile so a
// crash can't tear the file. A corrupt file throws: the launch fails
// loud rather than silently delegating into a broken state dir.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { durableWriteFile } from "./durable.ts";

/** Seed first-run gates for `kind` in `home` ahead of a launch into
 *  `cwd`. Returns what was ensured (for the launch log line); an
 *  empty list means no recipe exists for this kind. Throws with
 *  context on unreadable/corrupt state — callers fail the launch. */
export function seedHarnessTrust(kind: string, cwd: string, home: string): string[] {
	switch (kind) {
		case "claude":
			return seedClaude(cwd, join(home, ".claude.json"));
		case "codex":
			return seedCodex(cwd, join(home, ".codex", "config.toml"));
		default:
			return [];
	}
}

// claude — one JSON state file. `bypassPermissionsModeAccepted` kills
// the --dangerously-skip-permissions disclaimer machine-wide;
// `projects["<cwd>"].hasTrustDialogAccepted` kills the per-directory
// trust prompt. `hasCompletedOnboarding`/`…ProjectOnboarding` head off
// the remaining first-run wizards. Verified against claude 2.1.211.
function seedClaude(cwd: string, path: string): string[] {
	let doc: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${path} is not a JSON object`);
		}
		doc = parsed as Record<string, unknown>;
	}
	doc.bypassPermissionsModeAccepted = true;
	doc.hasCompletedOnboarding = true;
	const proj = recordEntry(recordEntry(doc, "projects", path), cwd, path);
	proj.hasTrustDialogAccepted = true;
	proj.hasCompletedProjectOnboarding = true;
	durableWriteFile(path, `${JSON.stringify(doc, null, "\t")}\n`, 0o600);
	return ["claude bypass disclaimer", `claude dir trust ${cwd}`];
}

function recordEntry(
	obj: Record<string, unknown>,
	key: string,
	path: string,
): Record<string, unknown> {
	const v = obj[key];
	if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
		throw new Error(`${path}: ${key} is not an object`);
	}
	return (obj[key] ??= {}) as Record<string, unknown>;
}

// codex — config.toml `[projects."<cwd>"] trust_level = "trusted"`.
// Text surgery, not a parse-and-rewrite: the file is hand-maintained
// and comments must survive. A section that already carries
// trust_level — any value — is the operator's call; leave it.
function seedCodex(cwd: string, path: string): string[] {
	const header = `[projects."${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
	const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
	const idx = lines.findIndex((l) => l.trim() === header);
	if (idx === -1) {
		const out = [...lines];
		if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
		out.push(header, 'trust_level = "trusted"');
		mkdirSync(dirname(path), { recursive: true });
		durableWriteFile(path, out.join("\n"));
		return [`codex dir trust ${cwd}`];
	}
	// Section exists — scan its body (up to the next header) for a
	// trust_level the operator already set.
	let end = idx + 1;
	while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) end++;
	if (lines.slice(idx + 1, end).some((l) => /^\s*trust_level\s*=/.test(l))) return [];
	lines.splice(idx + 1, 0, 'trust_level = "trusted"');
	durableWriteFile(path, lines.join("\n"));
	return [`codex dir trust ${cwd}`];
}
