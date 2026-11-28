import { z } from "zod";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { log } from "../log.ts";
import { thinkingLevels } from "../config-schema.ts";
import { resolveModelSettings } from "./app-shared.ts";
import { type AppChannelDeps, conversationFromSegment, NO_STORE, parsedJson } from "./app-shared.ts";
import type { AppBot, AppBotMemory, AppBotMoveBack, AppBotName } from "./app-wire.ts";

const name = z.string().trim().min(1).max(200);
const nameBody: z.ZodType<AppBotName> = z.strictObject({ name });
const settingsBody = z.strictObject({
	name: name.optional(),
	instructions: z.string().max(20_000).optional(),
	folder: z.string().max(4096).refine((path) => isAbsolute(path) && !path.includes("\0"), {
		message: "Use an absolute folder path.",
	}).nullable().optional(),
	model: z.string().min(1).nullable().optional(),
	thinking: z.enum(thinkingLevels).nullable().optional(),
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
	deps: Pick<AppChannelDeps, "store" | "runtime" | "configRef">,
	now = Date.now,
): Promise<Response | null> {
	const settings = url.pathname.match(/^\/api\/app\/bots\/([^/]+)(\/move-back)?$/);
	if (settings !== null) return handleBotSettings(req, settings[1]!, settings[2] !== undefined, deps);
	const memory = url.pathname.match(/^\/api\/app\/bots\/([^/]+)\/memory$/);
	if (memory !== null) {
		if (req.method !== "GET") return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const bot = deps.store.bots.get(memory[1]!);
		if (bot === null) return Response.json({ error: "No such bot." }, { status: 404, headers: NO_STORE });
		const path = bot.folder === null ? null : join(bot.folder, "MEMORY.md");
		let text: string | null = null;
		if (path !== null) {
			try {
				const contents = readFileSync(path);
				text = contents.length > 64 * 1024 ? contents.subarray(0, 64 * 1024).toString("utf8") : contents.toString("utf8");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					log.error("app bot memory read failed", error, { bot: bot.id, path });
					throw new Error(`read bot memory ${path}: ${String(error)}`, { cause: error });
				}
			}
		}
		return Response.json({ path, text } satisfies AppBotMemory, { headers: NO_STORE });
	}

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
	{ store, runtime, configRef }: Pick<AppChannelDeps, "store" | "runtime" | "configRef">,
): Promise<Response> {
	const missing = () => Response.json({ error: "No such bot." }, { status: 404, headers: NO_STORE });
	if (!botId.safeParse(id).success) return missing();
	if (req.method !== (moveBack ? "POST" : "PATCH")) {
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}
	if (!moveBack) {
		const body = await parsedJson(req, settingsBody);
		if (body instanceof Response) return body;
		if (body.model !== undefined && body.model !== null) {
			const resolved = resolveModelSettings(configRef.current, {
				model: body.model,
				thinking: configRef.current.thinking,
			});
			if (resolved instanceof Response) return resolved;
		}
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
