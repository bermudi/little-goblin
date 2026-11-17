// /learn — the Telegram door onto the /learn builder (design/skills.md →
// Self-authoring, /learn, curator).
//
//   /learn [text]   ack, then submit a normal turn whose user text is
//                   buildLearnPrompt(text); empty text learns from the
//                   conversation itself
//
// One prompt, two doors: the app composer's leading "/learn " text part
// rewrites through the same builder (src/http/app-chat.ts). Like every
// command, /learn bypasses the intake inbox; a crash-redelivery re-runs
// it.

import type { Message } from "../message.ts";
import { log } from "../log.ts";
import { buildLearnPrompt } from "../learn.ts";
import type { Conversation } from "../conversation-read.ts";
import { sharedChatPart } from "./turn-input.ts";
import { withTimeout } from "./deadline.ts";
import { submitCommandTurn, type SkillCommandDeps } from "./skill-command.ts";

export async function handleLearnCommand(
	deps: SkillCommandDeps,
	target: Conversation,
	text: string,
): Promise<boolean> {
	const arg = text.replace(/^\/learn(?:@\S+)?/i, "").trim();
	const fromConversation = arg === "";
	// Awaited, not fire-and-forget: a failed ack rejects into the
	// caller's existing "command failed" path, same as /skill's replies.
	await withTimeout(
		deps.api.sendMessage(
			target.chatId,
			fromConversation ? "Learning a skill from this conversation…" : "Learning a skill from what you described…",
			{
				...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
			} as Parameters<typeof deps.api.sendMessage>[2],
		),
		"sendMessage (/learn)",
	);
	const audience = sharedChatPart(target.id, target.chatId);
	const parts: Message["parts"] = [
		...(audience === null ? [] : [audience]),
		{ type: "text", text: buildLearnPrompt(arg) },
	];
	const submitted = submitCommandTurn(deps, target, parts, "learn turn", {
		fromConversation,
	});
	if (submitted) {
		log.info("learn turn submitted via /learn", {
			conversation: target.id,
			fromConversation,
		});
	} else {
		await withTimeout(
			deps.api.sendMessage(target.chatId, "not submitted — the turn was not admitted.", {
				...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
			} as Parameters<typeof deps.api.sendMessage>[2]),
			"sendMessage (/learn)",
		);
	}
	return true;
}
