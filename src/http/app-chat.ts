import { join } from "node:path";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { z } from "zod";
import {
	ATTACHMENT_PART,
	attachmentRefSchema,
	isStoredAttachmentPath,
} from "../agent/attachments.ts";
import { appIdOf } from "../conversation.ts";
import { log } from "../log.ts";
import { NOTE_PART, type Note } from "../notes.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import { appStreamSink } from "./app-sse.ts";
import type { AppTtsResponse } from "./app-wire.ts";

const conversationIdSchema = z
	.string()
	.refine((id): boolean => appIdOf(id) !== null, "expected an app/<id> conversation id");

const chatBody = z
	.object({
		conversationId: conversationIdSchema,
		retry: z.literal(true).optional(),
		message: z
			.looseObject({
				id: z.string().min(1),
				role: z.literal("user"),
				parts: z
					.array(z.looseObject({ type: z.string() }))
					.min(1)
					.superRefine((parts, ctx) => {
						for (const [i, p] of parts.entries()) {
							if (p.type === NOTE_PART) {
								const id =
									typeof p.data === "object" && p.data !== null
										? (p.data as { id?: unknown }).id
										: undefined;
								if (typeof id !== "string" || id === "") {
									ctx.addIssue({
										code: "custom",
										path: [i, "data", "id"],
										message: "a note attachment carries only the note id",
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
		if (d.retry === true && d.message !== undefined) {
			ctx.addIssue({ code: "custom", message: "retry takes no message" });
		}
		if (d.retry !== true && d.message === undefined) {
			ctx.addIssue({ code: "custom", path: ["message"], message: "message is required" });
		}
	});

const ttsBody = z.object({ text: z.string().min(1).max(40_000) });

export async function handleChatRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;

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
			const chunks = await deps.speak(parsed.data.text);
			if (chunks === null) {
				return Response.json(
					{ error: "speech is unavailable" },
					{ status: 503, headers: NO_STORE },
				);
			}
			log.info("app tts served", { chars: parsed.data.text.length, chunks: chunks.length });
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
		const convId = parsed.data.conversationId;
		const conv = store.get(convId);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (!runtime.accepting()) {
			return Response.json(
				{ error: "runtime is shutting down" },
				{ status: 503, headers: { ...NO_STORE, "retry-after": "30" } },
			);
		}

		if (parsed.data.retry === true) {
			if (runtime.busy(convId)) {
				return Response.json(
					{ error: "a turn is already running" },
					{ status: 409, headers: NO_STORE },
				);
			}
			const lastUser = store.historyEntries(convId).findLast((e) => e.message.role === "user");
			if (lastUser === undefined) {
				return Response.json({ error: "nothing to retry" }, { status: 409, headers: NO_STORE });
			}
			log.info("app retry", { conversation: convId, message: lastUser.message.id });
			const { sink, body, dispose } = appStreamSink(convId);
			try {
				runtime.submitPersisted(conv, lastUser.message, sink, lastUser.seq);
			} catch (err) {
				log.error("app retry submit failed", err, { conversation: convId });
				dispose();
				return Response.json(
					{ error: "turn could not be started" },
					{ status: 500, headers: NO_STORE },
				);
			}
			log.info("app stream start", { conversation: convId, retry: true });
			return new Response(body, {
				headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
			});
		}

		const message = parsed.data.message!;

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
							conversation: convId,
							filename: ref.data.filename,
							chars: transcript.length,
						});
					}
				} catch (err) {
					log.warn("app speech transcription failed — attachment kept", err, {
						conversation: convId,
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
			const id = (part.data as { id: string }).id;
			const note = deps.notes.get(id);
			if (note === null) {
				return Response.json({ error: `no such note: ${id}` }, { status: 422, headers: NO_STORE });
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
			};
			log.info("note attached", {
				conversation: convId,
				note: note.id,
				rev: note.rev,
				bytes: Buffer.byteLength(note.body),
			});
		}

		if (deps.titleFor !== undefined && conv.title === null) {
			const firstText = message.parts
				.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
				.join("\n")
				.trim();
			if (firstText !== "") {
				void deps
					.titleFor(firstText)
					.then((title) => {
						if (title === null || title === "") return;
						const fresh = store.get(convId);
						if (fresh !== null && fresh.title === null) {
							store.setMeta(convId, { title, titleImplicit: true });
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
		const { sink, body, dispose } = appStreamSink(convId);
		try {
			runtime.submit(conv, message as UIMessage, sink);
		} catch (err) {
			log.error("app submit failed", err, { conversation: convId, message: message.id });
			dispose();
			return Response.json(
				{ error: "turn could not be started" },
				{ status: 500, headers: NO_STORE },
			);
		}
		log.info("app stream start", { conversation: convId });
		return new Response(body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
	}

	return null;
}
