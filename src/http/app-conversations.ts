import { randomUUID } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { z } from "zod";
import { appAddress, appIdSchema } from "../conversation.ts";
import { contextLimitCached } from "../agent/models-dev.ts";
import { paths, splitModelRef } from "../config.ts";
import { log } from "../log.ts";
import { type Project } from "../projects.ts";
import type {
	AppContextView,
	AppConversationCreate,
	AppConversationList,
	AppConversationPatch,
	AppMessageList,
	AppSearchResponse,
	AppStopResponse,
} from "./app-wire.ts";

import { NO_STORE } from "./app-shared.ts";
import { jsonBodyRefusal } from "./app-auth.ts";
import { appSseWriter } from "./app-sse.ts";

import type { AppChannelDeps } from "./app-channel.ts";
import { conversationFromSegment } from "./app-shared.ts";

const createBody = z.object({
	id: appIdSchema.optional(),
	title: z.string().min(1).max(200).optional(),
	// Project binding — creation only; reposts must repeat the stored
	// value or conflict (design/projects.md).
	projectId: z.string().min(1).optional(),
});

// The row's three mutable fields: title (rename), archived (rail ↔
// archived section), pinned (rail anchor above the activity order). A
// patch with none is a client bug — same "nothing to write" refusal as
// configPatchBody.
const convPatchBody = z
	.object({
		title: z.string().min(1).max(200).optional(),
		archived: z.boolean().optional(),
		pinned: z.boolean().optional(),
	})
	.refine((p) => p.title !== undefined || p.archived !== undefined || p.pinned !== undefined, {
		message: "nothing to write",
	});

// One stored turn's usage — the same narrowing the app client applies
// to message.metadata (ChatView turnMeta). Unknown shapes read as
// absent, never throw: history rows predate the stamp.
function contextUsageOf(m: UIMessage): {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
} | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const usage = (md as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return null;
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
	};
}

export async function handleAppConversationsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;
	if (path === "/api/app/conversations") {
		if (req.method === "GET") {
			const body: AppConversationList = { conversations: store.listAppConversations() };
			log.debug("app conversation list served", { count: body.conversations.length });
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method === "POST") {
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
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
			// Creation + binding + snapshot commit together. Reposting
			// the same id preserves its selection rather than reapplying
			// defaults; a repost whose projectId disagrees with the stored
			// binding conflicts — project membership is fixed at creation
			// (design/projects.md).
			const appId = parsed.data.id ?? randomUUID();
			const convId = `app/${appId}`;
			const outcome = store.db.transaction(
				():
					| { kind: "ok"; conv: NonNullable<ReturnType<typeof store.get>> }
					| { kind: "conflict"; bound: string | null }
					| { kind: "noProject" }
					| { kind: "archived" } => {
					const existing = store.get(convId);
					if (existing !== null && existing.projectId !== (parsed.data.projectId ?? null)) {
						return { kind: "conflict", bound: existing.projectId };
					}
					let project: Project | null = null;
					if (existing === null && parsed.data.projectId !== undefined) {
						project = deps.projects.get(parsed.data.projectId);
						if (project === null) return { kind: "noProject" };
						if (project.archivedAt !== null) return { kind: "archived" };
					}
					const row = store.resolve(appAddress(appId), paths.workspace(), deps.configRef.current);
					if (existing === null && project !== null) {
						store.bindProject(row.id, project.id);
						// A memory-off project's chats arrive excluded — a
						// birth-time stamp, so no epoch fence is owed.
						if (project.memory === "off") store.setMeta(row.id, { memoryExcluded: true });
					}
					if (parsed.data.title !== undefined) {
						store.setMeta(row.id, { title: parsed.data.title, titleImplicit: false });
					}
					return { kind: "ok", conv: store.get(row.id)! };
				},
			)();
			if (outcome.kind === "conflict") {
				return Response.json(
					{
						error: `conversation ${convId} is bound to ${outcome.bound ?? "no project"}; project binding is fixed at creation`,
					},
					{ status: 409, headers: NO_STORE },
				);
			}
			if (outcome.kind === "noProject") {
				return Response.json({ error: "no such project" }, { status: 404, headers: NO_STORE });
			}
			if (outcome.kind === "archived") {
				return Response.json(
					{ error: "project is archived — unarchive it to open chats there" },
					{ status: 422, headers: NO_STORE },
				);
			}
			const conv = outcome.conv;
			log.info("app conversation opened", {
				conversation: conv.id,
				...(conv.projectId !== null ? { project: conv.projectId } : {}),
			});
			const body: AppConversationCreate = {
				id: conv.id,
				title: conv.title,
				createdAt: conv.createdAt,
			};
			return Response.json(body, { status: 201, headers: NO_STORE });
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	// GET /api/app/conversations/<id>/context — the last turn's window
	// utilization plus cache-hit rates across stored turns. Read-only:
	// no settings initialization, no epoch fence.
	const contextMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/context$/);
	if (contextMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(contextMatch[1]!);
		if (convId instanceof Response) return convId;
		const row = store.get(convId.id);
		if (row === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const model = row.model ?? deps.configRef.current.model;
		const found: {
			input: number | null;
			output: number | null;
			cacheRead: number | null;
			cacheWrite: number | null;
		}[] = [];
		for (const m of store.history(convId.id)) {
			if (m.role !== "assistant") continue;
			const u = contextUsageOf(m);
			if (u !== null) found.push(u);
		}
		const last = found.at(-1) ?? null;
		const rates: number[] = [];
		for (const u of found) {
			if (u.input !== null && u.input > 0 && u.cacheRead !== null) {
				rates.push(u.cacheRead / u.input);
			}
		}
		let limit: number | null = null;
		try {
			const { provider, modelId } = splitModelRef(model);
			limit = contextLimitCached(provider, modelId);
		} catch {
			limit = null;
		}
		const input = last?.input ?? null;
		const body: AppContextView = {
			model,
			input,
			output: last?.output ?? null,
			cacheRead: last?.cacheRead ?? null,
			cacheWrite: last?.cacheWrite ?? null,
			cacheHitRate:
				last !== null && last.input !== null && last.input > 0 && last.cacheRead !== null
					? last.cacheRead / last.input
					: null,
			avgCacheHitRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
			limit,
			pct:
				input !== null && limit !== null && limit > 0
					? Math.round((input / limit) * 1000) / 10
					: null,
			turns: found.filter((u) => u.input !== null).length,
		};
		log.debug("app context served", {
			conversation: convId.id,
			input,
			limit,
			turns: body.turns,
		});
		return Response.json(body, { headers: NO_STORE });
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
	// a finished-looking chat. No live turn → 204 (the SDK's contract) —
	// and because the runtime persists each reply before it retires the
	// wire, that 204 also promises durable history is final; the client
	// re-reads and merges it (#79, pinned by test below).
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

	// PATCH /api/app/conversations/<id> — rename and/or archive toggle.
	// An explicit operator title wins over the implicit auto-title rule.
	// Archiving is list visibility only: no fence, the row keeps taking
	// turns — and the next appended event clears the flag (auto-unarchive
	// in store.append). Pinning is refused on archived rows (409): a row
	// hidden from the rail can't be anchored above it.
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
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = convPatchBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			if (parsed.data.pinned === true) {
				// Mirror of the store's pin invariant (409, not a 500 from
				// the store's throw): the patch must leave the row
				// unarchived, so {archived: true, pinned: true} conflicts
				// here too.
				const row = store.get(convId.id);
				const stays =
					parsed.data.archived === false ||
					(parsed.data.archived === undefined && row?.archivedAt === null);
				if (!stays) {
					return Response.json(
						{ error: "cannot pin an archived conversation — unarchive it first" },
						{ status: 409, headers: NO_STORE },
					);
				}
			}
			store.setMeta(convId.id, {
				...(parsed.data.title !== undefined
					? { title: parsed.data.title, titleImplicit: false }
					: {}),
				...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {}),
				...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
			});
			if (parsed.data.title !== undefined) {
				log.info("app conversation renamed", { conversation: convId.id });
			}
			if (parsed.data.archived !== undefined) {
				log.info(
					parsed.data.archived ? "app conversation archived" : "app conversation unarchived",
					{ conversation: convId.id },
				);
			}
			if (parsed.data.pinned !== undefined) {
				log.info(parsed.data.pinned ? "app conversation pinned" : "app conversation unpinned", {
					conversation: convId.id,
				});
			}
			const body: AppConversationPatch = {
				...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
				...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {}),
				...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
			};
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
		// An overlong q refuses rather than silently truncating — the
		// operator log route's ruling.
		const q = z
			.string()
			.max(256)
			.safeParse(url.searchParams.get("q") ?? "");
		if (!q.success) return Response.json({ error: "bad q" }, { status: 400, headers: NO_STORE });
		const limitParam = Number(url.searchParams.get("limit") ?? "");
		const limit =
			Number.isFinite(limitParam) && limitParam >= 1 ? Math.min(25, Math.floor(limitParam)) : 10;
		const hits = store.searchHistory(q.data, limit, "app/%");
		log.debug("app history search", { q: q.data, hits: hits.length });
		const body: AppSearchResponse = { hits };
		return Response.json(body, { headers: NO_STORE });
	}

	// /api/app/config — defaults for future app conversations. Same
	// last-wins semantics as the mini app's save path: merge the patch
	// over the freshest on-disk file, revalidate, write, swap the ref.
	return null;
}
