import { join } from "node:path";
import { buildLearnPrompt } from "../learn.ts";
import type { Message } from "../message.ts";
import { z } from "zod";
import {
	ATTACHMENT_PART,
	attachmentRefSchema,
	isStoredAttachmentPath,
} from "../agent/attachments.ts";
import { appIdOf } from "../conversation-address.ts";
import type { ModelSettings } from "../conversation-settings.ts";
import { hasUsableSkill } from "../agent/skills.ts";
import { speechContent } from "../agent/tts.ts";
import { log } from "../log.ts";
import { hasInlineParts, proseOf } from "../inline-parts.ts";
import { NOTE_PART, type Note } from "../notes.ts";
import type { TurnDone } from "../turn/sink.ts";
import { SKILL_PART, skillPartDataSchema } from "../skill-part.ts";
import { noteSkillUse } from "../skill-usage.ts";
import { paths } from "../home-layout.ts";
import { projectRollText, rollLaneNow, routeLaneMessage, type RollLane, type RollDeps } from "../rolling.ts";
import {
	type AppChannelDeps,
	jsonBodyRefusal,
	modelSettingsBody,
	NO_STORE,
	resolveModelSettings,
} from "./app-shared.ts";
import { appConversationSink } from "./app-sse.ts";
import type { AppRollResponse, AppTtsResponse } from "./app-wire.ts";
import { TOOLS_PART } from "../agent/tool-declarations.ts";

const conversationIdSchema = z
	.string()
	.refine((id): boolean => appIdOf(id) !== null, "expected an app/<id> conversation id");

const chatBody = z
	.object({
		conversationId: conversationIdSchema.optional(),
		rolling: z.literal(true).optional(),
		initialModelSettings: modelSettingsBody.optional(),
		whenBusy: z.enum(["steer", "followUp"]).optional(),
		retry: z.literal(true).optional(),
		// Edit-in-place: the durable user event this message replaces. The
		// store cuts the transcript there; the edited message becomes the
		// next turn's anchor. Only the app channel can name an event, so
		// this is not a Telegram affordance.
		editMessageId: z.string().min(1).max(200).optional(),
		message: z
			.looseObject({
				id: z.string().min(1),
				role: z.literal("user"),
				parts: z
					.array(z.looseObject({ type: z.string() }))
					.min(1)
					.superRefine((parts, ctx) => {
						for (const [i, p] of parts.entries()) {
							// The model pipeline consumes text/file payloads
							// verbatim: a wrong-typed field converts cleanly,
							// is persisted, then fails every later turn at
							// standardizePrompt — the poison-pill shape the
							// boundary must refuse before persistence.
							if (p.type === TOOLS_PART) {
								ctx.addIssue({
									code: "custom",
									path: [i, "type"],
									message: "tool declarations are written by goblin, not the client",
								});
								continue;
							}
							if (p.type === "text") {
								if (typeof p.text !== "string") {
									ctx.addIssue({
										code: "custom",
										path: [i, "text"],
										message: "a text part carries a string text",
									});
								}
								continue;
							}
							if (p.type === "file") {
								if (typeof p.mediaType !== "string" || typeof p.url !== "string") {
									ctx.addIssue({
										code: "custom",
										path: [i],
										message: "a file part carries string mediaType and url",
									});
								}
								continue;
							}
							if (p.type === NOTE_PART) {
								const data =
									typeof p.data === "object" && p.data !== null
										? (p.data as { id?: unknown; inline?: unknown })
										: null;
								const id = data?.id;
								if (typeof id !== "string" || id === "") {
									ctx.addIssue({
										code: "custom",
										path: [i, "data", "id"],
										message: "a note attachment carries only the note id",
									});
									continue;
								}
								if (data !== null && data.inline !== undefined && data.inline !== true) {
									ctx.addIssue({
										code: "custom",
										path: [i, "data", "inline"],
										message: "inline, when set, is true",
									});
								}
								continue;
							}
							if (p.type === SKILL_PART) {
								const ref = skillPartDataSchema.safeParse(p.data);
								if (!ref.success) {
									ctx.addIssue({
										code: "custom",
										path: [i, "data"],
										message: `invalid skill invocation: ${z.prettifyError(ref.error)}`,
									});
								}
								continue;
							}
							if (p.type !== ATTACHMENT_PART) continue;
							const ref = attachmentRefSchema.safeParse(p.data);
							if (!ref.success || !isStoredAttachmentPath(ref.data.path)) {
								ctx.addIssue({
									code: "custom",
									path: [i, "data", "path"],
									message: "attachment path must name a file the attachments pipeline wrote",
								});
							}
						}
					}),
			})
			.optional(),
	})
	.superRefine((d, ctx) => {
		if (d.rolling === true) {
			if (d.conversationId !== undefined) {
				ctx.addIssue({ code: "custom", path: ["conversationId"], message: "rolling takes no conversationId" });
			}
			if (d.retry === true) {
				ctx.addIssue({ code: "custom", path: ["retry"], message: "rolling takes no retry" });
			}
			if (d.editMessageId !== undefined) {
				ctx.addIssue({ code: "custom", path: ["editMessageId"], message: "rolling takes no edit" });
			}
			if (d.message === undefined) {
				ctx.addIssue({ code: "custom", path: ["message"], message: "rolling requires a message" });
			}
			return;
		}
		if (d.initialModelSettings !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["initialModelSettings"],
				message: "initialModelSettings is only valid for a new rolling chat",
			});
		}
		if (d.conversationId === undefined) {
			ctx.addIssue({ code: "custom", path: ["conversationId"], message: "conversationId is required" });
		}
		if (d.retry === true && d.message !== undefined) {
			ctx.addIssue({ code: "custom", message: "retry takes no message" });
		}
		if (d.retry === true && d.editMessageId !== undefined) {
			ctx.addIssue({ code: "custom", message: "retry takes no edit" });
		}
		if (d.retry !== true && d.message === undefined) {
			ctx.addIssue({ code: "custom", path: ["message"], message: "message is required" });
		}
	});

const ttsBody = z.object({ text: z.string().min(1).max(40_000) });

/** Bump the usage sidecar for every catalog skill part an admitted
 *  submit carries (the curator's clock — design/skills.md →
 *  Self-authoring, /learn, curator). Retry and edit resubmit the same
 *  durable part and are real re-invocations. A bump failure never
 *  fails the turn: the invocation stands, the clock misses one tick. */
function bumpSkillUsage(convId: string, parts: readonly { type: string; data?: unknown }[]): void {
	for (const part of parts) {
		if (part.type !== SKILL_PART) continue;
		const ref = skillPartDataSchema.safeParse(part.data);
		if (!ref.success || !("name" in ref.data)) continue;
		try {
			noteSkillUse(paths.skillUsage(), ref.data.name, new Date());
		} catch (err) {
			log.warn("skill use bump failed — invocation stands", err, {
				skill: ref.data.name,
				conversation: convId,
			});
		}
	}
}

export async function handleChatRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;
	const appLane = (initialSettings?: ModelSettings): RollLane => ({
		current: () => store.currentAppRoll(),
		mint: () =>
			store.rollApp(
				initialSettings === undefined
					? deps.configRef.current
					: { ...deps.configRef.current, ...initialSettings },
			),
		logs: {
			rolled: "app lane rolled",
			continued: "app lane continued past gap",
			fields: {},
			rolledFields: {},
		},
	});

	if (path === "/api/app/tts") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.speak === undefined) {
			return Response.json(
				{ error: "speech is not configured" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = ttsBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		try {
			// The client sends raw reply markdown; the voice speaks the
			// spoken content only — same strip the tg doors run before
			// their speaker (2026-10-19: "the voice keeps reading
			// asterisk asterisk"). A reply that strips to nothing (pure
			// code block) is a refusal, not silence with a 500.
			const { spoken } = speechContent(parsed.data.text);
			if (spoken === "") {
				return Response.json(
					{ error: "nothing speakable in this reply" },
					{ status: 422, headers: NO_STORE },
				);
			}
			const chunks = await deps.speak(spoken);
			if (chunks === null) {
				return Response.json(
					{ error: "speech is unavailable" },
					{ status: 503, headers: NO_STORE },
				);
			}
			log.info("app tts served", { chars: spoken.length, chunks: chunks.length });
			const body: AppTtsResponse = {
				chunks: chunks.map((c) => Buffer.from(c).toString("base64")),
				mediaType: "audio/ogg",
			};
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			log.error("app tts failed", err);
			return Response.json(
				{ error: "speech synthesis failed" },
				{ status: 500, headers: NO_STORE },
			);
		}
	}

	if (path === "/api/app/rolling/roll") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const outcome = rollLaneNow(deps, appLane());
		if (outcome.kind === "busy") {
			log.info("app rolling roll refused", { conversation: outcome.conv.id, reason: "busy" });
			return Response.json(
				{ error: "a turn is still running in the latest conversation" },
				{ status: 409, headers: NO_STORE },
			);
		}
		if (outcome.kind === "empty") {
			log.info("app rolling roll refused", { conversation: outcome.conv.id, reason: "empty" });
		}
		const body: AppRollResponse = {
			conversationId: outcome.conv.id,
			rolled: outcome.kind === "rolled",
		};
		return Response.json(body, { headers: NO_STORE });
	}

	if (path === "/api/app/chat") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = chatBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		for (const part of parsed.data.message?.parts ?? []) {
			if (part.type !== SKILL_PART) continue;
			const ref = skillPartDataSchema.parse(part.data);
			if (!("name" in ref) || hasUsableSkill(paths.skills(), ref.name)) continue;
			const error = `no skill named "${ref.name}"`;
			log.warn("app skill invocation refused", {
				skill: ref.name,
				reason: "not in the usable catalog",
			});
			return Response.json({ error }, { status: 400, headers: NO_STORE });
		}
		const rolling = parsed.data.rolling === true;
		let convId = parsed.data.conversationId ?? "";
		let conv = convId === "" ? null : store.get(convId);
		const logTarget = rolling ? { rolling: true } : { conversation: convId };
		if (!rolling && conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (!runtime.accepting()) {
			return Response.json(
				{ error: "runtime is shutting down" },
				{ status: 503, headers: { ...NO_STORE, "retry-after": "30" } },
			);
		}
		const notifyUnwatched =
			deps.push === undefined
				? undefined
				: async (done: TurnDone) => {
						if (!runtime.turnHadWatchersAtEnd(convId)) {
							if (conv === null) throw new Error(`conversation ${convId} disappeared`);
							await deps.push!.notifyDone(conv, done, "foreground");
						}
					};
		const media = {
			append: (messages: Message[], opts?: Parameters<typeof store.append>[2]) =>
				store.append(convId, messages, opts),
		};
		if (parsed.data.retry === true) {
			if (conv === null) {
				return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
			}
			if (runtime.busy(convId)) {
				return Response.json(
					{ error: "a turn is already running" },
					{ status: 409, headers: NO_STORE },
				);
			}
			const lastUser = store.lastEntry(convId, "user") ?? undefined;
			if (lastUser === undefined) {
				return Response.json({ error: "nothing to retry" }, { status: 409, headers: NO_STORE });
			}
			const rewound = store.editUserMessage(convId, lastUser.message.id, lastUser.message);
			if (rewound === null) {
				return Response.json({ error: "nothing to retry" }, { status: 409, headers: NO_STORE });
			}
			runtime.emitConversationRewound(convId, lastUser.message.id, lastUser.message.id);
			log.info("app retry rewound", {
				conversation: convId,
				messageId: lastUser.message.id,
				replacedBy: lastUser.message.id,
				cutSeq: rewound.cutSeq,
				seq: rewound.seq,
				events: rewound.events,
				compactions: rewound.compactions,
				contexts: rewound.contexts,
				projections: rewound.projections,
				ratings: rewound.ratings,
				asks: rewound.asks,
			});
			const sink = appConversationSink(convId, media, notifyUnwatched);
			try {
				runtime.submitPersisted(conv, lastUser.message, sink, rewound.seq);
			} catch (err) {
				log.error("app retry submit failed", err, { conversation: convId });
				return Response.json(
					{ error: "turn could not be started" },
					{ status: 500, headers: NO_STORE },
				);
			}
			bumpSkillUsage(convId, lastUser.message.parts);
			log.info("app retry submitted", { conversation: convId });
			return Response.json({ submitted: true }, { status: 202, headers: NO_STORE });
		}

		const message = parsed.data.message!;

		// /learn, the app door: a leading "/learn" text part rewrites to
		// the builder output — the same prompt the Telegram command
		// submits (design/skills.md → Self-authoring, /learn, curator).
		// One boundary rewrite, logged; everything downstream is an
		// ordinary text turn.
		for (const part of message.parts) {
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const m = /^\/learn(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(part.text.trim());
			if (m === null) continue;
			const rest = m[1] ?? "";
			part.text = buildLearnPrompt(rest);
			log.info("app /learn intercept", {
				...logTarget,
				fromConversation: rest.trim() === "",
			});
			break;
		}

		// Validate the edit target before any transcript/attachment prep —
		// a refused edit must not pay for transcription it will discard.
		const editId = parsed.data.editMessageId;
		let editTarget: { seq: number; role: string } | null = null;
		if (editId !== undefined) {
			if (conv === null) {
				return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
			}
			if (runtime.busy(convId)) {
				return Response.json(
					{ error: "a turn is already running — wait for it to finish, then edit" },
					{ status: 409, headers: NO_STORE },
				);
			}
			editTarget = store.messageEvent(convId, editId);
			if (editTarget === null) {
				return Response.json({ error: "no such message" }, { status: 404, headers: NO_STORE });
			}
			if (editTarget.role !== "user") {
				return Response.json(
					{ error: "only a user message can be edited" },
					{ status: 422, headers: NO_STORE },
				);
			}
		}

		if (deps.transcribe !== undefined) {
			for (const part of message.parts) {
				if (part.type !== ATTACHMENT_PART) continue;
				const ref = attachmentRefSchema.safeParse(part.data);
				if (!ref.success || ref.data.speech !== true || ref.data.transcript !== undefined) {
					continue;
				}
				try {
					const transcript = await deps.transcribe({
						path: ref.data.path,
						mediaType: ref.data.mediaType,
						filename: ref.data.filename,
					});
					if (transcript !== null) {
						part.data = { ...ref.data, transcript };
						log.info("app speech transcribed", {
							...logTarget,
							filename: ref.data.filename,
							chars: transcript.length,
						});
					}
				} catch (err) {
					log.warn("app speech transcription failed — attachment kept", err, {
						...logTarget,
						filename: ref.data.filename,
					});
					part.data = {
						...ref.data,
						transcriptionError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
					};
				}
			}
		}

		for (const part of message.parts) {
			if (part.type !== NOTE_PART) continue;
			const incoming = part.data as { id: string; inline?: true };
			const note = deps.notes.get(incoming.id);
			if (note === null) {
				return Response.json(
					{ error: `no such note: ${incoming.id}` },
					{ status: 422, headers: NO_STORE },
				);
			}
			if (note.archivedAt !== null) {
				return Response.json(
					{ error: `note is archived: ${note.title}` },
					{ status: 422, headers: NO_STORE },
				);
			}
			part.data = {
				id: note.id,
				title: note.title,
				rev: note.rev,
				body: note.body,
				projectId: note.projectId,
				...(incoming.inline === true ? { inline: true } : {}),
			};
			log.info("note attached", {
				...logTarget,
				note: note.id,
				rev: note.rev,
				bytes: Buffer.byteLength(note.body),
			});
		}

		if (editId !== undefined && editTarget !== null) {
			if (conv === null) throw new Error(`conversation ${convId} disappeared`);
			// Prep above awaited (transcription). A turn admitted in that
			// window would be cut by the rewind — re-check the lane with no
			// await before the store write.
			if (runtime.busy(convId)) {
				return Response.json(
					{ error: "a turn is already running — wait for it to finish, then edit" },
					{ status: 409, headers: NO_STORE },
				);
			}
			const edited = store.editUserMessage(convId, editId, message as Message);
			if (edited === null) {
				return Response.json({ error: "no such user message" }, { status: 404, headers: NO_STORE });
			}
			runtime.emitConversationRewound(convId, editId, (message as Message).id);
			log.info("app message edited", {
				conversation: convId,
				messageId: editId,
				replacedBy: (message as Message).id,
				cutSeq: edited.cutSeq,
				seq: edited.seq,
				events: edited.events,
				compactions: edited.compactions,
				contexts: edited.contexts,
				projections: edited.projections,
				ratings: edited.ratings,
				asks: edited.asks,
			});
			const sink = appConversationSink(convId, media, notifyUnwatched);
			try {
				runtime.submitPersisted(conv, message as Message, sink, edited.seq);
			} catch (err) {
				log.error("app edit submit failed", err, { conversation: convId, message: editId });
				return Response.json(
					{ error: "turn could not be started" },
					{ status: 500, headers: NO_STORE },
				);
			}
			bumpSkillUsage(convId, message.parts);
			log.info("app edit submitted", { conversation: convId, message: editId });
			return Response.json({ submitted: true }, { status: 202, headers: NO_STORE });
		}

		let rolled = false;
		if (rolling) {
			let initialSettings: ModelSettings | undefined;
			if (parsed.data.initialModelSettings !== undefined) {
				const resolved = resolveModelSettings(deps.configRef.current, parsed.data.initialModelSettings);
				if (resolved instanceof Response) return resolved;
				initialSettings = resolved.settings;
				if (store.currentAppRoll() !== null) {
					return Response.json(
						{ error: "rolling chat already exists — its model settings cannot be changed at creation" },
						{ status: 409, headers: NO_STORE },
					);
				}
			}
			const lane = appLane(initialSettings);
			const rollDeps: RollDeps = {
				store,
				runtime,
				gapMinutes: () => deps.configRef.current.telegram.dmGapMinutes,
				...(deps.gate !== undefined ? { gate: deps.gate } : {}),
			};
			const result = await routeLaneMessage(
				rollDeps,
				lane,
				projectRollText(message.parts as Message["parts"]),
			);
			convId = result.conv.id;
			conv = result.conv;
			rolled = result.rolled;
			log.info("app rolling send", {
				conversation: convId,
				rolled,
				decidedBy: result.decidedBy,
			});
		}
		if (conv === null) throw new Error(`rolling route did not resolve a conversation`);

		if (deps.titleFor !== undefined && conv.title === null) {
			const parts = message.parts as Message["parts"];
			const firstText = hasInlineParts(parts)
				? proseOf(parts)
				: (parts
						.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
						.join("\n")
						.trim());
			if (firstText !== "") {
				const cfg = deps.configRef.current;
				const model = store.readAppSettings(convId, {
					model: cfg.model,
					thinking: cfg.thinking,
				}).model;
				void deps
					.titleFor(firstText, { model })
					.then((title) => {
						if (title === null || title === "") return;
						const fresh = store.get(convId);
						if (fresh !== null && fresh.title === null) {
							store.setMeta(convId, { title, titleImplicit: false });
							log.info("app conversation titled", { conversation: convId, title });
						}
					})
					.catch((err: unknown) => {
						log.warn("app conversation titling failed", err, {
							conversation: convId,
						});
					});
			}
		}

		log.info("app intake", { conversation: convId, message: message.id });
		const sink = appConversationSink(convId, media, notifyUnwatched);
		try {
			if (runtime.busy(convId)) {
				const pendingId = runtime.submitPending(
					conv,
					message as Message,
					parsed.data.whenBusy ?? "steer",
					sink,
				);
				bumpSkillUsage(convId, message.parts);
				return Response.json(
					{
						submitted: true,
						pendingId,
						...(rolling ? { conversationId: convId, rolled } : {}),
					},
					{ status: 202, headers: NO_STORE },
				);
			}
			runtime.submit(conv, message as Message, sink);
		} catch (err) {
			log.error("app submit failed", err, { conversation: convId, message: message.id });
			return Response.json(
				{ error: "turn could not be started" },
				{ status: 500, headers: NO_STORE },
			);
		}
		bumpSkillUsage(convId, message.parts);
		log.info("app submitted", { conversation: convId, message: message.id });
		return Response.json(
			{ submitted: true, ...(rolling ? { conversationId: convId, rolled } : {}) },
			{ status: 202, headers: NO_STORE },
		);
	}

	return null;
}
