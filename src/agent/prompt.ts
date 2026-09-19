// System prompt assembly: shell + SOUL.md + optional AGENTS.md. Read fresh
// every turn — the operator or the agent itself may edit either file and
// the change is live on the next turn. No command, no restart.

import { readFileSync } from "node:fs";
import { paths } from "../config.ts";
import type { Conversation } from "../conversation.ts";
import { formatSkillsSection, loadCatalog } from "./skills.ts";

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export function buildSystemPrompt(conv: Conversation): { text: string; sources: string[] } {
	const soul = readOptional(paths.soul()) ?? "You are goblin, a personal AI agent.";
	const agents = readOptional(paths.agents());
	// Rescanned every turn — a skill written or edited now is live next
	// message, like the prompt files above.
	const catalog = loadCatalog(paths.skills());

	const text = [
		soul.trim(),
		"",
		"## environment",
		"",
		`- You are talking to your operator on Telegram (${conv.id}).`,
		`- Working directory: ${paths.workspace()} — fixed, same for every chat.`,
		`- Today: ${new Date().toISOString().slice(0, 10)}`,
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
		...formatSkillsSection(catalog),
	].join("\n");

	const sources = ["SOUL.md"];
	if (agents) sources.push("AGENTS.md");
	if (catalog.entries.length > 0 || catalog.skipped > 0) sources.push("skills");

	return { text, sources };
}
