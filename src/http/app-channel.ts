// App channel HTTP surface (DESIGN.md, App channel) — the React client's
// API under /api/app/*. The auth mode resolves once at boot
// (resolveAppAuth, wired by index.ts): config.appToken names an
// auth.jsonl record → bearer required per request; unset → trust mode —
// the tailnet is the only lock and requests pass unauthenticated
// (device-level trust, the collie precedent).
//
// Chat rides the shared runtime unchanged: a submitted message lands in
// the same serial lane, the same steering and /stop fencing apply, and
// the response stream is the runtime's own UIMessage stream — this
// module's TurnSink serializes it to the SSE wire verbatim
// (`data: <chunk>\n\n`, terminated by `data: [DONE]\n\n`), exactly what
// @ai-sdk/react's useChat consumes.

import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { readBodyBytesCapped } from "./check.ts";
import {
	appAddress,
	appIdOf,
	appIdSchema,
	prepareAppSettingsForConfig,
	type ConversationStore,
	type ModelSettings,
} from "../conversation.ts";
import type { AuthStore } from "../auth.ts";
import type { Runtime, TurnDone, TurnSink } from "../runtime.ts";
import { thinkingLevelsFor } from "../agent/providers.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import {
	ATTACHMENT_PART,
	attachmentRefSchema,
	isStoredAttachmentPath,
	persistAttachment,
	type AttachmentRef,
} from "../agent/attachments.ts";
import {
	loadConfig,
	parseConfig,
	paths,
	splitModelRef,
	thinkingLevels,
	writeConfig,
	type Config,
	type ConfigRef,
} from "../config.ts";
import { log } from "../log.ts";
import type {
	AppAttachmentResponse,
	AppConfigView,
	AppConversationCreate,
	AppConversationList,
	AppConversationRename,
	AppMessageList,
	AppSearchResponse,
	AppStopResponse,
	AppTtsResponse,
} from "./app-wire.ts";

const NO_STORE = { "cache-control": "no-store" };

export interface AppChannelDeps {
	store: ConversationStore;
	runtime: Runtime;
	// auth.jsonl resolution — the record config.appToken names.
	auth: Pick<AuthStore, "resolve">;
	// Live config + shared post-write hook for app defaults. Conversation
	// settings live separately in SQLite and never rewrite this file.
	configRef: ConfigRef;
	onConfigWritten(): void;
	// Speech→text for speech-flagged attachments, the same seam tg
	// intake runs on voice notes. Absent = transcription unconfigured —
	// the ref keeps speech:true with no transcript and materialization
	// degrades to the path reference.
	transcribe?: (file: SpeechFile) => Promise<string | null>;
	// Reply read-aloud — synthesizeSpeech over the live tts block.
	// Absent or a null return = speech unavailable (503 to the client).
	speak?: (text: string) => Promise<Uint8Array[] | null>;
	// First-turn naming via titleModel — the same closure the tg lane
	// uses for implicit topics. Absent = no auto-titling.
	titleFor?: (text: string) => Promise<string | null>;
}

// ---------- auth ----------

// Boot-time auth mode resolution, called once by the composition root —
// never per request. The return is the auth.jsonl record name
// handleAppApi checks bearer tokens against; undefined means trust
// mode. Both lines are deliberate: the mode states the posture, and the
// funnel warn is the guardrail — trust mode behind a public URL is a
// misconfiguration this line exists to catch.
export function resolveAppAuth(appToken: string | undefined): string | undefined {
	if (appToken === undefined) {
		log.warn("app channel auth: trust mode (no token; tailnet only)");
		log.warn(
			"app channel trust mode must never sit behind a public URL (funnel) — set appToken first",
		);
	} else {
		log.info("app channel auth: token required", { record: appToken });
	}
	return appToken;
}

// Bearer equality without a timing oracle: fixed-length digests of both
// sides, so a wrong token's length leaks nothing.
function bearerMatches(presented: string, expected: string): boolean {
	if (presented === "") return false;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return a.equals(b);
}

// Every /api/app/* request passes here first. Returns null when the
// request may proceed; the Response is the refusal. Trust mode (the
// boot-resolved undefined) passes unconditionally — the tailnet is the
// lock, and the mode was logged once at boot, not per request.
async function appAuth(
	req: Request,
	pathname: string,
	deps: AppChannelDeps,
	appToken: string | undefined,
): Promise<Response | null> {
	if (appToken === undefined) return null;
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
// telegram id can never be submitted through this surface. The shape
// itself is the codec's (appIdOf parses and validates it).
const conversationIdSchema = z
	.string()
	.refine((id): boolean => appIdOf(id) !== null, "expected an app/<id> conversation id");

const chatBody = z
	.object({
		conversationId: conversationIdSchema,
		// `retry` re-runs the newest user message — no append, the same
		// event anchors the new answer (history stays append-only; the
		// client prunes the stale answer locally).
		retry: z.literal(true).optional(),
		message: z
			.looseObject({
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

const renameBody = z.object({ title: z.string().min(1).max(200) });

// The composer's two knobs. A patch with neither is a client bug —
// refuse rather than write a no-op through the file.
const configPatchBody = z
	.object({
		model: z.string().min(1).optional(),
		thinking: z.enum(thinkingLevels).optional(),
	})
	.refine((p) => p.model !== undefined || p.thinking !== undefined, {
		message: "nothing to write",
	});

// Synthesis cost scales with input — 40k chars is well past any real
// reply and still inside chunkSpeech's stride.
const ttsBody = z.object({ text: z.string().min(1).max(40_000) });

// Multipart uploads buffer — cap before formData reads the body, so a
// hostile content-length never reaches memory. 32 MiB covers phone-grade
// photos/video clips; larger belongs to a real upload channel anyway.
const UPLOAD_CAP = 32 * 1024 * 1024;

// ---------- the app's TurnSink: UIMessage stream → SSE verbatim ----------

// The app channel's SSE wire — one shape shared by the submit stream
// (appStreamSink: chunks from the turn's member sink) and the attach
// stream (GET .../stream: chunks from a live-turn subscription).
//
// Bun.serve closes connections that send no bytes for its idleTimeout
// — 10s by default (verified 2026-10-07 on 1.4.2: a silent SSE response
// died at exactly +10.0s; 5s comment pings survived). Tool calls
// silence the UIMessage stream for tens of seconds, so the wire needs a
// heartbeat: SSE comment lines, which spec parsers and eventsource-
// parser (the AI SDK client's) skip without emitting. Ruling recorded in
// design/app.md.
const SSE_HEARTBEAT_MS = 5_000;

function appSseWriter(
	convId: string,
	heartbeatMs: number = SSE_HEARTBEAT_MS,
): {
	body: ReadableStream<Uint8Array>;
	write(chunk: UIMessageChunk): void;
	finish(done: TurnDone): void;
	dispose(): void;
} {
	const enc = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let lastByte = Date.now();
	let beat: ReturnType<typeof setInterval> | undefined;
	const stopBeat = () => {
		if (beat !== undefined) clearInterval(beat);
		beat = undefined;
	};
	const push = (line: string) => {
		if (closed) return;
		try {
			controller.enqueue(enc.encode(line));
			lastByte = Date.now();
		} catch (err) {
			// Bun closes the controller when the wire dies (idle kill or
			// client vanish). The turn keeps writing durable history — but
			// the boundary owes the log a line: this exact silence once ate
			// a whole turn's reply unnoticed (2026-10-07).
			closed = true;
			stopBeat();
			log.warn("app stream wire died mid-turn — writes dropped, turn continues", err, {
				conversation: convId,
			});
		}
	};
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			// Beats only while the wire is silent — real chunks reset the clock.
			// The tick samples 4x per heartbeat window: a tick period equal to
			// the threshold phase-locks with real chunks landing just before
			// each tick and never fires (caught by the ping test, 2026-10-07).
			if (heartbeatMs > 0) {
				beat = setInterval(
					() => {
						if (!closed && Date.now() - lastByte >= heartbeatMs) push(": ping\n\n");
					},
					Math.max(200, Math.floor(heartbeatMs / 4)),
				);
				// A leaked beat must never hold the process (or a test run) open.
				(beat as unknown as { unref?: () => void }).unref?.();
			}
		},
		// Client disconnected mid-turn — the turn keeps writing durable
		// history; only the wire closes. Loudly: same 2026-10-07 lesson.
		cancel() {
			closed = true;
			stopBeat();
			log.warn("app stream client gone — wire closed, turn continues", {
				conversation: convId,
			});
		},
	});
	return {
		body,
		write(chunk) {
			push(`data: ${JSON.stringify(chunk)}\n\n`);
		},
		finish(done) {
			stopBeat();
			// A turn that ended without a finish chunk (fenced by /stop,
			// or crashed) still owes the client a terminal event.
			if (done.kind !== "completed") {
				push(
					`data: ${JSON.stringify({
						type: "error",
						errorText: done.kind === "error" ? done.message : "turn stopped before finishing",
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
		},
		// Orphan paths (204 attach, submit-threw 500s): the writer was
		// constructed — the heartbeat is armed — but no wire will ever
		// consume the body. Stop the beat and close quietly: no frames, no
		// finish line (review 2026-10-07, M1 — a leaked beat enqueues into
		// a stream nobody reads, forever).
		dispose() {
			stopBeat();
			closed = true;
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		},
	};
}

function appStreamSink(convId: string): {
	sink: TurnSink;
	body: ReadableStream<Uint8Array>;
	// Orphan-path cleanup (review M1): a submit that throws after this
	// sink was built leaves the writer's heartbeat armed with no wire.
	dispose(): void;
} {
	const writer = appSseWriter(convId);
	return {
		body: writer.body,
		dispose: writer.dispose,
		sink: {
			// Delta-style delivery hooks are telegram's — the app stream is
			// the raw chunk pass-through alone.
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onStreamChunk(chunk) {
				writer.write(chunk);
			},
			onDone(done) {
				writer.finish(done);
				log.info("app stream finish", { conversation: convId, outcome: done.kind });
			},
		},
	};
}
// ---------- routes ----------

// The composer's readout: the live model ref and thinking rung, the
// favorites list to switch between, and the rungs the active model can
// actually express (thinkingLevelsFor — same table the mini app reads).
function configView(cfg: Config, settings: ModelSettings = cfg): AppConfigView {
	const { provider, modelId } = splitModelRef(settings.model);
	const p = cfg.providers[provider];
	return {
		model: settings.model,
		thinking: settings.thinking,
		favorites: cfg.favorites,
		thinkingLevels:
			p === undefined
				? [...thinkingLevels]
				: [...thinkingLevelsFor(p.kind, modelId, "baseUrl" in p ? p.baseUrl : undefined)],
	};
}

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
			// Creation + snapshot commit together. Reposting the same id
			// preserves its selection rather than reapplying defaults.
			const conv = store.db.transaction(() => {
				const row = store.resolve(
					appAddress(parsed.data.id ?? randomUUID()),
					paths.workspace(),
					deps.configRef.current,
				);
				if (parsed.data.title !== undefined) {
					store.setMeta(row.id, { title: parsed.data.title, titleImplicit: false });
				}
				return store.get(row.id)!;
			})();
			const created = conv;
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

	// Per-conversation settings live in SQLite, not goblin.json5. A
	// patch does not bump the epoch or interrupt the admitted turn.
	const configMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/config$/);
	if (configMatch) {
		const convId = conversationFromSegment(configMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (req.method !== "GET" && req.method !== "PATCH") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (req.method === "PATCH") {
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = configPatchBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			// Body reads yield: recheck the row and live registry now.
			if (store.get(convId.id) === null) {
				return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
			}
			const cfg = deps.configRef.current;
			try {
				// Same provider-ref validation as global config; validate
				// before initialization so a bad patch writes nothing.
				parseConfig({ ...cfg, ...parsed.data });
			} catch (err) {
				if (!(err instanceof z.ZodError)) throw err;
				return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
			}
			store.initializeAppSettings(convId.id, cfg);
			store.setMeta(convId.id, {
				...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
				...(parsed.data.thinking !== undefined ? { thinking: parsed.data.thinking } : {}),
			});
			log.info("app conversation settings changed", {
				conversation: convId.id,
				...parsed.data,
				applies: "next turn",
			});
		}
		const cfg = deps.configRef.current;
		const settings = store.initializeAppSettings(convId.id, cfg);
		return Response.json(configView(cfg, settings), { headers: NO_STORE });
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

	// GET /api/app/conversations/<id>/stream — the resumable-stream
	// attach point (AI SDK reconnectToStream): the wire log of a live
	// turn, replayed from the first chunk, then a live tail until the
	// turn's outcome. A reload mid-turn, a tunnel blip, a second screen
	// — the caller re-watches the in-flight reply instead of staring at
	// a finished-looking chat. No live turn → 204, and the client falls
	// back to history (the SDK's contract).
	const streamMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/stream$/);
	if (streamMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(streamMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const writer = appSseWriter(convId.id);
		const replay = runtime.subscribeLiveChunks(
			convId.id,
			(chunk) => writer.write(chunk),
			(done) => {
				writer.finish(done);
				log.info("app stream finish", {
					conversation: convId.id,
					outcome: done.kind,
					attach: true,
				});
			},
		);
		if (replay === null) {
			// No live turn — but the writer (and its heartbeat) was already
			// constructed (review M1): dispose or the beat leaks for the
			// process lifetime on every attach-with-nothing-to-attach.
			writer.dispose();
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		for (const chunk of replay) writer.write(chunk);
		log.info("app stream attach", { conversation: convId.id, replay: replay.length });
		return new Response(writer.body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
	}

	// PATCH /api/app/conversations/<id> — rename; an explicit operator
	// title wins over the implicit auto-title rule.
	// DELETE /api/app/conversations/<id> — remove the row and everything
	// it owns; a live turn is fenced first so the lane is quiet when the
	// delete lands.
	const convItemMatch = path.match(/^\/api\/app\/conversations\/([^/]+)$/);
	if (convItemMatch) {
		const convId = conversationFromSegment(convItemMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (req.method === "PATCH") {
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = renameBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			store.setMeta(convId.id, { title: parsed.data.title, titleImplicit: false });
			log.info("app conversation renamed", { conversation: convId.id });
			const body: AppConversationRename = { title: parsed.data.title };
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method === "DELETE") {
			const { stopped } = runtime.stop(convId.id);
			store.deleteConversation(convId.id);
			log.info("app conversation deleted", {
				conversation: convId.id,
				turnFenced: stopped,
			});
			return Response.json({ ok: true }, { headers: NO_STORE });
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	// GET /api/app/search?q=…&limit= — FTS over the app pool only; the
	// channels' histories never cross (DESIGN.md: disjoint channels).
	if (path === "/api/app/search") {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const q = (url.searchParams.get("q") ?? "").slice(0, 256);
		const limitParam = Number(url.searchParams.get("limit") ?? "");
		const limit =
			Number.isFinite(limitParam) && limitParam >= 1 ? Math.min(25, Math.floor(limitParam)) : 10;
		const hits = store.searchHistory(q, limit, "app/%");
		log.debug("app history search", { q, hits: hits.length });
		const body: AppSearchResponse = { hits };
		return Response.json(body, { headers: NO_STORE });
	}

	// /api/app/config — defaults for future app conversations. Same
	// last-wins semantics as the mini app's save path: merge the patch
	// over the freshest on-disk file, revalidate, write, swap the ref.
	if (path === "/api/app/config") {
		if (req.method === "GET") {
			return Response.json(configView(deps.configRef.current), { headers: NO_STORE });
		}
		if (req.method === "PATCH" || req.method === "POST") {
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = configPatchBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			try {
				const base = loadConfig() ?? parseConfig(deps.configRef.current);
				const merged = parseConfig({ ...base, ...parsed.data });
				prepareAppSettingsForConfig(store, base, merged);
				writeConfig(merged);
				const fresh = loadConfig();
				if (fresh !== null) deps.configRef.current = fresh;
				deps.onConfigWritten();
				log.info("config written via app channel", {
					model: parsed.data.model,
					thinking: parsed.data.thinking,
				});
				return Response.json(configView(fresh ?? merged), { headers: NO_STORE });
			} catch (err) {
				if (err instanceof z.ZodError) {
					return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
				}
				log.error("app config write failed", err);
				return Response.json({ error: "config write failed" }, { status: 500, headers: NO_STORE });
			}
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	// POST /api/app/tts — read-aloud: reply text → base64 ogg chunks the
	// client plays back-to-back. 503 when speech is unconfigured or
	// ffmpeg was down at boot (configRef.ttsDown), never mid-synthesis.
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

		// Retry re-runs the newest user message — the stored event rides
		// along so the answer anchors to the same seq and nothing is
		// appended twice. A live lane refuses: re-admitting the same user
		// text mid-turn would read as steering input, not "again".
		if (parsed.data.retry === true) {
			if (runtime.busy(convId)) {
				return Response.json(
					{ error: "a turn is already running" },
					{ status: 409, headers: NO_STORE },
				);
			}
			const lastUser = store.history(convId).findLast((m) => m.role === "user");
			if (lastUser === undefined) {
				return Response.json({ error: "nothing to retry" }, { status: 409, headers: NO_STORE });
			}
			log.info("app retry", { conversation: convId, message: lastUser.id });
			const { sink, body, dispose } = appStreamSink(convId);
			// The submit can throw (history append, lane admission) — the
			// Telegram lane wraps the same seam (admitBatch). The stream was
			// never returned, so there is no wire to answer: log with the
			// boundary's own line and hand back a plain 500.
			try {
				runtime.submitPersisted(conv, lastUser, sink);
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

		// Voice-note intake, the same seam tg runs: speech-flagged
		// attachments get their transcript before submit, so a model that
		// can't hear audio reads the words instead of a bare path. A
		// failed transcription keeps the attachment — degrade, don't drop.
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
				}
			}
		}

		// First-burst titling — the tg lane's implicit-topic rule applied
		// to app conversations: the first real text burst names the row
		// via titleModel. Fires beside the turn, not after — the
		// title===null re-check keeps an operator PATCH the winner and a
		// deleted row (mid-flight DELETE) is just skipped.
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

		// Intake boundary: message → app address.
		log.info("app intake", { conversation: convId, message: message.id });
		const { sink, body, dispose } = appStreamSink(convId);
		// Steering and /stop ride the existing lane — a second chat POST
		// while a turn runs queues or steers exactly like Telegram. The
		// submit can throw (history append, lane admission) — the Telegram
		// lane wraps the same seam (admitBatch); here the stream was never
		// returned so there is no wire to answer: log with the boundary's
		// own line and hand back a plain 500.
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

	if (path === "/api/app/attachments") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		// Bound the wire BEFORE parsing: formData() buffers the whole
		// body in memory, and a chunked upload carries no Content-Length
		// at all — the header check alone would let an unbounded stream
		// OOM the process (one process, the bot dies with it). Copy the
		// stream into a capped buffer (check.ts's shared reader), then
		// parse the form from the bounded copy.
		const bytes = await readBodyBytesCapped(req, UPLOAD_CAP);
		if (bytes === null) {
			return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
		}
		// Drop the stale content-length so the rebuilt request's body and
		// header agree; the bounded bytes are the truth now.
		const headers = new Headers(req.headers);
		headers.delete("content-length");
		let form: Awaited<ReturnType<Request["formData"]>>;
		try {
			form = await new Request(req.url, { method: "POST", headers, body: bytes }).formData();
		} catch {
			return Response.json(
				{ error: "expected multipart form" },
				{ status: 400, headers: NO_STORE },
			);
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

	// GET /api/app/attachments/<name> — read-back for stored files (image
	// previews in the transcript, click-through to the full file). The
	// segment must be a plain basename inside workspace/attachments/ —
	// isStoredAttachmentPath is the same confinement check intake runs
	// on client-supplied refs. Dotfiles are upload temps; never serve.
	if (path.startsWith("/api/app/attachments/")) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		let name: string;
		try {
			name = decodeURIComponent(path.slice("/api/app/attachments/".length));
		} catch {
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		}
		const file = join(paths.attachments(), name);
		if (
			name === "" ||
			name.startsWith(".") ||
			basename(name) !== name ||
			!isStoredAttachmentPath(file)
		) {
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		}
		const blob = Bun.file(file);
		if (!(await blob.exists())) {
			return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
		}
		// Saved names carry a uuid stem — the bytes behind a name never
		// change, so the response is immutable-cacheable (private: it's
		// bearer-gated operator content). Uploads are arbitrary bytes —
		// nosniff plus a sandboxed document context keeps them inert, and
		// anything the client doesn't embed inline (non-media types)
		// downloads rather than rendering same-origin.
		const type = blob.type === "" ? "application/octet-stream" : blob.type;
		return new Response(blob, {
			headers: {
				"content-type": type,
				"cache-control": "private, max-age=31536000, immutable",
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
				...(/^(image|audio|video)\//.test(type) ? {} : { "content-disposition": "attachment" }),
			},
		});
	}

	return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
