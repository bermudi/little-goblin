// App channel HTTP surface (DESIGN.md, App channel) — the React client's
// API under /api/app/*. Bearer-token auth, separate from the mini app's
// initData path: the credential is an auth.jsonl record named by
// config.appToken, resolved per request. An unset appToken refuses every
// request with a log line — the surface is never silently open.
//
// Chat rides the shared runtime unchanged: a submitted message lands in
// the same serial lane, the same steering and /stop fencing apply, and
// the response stream is the runtime's own UIMessage stream — this
// module's TurnSink serializes it to the SSE wire verbatim
// (`data: <chunk>\n\n`, terminated by `data: [DONE]\n\n`), exactly what
// @ai-sdk/react's useChat consumes.

import { createHash, randomUUID } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { z } from "zod";
import {
	appAddress,
	appIdSchema,
	type ConversationStore,
} from "../conversation.ts";
import type { AuthStore } from "../auth.ts";
import type { Runtime, TurnSink } from "../runtime.ts";
import {
	ATTACHMENT_PART,
	attachmentRefSchema,
	isStoredAttachmentPath,
	persistAttachment,
	type AttachmentRef,
} from "../agent/attachments.ts";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import type {
	AppAttachmentResponse,
	AppConversationCreate,
	AppConversationList,
	AppMessageList,
	AppStopResponse,
} from "./app-wire.ts";

const NO_STORE = { "cache-control": "no-store" };

export interface AppChannelDeps {
	store: ConversationStore;
	runtime: Runtime;
	// auth.jsonl resolution — the record config.appToken names.
	auth: Pick<AuthStore, "resolve">;
}

// ---------- auth ----------

// Bearer equality without a timing oracle: fixed-length digests of both
// sides, so a wrong token's length leaks nothing.
function bearerMatches(presented: string, expected: string): boolean {
	if (presented === "") return false;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return a.equals(b);
}

// Every /api/app/* request passes here first. Returns null when the
// request may proceed; the Response is the refusal. Both refusal kinds
// log — a silently open door is the failure this gate exists against.
async function appAuth(
	req: Request,
	pathname: string,
	deps: AppChannelDeps,
	appToken: string | undefined,
): Promise<Response | null> {
	if (appToken === undefined) {
		log.warn("app api refused — appToken not configured", { path: pathname });
		return Response.json(
			{ error: "app channel is not configured" },
			{ status: 503, headers: NO_STORE },
		);
	}
	let expected: string;
	try {
		expected = await deps.auth.resolve(appToken);
	} catch (err) {
		log.error("app token resolution failed — refusing", err, { path: pathname });
		return Response.json(
			{ error: "app channel is misconfigured" },
			{ status: 503, headers: NO_STORE },
		);
	}
	const header = req.headers.get("authorization") ?? "";
	const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	if (!bearerMatches(presented, expected)) {
		log.warn("app auth failed", { path: pathname });
		return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
	}
	return null;
}

// ---------- request schemas ----------

const createBody = z.object({
	id: appIdSchema.optional(),
	title: z.string().min(1).max(200).optional(),
});

// The conversation id arrives as the full address — "app/<id>" — so a
// telegram id can never be submitted through this surface.
const conversationIdSchema = z
	.string()
	.regex(/^app\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "expected an app/<id> conversation id");

const chatBody = z.object({
	conversationId: conversationIdSchema,
	message: z.looseObject({
		id: z.string().min(1),
		role: z.literal("user"),
		parts: z
			.array(z.looseObject({ type: z.string() }))
			.min(1)
			// A data-attachment ref is a client-supplied string pointing at
			// a server path; materializeAttachments hands ref.path to
			// readFile. Confine it to the directory persistAttachment
			// writes, or the part is an arbitrary-file read. Parts that
			// aren't attachments pass through — the runtime owns their
			// semantics.
			.superRefine((parts, ctx) => {
				for (const [i, p] of parts.entries()) {
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
	}),
});

// Multipart uploads buffer — cap before formData reads the body, so a
// hostile content-length never reaches memory. 32 MiB covers phone-grade
// photos/video clips; larger belongs to a real upload channel anyway.
const UPLOAD_CAP = 32 * 1024 * 1024;

// ---------- the app's TurnSink: UIMessage stream → SSE verbatim ----------

function appStreamSink(convId: string): {
	sink: TurnSink;
	body: ReadableStream<Uint8Array>;
} {
	const enc = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		// Client disconnected mid-turn — the turn keeps writing durable
		// history; only the wire closes.
		cancel() {
			closed = true;
		},
	});
	const push = (line: string) => {
		if (closed) return;
		try {
			controller.enqueue(enc.encode(line));
		} catch {
			closed = true;
		}
	};
	return {
		body,
		sink: {
			// Delta-style delivery hooks are telegram's — the app stream is
			// the raw chunk pass-through alone.
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onStreamChunk(chunk) {
				push(`data: ${JSON.stringify(chunk)}\n\n`);
			},
			onDone(done) {
				// A turn that ended without a finish chunk (fenced by /stop,
				// or crashed) still owes the client a terminal event.
				if (done.kind !== "completed") {
					push(
						`data: ${JSON.stringify({
							type: "error",
							errorText:
								done.kind === "error" ? done.message : "turn stopped before finishing",
						})}\n\n`,
					);
				}
				push("data: [DONE]\n\n");
				closed = true;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
				log.info("app stream finish", { conversation: convId, outcome: done.kind });
			},
		},
	};
}

// ---------- routes ----------

// Conversation id path segment: the minted id alone (the "app/" prefix
// can't appear inside a path segment, so the full id is rebuilt here).
function conversationFromSegment(segment: string): { id: string } | Response {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		decoded = "";
	}
	const parsed = appIdSchema.safeParse(decoded);
	if (!parsed.success) {
		return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
	}
	return { id: `app/${parsed.data}` };
}

export async function handleAppApi(
	req: Request,
	url: URL,
	configuredToken: string | undefined,
	deps: AppChannelDeps,
): Promise<Response> {
	const path = url.pathname;
	const refused = await appAuth(req, path, deps, configuredToken);
	if (refused !== null) return refused;
	const { store, runtime } = deps;

	if (path === "/api/app/conversations") {
		if (req.method === "GET") {
			const body: AppConversationList = { conversations: store.listAppConversations() };
			log.debug("app conversation list served", { count: body.conversations.length });
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method === "POST") {
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = createBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			// get-or-create: a minted id re-posted is the same conversation.
			const conv = store.resolve(appAddress(parsed.data.id ?? randomUUID()), paths.workspace());
			if (parsed.data.title !== undefined) {
				store.setMeta(conv.id, { title: parsed.data.title, titleImplicit: false });
			}
			const created = store.get(conv.id)!;
			log.info("app conversation opened", { conversation: conv.id });
			const body: AppConversationCreate = {
				id: conv.id,
				title: created.title,
				createdAt: created.createdAt,
			};
			return Response.json(body, { status: 201, headers: NO_STORE });
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	const convMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/messages$/);
	if (convMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(convMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		// Envelope v1 unwraps verbatim — no translation layer between the
		// store and the client (DESIGN.md, App channel).
		const body: AppMessageList = { messages: store.history(convId.id) };
		log.debug("app history served", { conversation: convId.id, messages: body.messages.length });
		return Response.json(body, { headers: NO_STORE });
	}

	// /stop rides the existing lane: the same epoch bump + abort the
	// telegram command invokes — the client only reaches it through here.
	const stopMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/stop$/);
	if (stopMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(stopMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const { stopped } = runtime.stop(convId.id);
		log.info("app stop", { conversation: convId.id, stopped });
		const body: AppStopResponse = { stopped };
		return Response.json(body, { headers: NO_STORE });
	}

	if (path === "/api/app/chat") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
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
		// Intake boundary: message → app address.
		log.info("app intake", { conversation: convId, message: parsed.data.message.id });
		const { sink, body } = appStreamSink(convId);
		// Steering and /stop ride the existing lane — a second chat POST
		// while a turn runs queues or steers exactly like Telegram.
		runtime.submit(conv, parsed.data.message as UIMessage, sink);
		log.info("app stream start", { conversation: convId });
		return new Response(body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
	}

	if (path === "/api/app/attachments") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > UPLOAD_CAP) {
			return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
		}
		let form: Awaited<ReturnType<Request["formData"]>>;
		try {
			form = await req.formData();
		} catch {
			return Response.json({ error: "expected multipart form" }, { status: 400, headers: NO_STORE });
		}
		const file = form.get("file");
		if (typeof file !== "object" || file === null || file.size === 0) {
			return Response.json({ error: "no file in upload" }, { status: 400, headers: NO_STORE });
		}
		if (file.size > UPLOAD_CAP) {
			return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
		}
		// Same durable pipeline as telegram media — the saved path is what
		// history's data-attachment part will reference.
		const saved = await persistAttachment(
			`app-${randomUUID()}`,
			file.name || "upload",
			"app",
			async (temp) => {
				await Bun.write(temp, file);
			},
		);
		const ref: AttachmentRef = {
			path: saved.path,
			mediaType: file.type || "application/octet-stream",
			filename: file.name || "upload",
			size: saved.size,
		};
		log.info("app attachment uploaded", {
			filename: ref.filename,
			mediaType: ref.mediaType,
			size: ref.size,
		});
		const body: AppAttachmentResponse = { ref };
		return Response.json(body, { status: 201, headers: NO_STORE });
	}

	return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
