import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { z } from "zod";
import { contextLimitCached } from "../agent/models-dev.ts";
import { readWorkspaceFile, workspaceReadStatus } from "../box-files.ts";
import { clampThinkingFor } from "../agent/thinking.ts";
import { listCalls } from "../cache-observation.ts";
import { ConfigValidationError, parseConfig, paths, splitModelRef } from "../config.ts";
import { type ConversationStore, DeleteRefused } from "../conversation.ts";
import { appAddress, appIdSchema } from "../conversation-address.ts";
import { flatLine } from "../conversation-events.ts";
import { log } from "../log.ts";
import { projectRollText } from "../rolling.ts";
import { type Project, projectWorkdir } from "../projects.ts";
import { openRatings } from "../reply-ratings.ts";
import { COMPACT_TRIGGER_RATIO, compactTriggerTokens } from "../turn/overflow.ts";
import {
	type AppChannelDeps,
	configPatchBody,
	configView,
	conversationFromSegment,
	jsonBodyRefusal,
	NO_STORE,
	parsedJson,
} from "./app-shared.ts";
import type {
	AppSuggestTitleResponse,
	AppCompactionMark,
	AppContextSegment,
	AppContextView,
	AppQuota,
	AppQuotaWindow,
	AppConversationBranch,
	AppConversationCreate,
	AppConversationList,
	AppConversationMemoryResponse,
	AppConversationMemoryView,
	AppConversationPatch,
	AppMessageList,
	AppRatedReply,
	AppReplyRatingList,
	AppReplyRatingResponse,
	AppWindowView,
} from "./app-wire.ts";

const createBody = z.object({
	id: appIdSchema.optional(),
	title: z.string().min(1).max(200).optional(),
	projectId: z.string().min(1).optional(),
	memoryExcluded: z.boolean().optional(),
});

const branchBody = z.object({ messageId: z.string().min(1).max(200) });

const convPatchBody = z
	.object({
		title: z.string().min(1).max(200).optional(),
		archived: z.boolean().optional(),
		pinned: z.boolean().optional(),
	})
	.refine((p) => p.title !== undefined || p.archived !== undefined || p.pinned !== undefined, {
		message: "nothing to write",
	});

function contextUsageOf(m: UIMessage): {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	lastInput: number | null;
	lastCacheRead: number | null;
	promptChars: Record<string, number> | null;
	quota: AppQuota | null;
} | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const usage = (md as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return null;
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	// Only legacy metadata lacks both fields. Never mix final-step
	// counts with whole-turn billing, even if one final field is missing.
	const hasFinalUsage = "lastInput" in u || "lastCacheRead" in u;
	const promptChars = (md as { promptChars?: unknown }).promptChars;
	let chars: Record<string, number> | null = null;
	if (typeof promptChars === "object" && promptChars !== null) {
		const record = promptChars as Record<string, unknown>;
		if (Object.values(record).every((v) => typeof v === "number")) {
			chars = record as Record<string, number>;
		}
	}
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		lastInput: num(hasFinalUsage ? u.lastInput : u.input),
		lastCacheRead: num(hasFinalUsage ? u.lastCacheRead : u.cacheRead),
		promptChars: chars,
		quota: quotaOf((md as Record<string, unknown>).quota),
	};
}

// The metadata's quota blob is already adapter-validated AppQuota when
// present; anything else never reaches the view.
function quotaOf(v: unknown): AppQuota | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	const win = (w: unknown): AppQuotaWindow | null => {
		if (typeof w !== "object" || w === null) return null;
		const wo = w as Record<string, unknown>;
		if (typeof wo.usedPercent !== "number") return null;
		return {
			usedPercent: wo.usedPercent,
			windowMinutes: typeof wo.windowMinutes === "number" ? wo.windowMinutes : null,
			resetsAt: typeof wo.resetsAt === "number" ? wo.resetsAt : null,
		};
	};
	const primary = win(o.primary);
	const secondary = win(o.secondary);
	if (primary === null && secondary === null) return null;
	return {
		limitName: typeof o.limitName === "string" ? o.limitName : null,
		primary,
		secondary,
	};
}

// Segment keys the itemizer can produce, minus `toolResults` — a subset
// of `history`, scaled separately so the denominator never double-counts.
const SEGMENT_KEYS = [
	"identity",
	"environment",
	"project",
	"agentsMd",
	"userMd",
	"skills",
	"toolDefs",
	"history",
] as const;

function segmentsOf(
	chars: Record<string, number> | null,
	input: number | null,
): AppContextSegment[] | null {
	if (chars === null || input === null || input <= 0) return null;
	const total = SEGMENT_KEYS.reduce((sum, key) => sum + (chars[key] ?? 0), 0);
	if (total <= 0) return null;
	const segments: AppContextSegment[] = [];
	for (const key of SEGMENT_KEYS) {
		const size = chars[key] ?? 0;
		if (size > 0) segments.push({ key, tokens: Math.round((size / total) * input) });
	}
	const toolResults = chars.toolResults ?? 0;
	if (toolResults > 0) {
		segments.push({ key: "toolResults", tokens: Math.round((toolResults / total) * input) });
	}
	return segments;
}

const memoryBody = z.object({ memoryExcluded: z.boolean() }).strict();

const replyRatingBody = z.object({
	messageId: z.string().min(1).max(200),
	rating: z.enum(["up", "down"]),
});

type HistoryDetailEntry = ReturnType<ConversationStore["historyDetail"]>[number];

// Telegram puts the vote row on a turn's final bubble. App turns can
// commit several assistant events for one user anchor (media records,
// then the prose reply), so the rateable event is the last assistant
// event for each anchor — not every assistant row.
function rateableAssistantEntries(detail: HistoryDetailEntry[]): Map<string, HistoryDetailEntry> {
	const lastByAnchor = new Map<number | string, HistoryDetailEntry>();
	let unanchoredRun = 0;
	let inUnanchoredRun = false;
	for (const entry of detail) {
		if (entry.message.role !== "assistant") {
			inUnanchoredRun = false;
			continue;
		}
		if (entry.anchorSeq !== null) {
			lastByAnchor.set(entry.anchorSeq, entry);
			inUnanchoredRun = false;
			continue;
		}
		if (!inUnanchoredRun) unanchoredRun++;
		lastByAnchor.set(`unanchored:${unanchoredRun}`, entry);
		inUnanchoredRun = true;
	}
	return new Map([...lastByAnchor.values()].map((entry) => [entry.message.id, entry]));
}

function ratedReplies(
	store: ConversationStore,
	conversationId: string,
	rateable: Map<string, HistoryDetailEntry>,
): AppRatedReply[] {
	const assistantBySeq = new Map(
		[...rateable.values()].map((entry) => [entry.seq, entry.message.id] as const),
	);
	return openRatings(store.db)
		.listApp(conversationId)
		.flatMap((record) => {
			if (record.eventSeq === null) return [];
			const messageId = assistantBySeq.get(record.eventSeq);
			return messageId === undefined
				? []
				: [
						{
							messageId,
							eventSeq: record.eventSeq,
							anchorSeq: record.anchorSeq,
							rating: record.rating,
							createdAt: record.createdAt,
						},
					];
		});
}

// The titler's input for a re-title: the opening message plus the last
// few user messages (where the chat ended up). Assistant text is noise
// for naming. Total stays under the titler's own input cap.
const TITLE_DIGEST_RECENT = 3;
const TITLE_DIGEST_PART_CHARS = 500;
export function titleDigest(history: readonly UIMessage[]): string {
	const users = history
		.filter((m) => m.role === "user")
		.map((m) => projectRollText(m.parts).trim())
		.filter((t) => t !== "");
	if (users.length === 0) return "";
	const clip = (t: string) => t.slice(0, TITLE_DIGEST_PART_CHARS);
	const first = users[0]!;
	const recent = users.slice(1).slice(-TITLE_DIGEST_RECENT);
	return [`Opening message: ${clip(first)}`, ...recent.map((t) => `Later: ${clip(t)}`)].join("\n\n");
}

export async function handleConversationsRoute(
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
			const appId = parsed.data.id ?? randomUUID();
			const convId = `app/${appId}`;
			const outcome = store.db.transaction(
				():
					| { kind: "ok"; conv: NonNullable<ReturnType<typeof store.get>> }
					| { kind: "conflict"; bound: string | null }
					| { kind: "memoryConflict" }
					| { kind: "noProject" }
					| { kind: "archived" } => {
					const existing = store.get(convId);
					if (existing !== null && existing.projectId !== (parsed.data.projectId ?? null)) {
						return { kind: "conflict", bound: existing.projectId };
					}
					// An explicit memory setting is a create-time assertion —
					// silently dropping it on an existing row would let a
					// caller believe a live conversation is excluded when it
					// is not. Match the effective flag (project-off counts as
					// excluded) or refuse.
					if (existing !== null && parsed.data.memoryExcluded !== undefined) {
						const projectMemory =
							existing.projectId === null
								? null
								: (deps.projects.get(existing.projectId)?.memory ?? null);
						const effectiveExcluded =
							existing.memoryExcluded || projectMemory === "off";
						if (effectiveExcluded !== parsed.data.memoryExcluded) {
							return { kind: "memoryConflict" };
						}
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
					}
					if (
						existing === null &&
						(project?.memory === "off" || parsed.data.memoryExcluded === true)
					) {
						store.setMeta(row.id, { memoryExcluded: true });
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
			if (outcome.kind === "memoryConflict") {
				return Response.json(
					{
						error: `conversation ${convId} already exists — its memory flag is unchanged; PATCH its /memory instead`,
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

	const memoryMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/memory$/);
	if (memoryMatch) {
		const convId = conversationFromSegment(memoryMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const projectMemory =
			conv.projectId === null ? null : (deps.projects.get(conv.projectId)?.memory ?? null);
		if (req.method === "GET") {
			const body: AppConversationMemoryView = {
				memoryExcluded: conv.memoryExcluded,
				projectMemory,
			};
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method !== "PATCH") {
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
		const parsed = memoryBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		if (parsed.data.memoryExcluded === false && projectMemory === "off") {
			return Response.json(
				{ error: "project memory is off — switch the project to shared memory first" },
				{ status: 409, headers: NO_STORE },
			);
		}
		let cancelled = 0;
		if (parsed.data.memoryExcluded !== conv.memoryExcluded) {
			// A flag write, not a settings change: no epoch bump — a running
			// turn finishes, its retention refused at the land-time gate.
			store.setMeta(convId.id, { memoryExcluded: parsed.data.memoryExcluded });
			if (parsed.data.memoryExcluded) {
				cancelled = store.memoryQueue.cancelConversation(convId.id);
			}
			log.info(
				parsed.data.memoryExcluded
					? "app conversation memory excluded"
					: "app conversation memory inclusion restored",
				{ conversation: convId.id, cancelled },
			);
		}
		const body: AppConversationMemoryResponse = {
			memoryExcluded: parsed.data.memoryExcluded,
			projectMemory,
			cancelled,
		};
		return Response.json(body, { headers: NO_STORE });
	}

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
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
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
			if (store.get(convId.id) === null) {
				return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
			}
			const cfg = deps.configRef.current;
			try {
				parseConfig({ ...cfg, ...parsed.data });
			} catch (err) {
				if (err instanceof ConfigValidationError) {
					return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
				}
				if (!(err instanceof z.ZodError)) throw err;
				return Response.json({ error: z.prettifyError(err) }, { status: 422, headers: NO_STORE });
			}
			// The raw stored pair, defaults filling gaps — no heal write:
			// clamping against the outgoing model first could erase a level
			// the destination supports.
			const stored = store.readAppSettings(convId.id, cfg);
			// A stored level the target model can't express is a lie — the
			// write persists what the wire clamp would send instead.
			const thinking = clampThinkingFor(
				cfg.providers,
				parsed.data.model ?? stored.model,
				parsed.data.thinking ?? stored.thinking,
			);
			store.setMeta(convId.id, {
				...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
				thinking,
			});
			log.info("app conversation settings changed", {
				conversation: convId.id,
				...parsed.data,
				...(parsed.data.thinking !== thinking ? { thinkingApplied: thinking } : {}),
				applies: "next turn",
			});
		}
		const cfg = deps.configRef.current;
		const settings = store.initializeAppSettings(convId.id, cfg);
		return Response.json(configView(cfg, settings), { headers: NO_STORE });
	}

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
		const found: NonNullable<ReturnType<typeof contextUsageOf>>[] = [];
		for (const m of store.history(convId.id)) {
			if (m.role !== "assistant") continue;
			const u = contextUsageOf(m);
			if (u !== null) found.push(u);
		}
		const last = found.at(-1) ?? null;
		const rates: number[] = [];
		for (const u of found) {
			const turnInput = u.lastInput;
			const turnCacheRead = u.lastCacheRead;
			if (turnInput !== null && turnInput > 0 && turnCacheRead !== null) {
				rates.push(turnCacheRead / turnInput);
			}
		}
		let limit: number | null = null;
		try {
			const { provider, modelId } = splitModelRef(model);
			limit = contextLimitCached(provider, modelId);
		} catch {
			limit = null;
		}
		const input = last?.lastInput ?? null;
		const cacheRead = last?.lastCacheRead ?? null;
		const body: AppContextView = {
			model,
			input,
			output: last?.output ?? null,
			cacheRead,
			cacheWrite: last?.cacheWrite ?? null,
			cacheHitRate: input !== null && input > 0 && cacheRead !== null ? cacheRead / input : null,
			avgCacheHitRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
			limit,
			pct:
				input !== null && limit !== null && limit > 0
					? Math.round((input / limit) * 1000) / 10
					: null,
			compactAtPct:
				limit !== null && limit > 0
					? Math.round((compactTriggerTokens(limit) / limit) * 1000) / 10
					: COMPACT_TRIGGER_RATIO * 100,
			turns: found.length,
			segments: segmentsOf(last?.promptChars ?? null, input),
			...(last?.quota !== null && last?.quota !== undefined
				? { quota: last.quota }
				: {}),
		};
		log.debug("app context served", {
			conversation: convId.id,
			input,
			limit,
			turns: body.turns,
		});
		return Response.json(body, { headers: NO_STORE });
	}

	// The document reader: a byte route for the app's file modal, not a
	// workspace browser — one conversation's workdir, realpath-contained,
	// capped, with the auth/.git refusals inside readWorkspaceFile.
	const fileMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/file$/);
	if (fileMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(fileMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const from = url.searchParams.get("path") ?? "";
		if (from === "") {
			return Response.json({ error: "missing path" }, { status: 422, headers: NO_STORE });
		}
		let workdir: string;
		try {
			workdir = projectWorkdir(deps.projects, conv);
		} catch (err) {
			// A vanished project dir is a server-side environment failure,
			// not something the request got wrong.
			return Response.json(
				{ error: err instanceof Error ? err.message : String(err) },
				{ status: 500, headers: NO_STORE },
			);
		}
		const r = readWorkspaceFile(workdir, from);
		if ("error" in r) {
			log.info("app file refused", { conversation: conv.id, path: from, reason: r.error });
			return Response.json(
				{ error: r.error },
				{ status: workspaceReadStatus(r), headers: NO_STORE },
			);
		}
		log.debug("app file served", { conversation: conv.id, path: r.path, bytes: r.data.byteLength });
		// Direct navigation must never render a stored document in the app
		// origin — the reader pulls it through fetch and renders it itself.
		return new Response(r.data, {
			headers: {
				"content-type": Bun.file(r.path).type || "application/octet-stream",
				"content-disposition": "attachment",
				"content-security-policy": "sandbox",
				"x-content-type-options": "nosniff",
				...NO_STORE,
			},
		});
	}

	const windowMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/window$/);
	if (windowMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(windowMatch[1]!);
		if (convId instanceof Response) return convId;
		const row = store.get(convId.id);
		if (row === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (deps.windowCapture === undefined) {
			return Response.json(
				{ error: "the context window view is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const stored = deps.windowCapture.read(convId.id);
		const body: AppWindowView = {
			model: row.model ?? deps.configRef.current.model,
			capturedAt: stored === null ? null : new Date(stored.capturedMs).toISOString(),
			capturedModel: stored?.model ?? null,
			steps: stored?.step ?? null,
			segments: stored?.capture.segments ?? null,
			system: stored?.capture.system ?? null,
			tools: stored?.capture.tools ?? null,
			messages: stored?.capture.messages ?? null,
			calls: listCalls(store.db, convId.id).map((c) => ({
				callId: c.callId,
				purpose: c.purpose,
				model: c.model,
				startedMs: c.startedMs,
				finishedMs: c.finishedMs,
				status: c.status,
				inputTokens: c.inputTokens,
				outputTokens: c.outputTokens,
				cacheRead: c.cacheRead,
				cacheWrite: c.cacheWrite,
				prefixRelation: c.prefixRelation,
				sharedMessages: c.sharedMessages,
			})),
		};
		log.debug("app window served", {
			conversation: convId.id,
			captured: stored !== null,
			calls: body.calls.length,
			messages: body.messages?.length ?? 0,
		});
		return Response.json(body, { headers: NO_STORE });
	}

	const ratingsMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/ratings$/);
	if (ratingsMatch) {
		const convId = conversationFromSegment(ratingsMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const detail = store.historyDetail(convId.id);
		const rateable = rateableAssistantEntries(detail);
		const ratings = openRatings(store.db);
		if (req.method === "GET") {
			const body: AppReplyRatingList = {
				ratings: ratedReplies(store, convId.id, rateable),
			};
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const body = await parsedJson(req, replyRatingBody);
		if (body instanceof Response) return body;
		const entry = rateable.get(body.messageId);
		if (entry === undefined) {
			return Response.json(
				{ error: "no such assistant reply" },
				{ status: 404, headers: NO_STORE },
			);
		}
		ratings.recordApp({
			conversationId: convId.id,
			anchorSeq: entry.anchorSeq,
			eventSeq: entry.seq,
			rating: body.rating,
		});
		const record = ratings.latestEvent(convId.id, entry.seq)!;
		const rating: AppRatedReply = {
			messageId: entry.message.id,
			eventSeq: entry.seq,
			anchorSeq: record.anchorSeq,
			rating: record.rating,
			createdAt: record.createdAt,
		};
		log.info("app reply rated", {
			conversation: convId.id,
			eventSeq: entry.seq,
			rating: record.rating,
		});
		const response: AppReplyRatingResponse = { rating };
		return Response.json(response, { headers: NO_STORE });
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
		const detail = store.historyDetail(convId.id);
		const rateable = rateableAssistantEntries(detail);
		// Fold marks render where the fold RAN (design/compaction.md →
		// "Fold marks in the app"): afterIndex is the last message whose
		// created_at is at or before the compaction row's — not the cut.
		// eventsCompacted still counts the folded span: consecutive
		// boundaries over the causal order, matching runCompaction's
		// slice. firstKeptIndex is the cut's far side — the first message
		// the model still sees verbatim.
		const causal = detail.map((entry) => entry.anchorSeq ?? entry.seq);
		const createdMs = detail.map((entry) => Date.parse(entry.createdAt));
		const compactions: AppCompactionMark[] = [];
		let prevUpto = 0;
		for (const mark of store.listCompactions(convId.id)) {
			let upto = prevUpto;
			while (upto < causal.length && causal[upto]! <= mark.boundarySeq) upto++;
			const foldMs = Date.parse(mark.createdAt);
			let afterIndex = -1;
			for (let i = 0; i < createdMs.length; i++) {
				if (createdMs[i]! <= foldMs) afterIndex = i;
			}
			compactions.push({
				boundarySeq: mark.boundarySeq,
				afterIndex,
				firstKeptIndex: upto,
				eventsCompacted: upto - prevUpto,
				tailEvents: mark.tailEvents,
				tokensBefore: mark.tokensBefore,
				summary: mark.summary,
				model: mark.model,
				createdAt: mark.createdAt,
			});
			prevUpto = upto;
		}
		const body: AppMessageList = {
			messages: detail.map((entry) => entry.message),
			ratings: ratedReplies(store, convId.id, rateable),
			rateableMessageIds: [...rateable.keys()],
			compactions,
		};
		log.debug("app history served", { conversation: convId.id, messages: body.messages.length });
		return Response.json(body, { headers: NO_STORE });
	}

	// Branch: a new app conversation holding this one's causal prefix
	// through one durable message. The source is never touched — the
	// operator's escape hatch from a destructive edit, and the way to
	// explore a different answer without losing the first.
	const branchMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/branch$/);
	if (branchMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(branchMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = branchBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		// A live turn would copy a half-written tail; an interrupted one
		// would copy an exchange whose reply is still owed.
		if (runtime.busy(convId.id)) {
			return Response.json(
				{ error: "a turn is running — wait for it to finish, then branch" },
				{ status: 409, headers: NO_STORE },
			);
		}
		const target = store.messageEvent(convId.id, parsed.data.messageId);
		if (target === null) {
			return Response.json({ error: "no such message" }, { status: 404, headers: NO_STORE });
		}
		let project: Project | null = null;
		if (conv.projectId !== null) {
			project = deps.projects.get(conv.projectId);
			if (project === null) {
				return Response.json(
					{ error: "the conversation's project no longer exists" },
					{ status: 409, headers: NO_STORE },
				);
			}
			if (project.archivedAt !== null) {
				return Response.json(
					{ error: "project is archived — unarchive it to branch into it" },
					{ status: 422, headers: NO_STORE },
				);
			}
		}
		const title = conv.title === null ? null : `${conv.title} (branch)`.slice(0, 200);
		const forked = store.forkToApp(
			convId.id,
			randomUUID(),
			paths.workspace(),
			title,
			store.readAppSettings(convId.id, deps.configRef.current),
			{
				throughSeq: target.seq,
				projectId: conv.projectId,
				titleImplicit: false,
			},
		);
		if (project?.memory === "off" && !forked.memoryExcluded) {
			store.setMeta(forked.id, { memoryExcluded: true });
		}
		log.info("app conversation branched", {
			conversation: forked.id,
			from: convId.id,
			message: parsed.data.messageId,
			throughSeq: target.seq,
		});
		const body: AppConversationBranch = {
			id: forked.id,
			title: forked.title,
			createdAt: forked.createdAt,
		};
		return Response.json(body, { status: 201, headers: NO_STORE });
	}

	const suggestTitleMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/suggest-title$/);
	if (suggestTitleMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(suggestTitleMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		if (deps.titleFor === undefined) {
			return Response.json({ error: "titling unavailable" }, { status: 503, headers: NO_STORE });
		}
		const input = titleDigest(store.history(convId.id));
		if (input === "") {
			return Response.json(
				{ error: "nothing to title yet — the conversation has no user text" },
				{ status: 422, headers: NO_STORE },
			);
		}
		try {
			const current = flatLine(conv.title ?? "");
			const title = await deps.titleFor(input, current === "" ? undefined : current);
			if (title === null || title === "") {
				log.warn("app suggest-title empty", { conversation: convId.id, inputChars: input.length });
				return Response.json(
					{ error: "no title suggested (is titleModel configured?)" },
					{ status: 502, headers: NO_STORE },
				);
			}
			log.info("app suggest-title", { conversation: convId.id, inputChars: input.length, title });
			const body: AppSuggestTitleResponse = { title };
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			log.error("app suggest-title failed", err, { conversation: convId.id });
			return Response.json(
				{ error: `title suggestion failed: ${err instanceof Error ? err.message : String(err)}` },
				{ status: 502, headers: NO_STORE },
			);
		}
	}

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
			// Ask before fencing: a refused delete must not abort a live
			// turn, and the refusal is the operator's to read, not a 500.
			// The ask is advisory — an anchor minted after it (the turn
			// taking a responsibility before the fence lands) still
			// refuses inside the delete; that answer carries the message
			// too, after the fence.
			const refusal = store.deleteRefusal(convId.id);
			if (refusal !== null) {
				log.warn("app conversation delete refused", {
					conversation: convId.id,
					refusal,
				});
				return Response.json({ error: refusal }, { status: 409, headers: NO_STORE });
			}
			const { stopped } = runtime.stop(convId.id);
			try {
				store.deleteConversation(convId.id);
			} catch (err) {
				if (!(err instanceof DeleteRefused)) throw err;
				log.warn("app conversation delete refused after fence", {
					conversation: convId.id,
					turnFenced: stopped,
					refusal: err.message,
				});
				return Response.json({ error: err.message }, { status: 409, headers: NO_STORE });
			}
			log.info("app conversation deleted", {
				conversation: convId.id,
				turnFenced: stopped,
			});
			return Response.json({ ok: true }, { headers: NO_STORE });
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	return null;
}
