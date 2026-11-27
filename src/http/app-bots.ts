import { z } from "zod";
import { log } from "../log.ts";
import { type AppChannelDeps, conversationFromSegment, NO_STORE, parsedJson } from "./app-shared.ts";
import type { AppBot, AppBotName } from "./app-wire.ts";

const nameBody: z.ZodType<AppBotName> = z.object({ name: z.string().trim().min(1).max(200) }).strict();

const conversionErrors = {
	missing: { status: 404, error: "No such conversation." },
	notSideChat: { status: 409, error: "Only Little Goblin side chats can become bots." },
	archived: { status: 409, error: "Unarchive this chat before converting it." },
	busy: { status: 409, error: "Wait for the current reply to finish before converting this chat." },
};

export async function handleBotsRoute(
	req: Request,
	url: URL,
	{ store, runtime }: Pick<AppChannelDeps, "store" | "runtime">,
	now = Date.now,
): Promise<Response | null> {
	const match = url.pathname.match(/^\/api\/app\/conversations\/([^/]+)\/convert-to-bot$/);
	if (match === null) return null;
	if (req.method !== "POST") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	const conversation = conversationFromSegment(match[1]!);
	if (conversation instanceof Response) return conversation;
	const body = await parsedJson(req, nameBody);
	if (body instanceof Response) return body;

	const outcome = store.bots.convertSideChat(conversation.id, body.name, now(), (id) => runtime.busy(id));
	if ("bot" in outcome) {
		log.info("app bot conversion", {
			conversation: conversation.id,
			bot: outcome.bot.id,
			outcome: outcome.kind,
		});
		return Response.json(outcome.bot satisfies AppBot, {
			status: outcome.kind === "converted" ? 201 : 200,
			headers: NO_STORE,
		});
	}
	const { status, error } = conversionErrors[outcome.kind];
	log.info("app bot conversion refused", { conversation: conversation.id, reason: outcome.kind });
	return Response.json({ error }, { status, headers: NO_STORE });
}
