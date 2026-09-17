// System prompt assembly: shell + SOUL.md + optional AGENTS.md. Read fresh
// every turn — the agent may edit its own soul and it takes effect on the
// next turn.

import { readFileSync } from "node:fs";
import { paths } from "../config.ts";
import type { Conversation } from "../conversation.ts";

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export function buildSystemPrompt(conv: Conversation): string {
	const soul = readOptional(paths.soul()) ?? "You are goblin, a personal AI agent.";
	const agents = readOptional(paths.agents());

	return [
		soul.trim(),
		"",
		"## environment",
		"",
		`- You are talking to your operator on Telegram (${conv.id}).`,
		`- Working directory for this conversation: ${conv.cwd}`,
		`- Today: ${new Date().toISOString().slice(0, 10)}`,
		`- Tools: read_file, write_file, edit_file, bash. Paths are relative to`,
		`  the working directory unless absolute.`,
		`- Telegram is the UI: messages are plain text/Markdown, media arrives as`,
		`  file paths or inline parts. Keep replies chat-sized; write files for`,
		`  anything long.`,
		...(agents ? ["", "## workspace notes", "", agents.trim()] : []),
	].join("\n");
}
