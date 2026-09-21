// System prompt assembly: shell + tool list + SOUL.md + optional
// AGENTS.md/USER.md (each capped — see readCapped). Read fresh
// every turn — the operator or the agent itself may edit either file and
// the change is live on the next turn. No command, no restart.
// The tool list comes from the caller (tools/mod.ts's toolNames):
// availability is deployment-config state, and config only changes by
// operator action — a sanctioned cache boundary like any other edit.
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

// First-boot ceiling on any injected workspace file. The files are
// meant to stay small; a runaway AGENTS.md must not silently eat the
// prompt head (and the cache) every turn — it truncates with an
// in-prompt notice and a warn line instead.
const MAX_PROMPT_FILE_CHARS = 8_000;

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

// Read a workspace file for injection, capped. Truncation is a warn —
// "why does the bot ignore half my notes" must not need a REPL.
function readCapped(source: string, path: string): string | null {
	const content = readOptional(path);
	if (content === null || content.length <= MAX_PROMPT_FILE_CHARS) return content;
	log.warn("prompt file truncated", {
		file: source,
		chars: content.length,
		cap: MAX_PROMPT_FILE_CHARS,
	});
	return `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n\n… (${source} truncated at ${MAX_PROMPT_FILE_CHARS} chars — read the file for the rest)`;
}

export function buildSystemPrompt(
	conv: Conversation,
	tools: readonly string[],
): { text: string; sources: string[] } {
	const soul = readCapped("SOUL.md", paths.soul());
	if (soul === null) {
		// Not a reason to fail the turn — but a deleted SOUL.md silently
		// swaps the bot's personality, and the log must explain that.
		log.warn("SOUL.md missing — default identity in use", {
			conversation: conv.id,
			path: paths.soul(),
		});
	}
	const agents = readCapped("AGENTS.md", paths.agents());
	const user = readCapped("USER.md", paths.user());
	// Rescanned every turn — a skill written or edited now is live next
	// message, like the prompt files above.
	const catalog = loadCatalog(paths.skills());
	const skillsSection = formatSkillsSection(catalog);
	noteSource("SOUL.md", soul);
	noteSource("AGENTS.md", agents);
	noteSource("USER.md", user);
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
		`- Tools: ${tools.join(", ")}. Paths are relative to the working`,
		`  directory unless absolute.`,
		...(tools.includes("schedule")
			? [
					`- schedule manages standing jobs — natural-language prompts on a`,
					`  cron, replies landing in this chat; create one only when`,
					`  explicitly asked.`,
			]
			: []),
		`- Telegram is the UI: messages are plain text/Markdown, media arrives as`,
		`  file paths or inline parts. Keep replies chat-sized; write files for`,
		`  anything long.`,
		`- SOUL.md in the workspace root is your identity; AGENTS.md is your own`,
		`  operating notes; USER.md is your model of the operator. You own all`,
		`  three — conversations share nothing else; these files are your only`,
		`  memory between them. Reads are fresh every turn: edits take effect`,
		`  next message.`,
		`- Verify before saying done: run it, read it back, then report.`,
		`- Act freely on this machine (read, write, run); ask first before`,
		`  anything leaves it or can't be undone.`,
		`- Irreversible or destructive actions (deleting data, force-anything)`,
		`  need an explicit go-ahead first.`,
		...(agents ? ["", "## AGENTS.md — your operating notes", "", agents.trim()] : []),
		...(user ? ["", "## USER.md — your model of the operator", "", user.trim()] : []),
		"",
		...skillsSection,
	].join("\n");

	const sources = ["SOUL.md"];
	if (agents) sources.push("AGENTS.md");
	if (user) sources.push("USER.md");
	if (catalog.entries.length > 0 || catalog.skipped > 0) sources.push("skills");

	return { text, sources };
}
