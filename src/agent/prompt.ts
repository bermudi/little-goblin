// System prompt assembly: shell + SOUL.md + optional AGENTS.md. Read fresh
// every turn — the operator or the agent itself may edit either file and
// the change is live on the next turn. No command, no restart.
//
// Cache stability: nothing here may vary turn-to-turn on its own (no
// clock, no counters) — the prompt is the head of the provider prefix
// cache, and any automatic change invalidates the whole thing. Operator
// edits are fine: they're explicit and logged as cache boundaries.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import type { Conversation } from "../conversation.ts";
import { formatSkillsSection, loadCatalog } from "./skills.ts";

// Last-seen content hash per prompt source, process-wide. An operator
// edit is a sanctioned cache boundary (DESIGN.md, Cache stability) — but
// it must be attributable: a "prompt source changed" line is what
// separates "the operator edited SOUL.md" from "a bug moved the head
// hash" when reading goblin.log. First sight primes silently; sources
// are global (not per conversation), so one edit logs once.
const lastSeen = new Map<string, string>();

function noteSource(source: string, content: string | null): void {
	const digest =
		content === null
			? "absent"
			: createHash("sha256").update(content).digest("hex").slice(0, 16);
	const prev = lastSeen.get(source);
	lastSeen.set(source, digest);
	if (prev === undefined || prev === digest) return;
	log.info("prompt source changed", { source, from: prev, to: digest });
}

// Test hook: forget the seen-source hashes — module state persists
// across tests; production never resets.
export function _resetPromptSourcesForTest(): void {
	lastSeen.clear();
}

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export function buildSystemPrompt(conv: Conversation): { text: string; sources: string[] } {
	const soul = readOptional(paths.soul());
	if (soul === null) {
		// Not a reason to fail the turn — but a deleted SOUL.md silently
		// swaps the bot's personality, and the log must explain that.
		log.warn("SOUL.md missing — default identity in use", {
			conversation: conv.id,
			path: paths.soul(),
		});
	}
	const agents = readOptional(paths.agents());
	// Rescanned every turn — a skill written or edited now is live next
	// message, like the prompt files above.
	const catalog = loadCatalog(paths.skills());
	const skillsSection = formatSkillsSection(catalog);
	noteSource("SOUL.md", soul);
	noteSource("AGENTS.md", agents);
	noteSource("skills", skillsSection.join("\n"));

	const text = [
		(soul ?? "You are goblin, a personal AI agent.").trim(),
		"",
		"## environment",
		"",
		`- You are talking to your operator on Telegram (${conv.id}).`,
		`- Working directory: ${paths.workspace()} — fixed, same for every chat.`,
		`- No clock: the current date/time is not in this prompt — run \`date\` via`,
		`  bash whenever it matters.`,
		`- Tools: read_file, write_file, edit_file, bash. Paths are relative to`,
		`  the working directory unless absolute.`,
		`- Telegram is the UI: messages are plain text/Markdown, media arrives as`,
		`  file paths or inline parts. Keep replies chat-sized; write files for`,
		`  anything long.`,
		`- SOUL.md in the workspace root is your identity; AGENTS.md is your own`,
		`  operating notes. You own both — edit them when who you are or how you`,
		`  work changes. Reads are fresh every turn: edits take effect next message.`,
		`- Irreversible or destructive actions (deleting data, force-anything)`,
		`  need an explicit go-ahead first.`,
		...(agents ? ["", "## AGENTS.md — your operating notes", "", agents.trim()] : []),
		"",
		...skillsSection,
	].join("\n");

	const sources = ["SOUL.md"];
	if (agents) sources.push("AGENTS.md");
	if (catalog.entries.length > 0 || catalog.skipped > 0) sources.push("skills");

	return { text, sources };
}
