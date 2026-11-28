import { z } from "zod";
import { isAbsolute } from "node:path";
import { log } from "../log.ts";
import { type AppChannelDeps, conversationFromSegment, NO_STORE, parsedJson } from "./app-shared.ts";
import type { AppBot, AppBotMoveBack, AppBotName, AppBotPatch } from "./app-wire.ts";

const name = z.string().trim().min(1).max(200);
const nameBody: z.ZodType<AppBotName> = z.strictObject({ name });
const settingsBody: z.ZodType<AppBotPatch> = z.strictObject({
	name: name.optional(),
	instructions: z.string().max(20_000).optional(),
	folder: z.string().max(4096).refine((path) => isAbsolute(path) && !path.includes("\0"), {
		message: "Use an absolute folder path.",
	}).nullable().optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined));
const botId = z.uuidv4();
const emptyBody = z.strictObject({});

const conversionErrors = {
	missing: { status: 404, error: "No such conversation." },
	notSideChat: { status: 409, error: "Only Little Goblin side chats can become bots." },
	archived: { status: 409, error: "Unarchive this chat before converting it." },
	busy: { status: 409, error: "Wait for the current reply to finish before converting this chat." },
};

export async function handleBotsRoute(
	req: Request,
	url: URL,
	deps: Pick<AppChannelDeps, "store" | "runtime">,
	now = Date.now,
): Promise<Response | null> {
	const settings = url.pathname.match(/^\/api\/app\/bots\/([^/]+)(\/move-back)?$/);
	if (settings !== null) return handleBotSettings(req, settings[1]!, settings[2] !== undefined, deps);

	const match = url.pathname.match(/^\/api\/app\/conversations\/([^/]+)\/convert-to-bot$/);
	if (match === null) return null;
	if (req.method !== "POST") {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	const conversation = conversationFromSegment(match[1]!);
	if (conversation instanceof Response) return conversation;
	const body = await parsedJson(req, nameBody);
	if (body instanceof Response) return body;

	const outcome = deps.store.bots.convertSideChat(
		conversation.id, body.name, now(), (id) => deps.runtime.busy(id),
	);
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

async function handleBotSettings(
	req: Request,
	id: string,
	moveBack: boolean,
	{ store, runtime }: Pick<AppChannelDeps, "store" | "runtime">,
): Promise<Response> {
	const missing = () => Response.json({ error: "No such bot." }, { status: 404, headers: NO_STORE });
	if (!botId.safeParse(id).success) return missing();
	if (req.method !== (moveBack ? "POST" : "PATCH")) {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	if (!moveBack) {
		const body = await parsedJson(req, settingsBody);
		if (body instanceof Response) return body;
		const bot = store.bots.patch(id, body);
		if (bot === null) return missing();
		log.info("app bot settings changed", { bot: bot.id, fields: Object.keys(body) });
		return Response.json(bot satisfies AppBot, { headers: NO_STORE });
	}
	const body = await parsedJson(req, emptyBody);
	if (body instanceof Response) return body;
	const outcome = store.bots.moveBack(id, (conversationId) => runtime.busy(conversationId));
	if (outcome.kind === "moved") {
		log.info("app bot moved back", { bot: id, conversation: outcome.conversationId });
		return Response.json(
			{ conversationId: outcome.conversationId } satisfies AppBotMoveBack,
			{ headers: NO_STORE },
		);
	}
	if (outcome.kind === "missing") return missing();
	log.info("app bot move back refused", { bot: id, reason: outcome.kind });
	const error = outcome.kind === "busy"
		? "Wait for the current reply to finish before moving this chat."
		: "Move back is available only when the bot has its original chat and no bot notes.";
	return Response.json({ error }, { status: 409, headers: NO_STORE });
}
