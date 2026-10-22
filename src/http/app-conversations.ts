import { randomUUID } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { z } from "zod";
import { contextLimitCached } from "../agent/models-dev.ts";
import { clampThinkingFor } from "../agent/thinking.ts";
import { ConfigValidationError, parseConfig, paths, splitModelRef } from "../config.ts";
import { appAddress, appIdSchema, type ConversationStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { Project } from "../projects.ts";
import { openRatings } from "../reply-ratings.ts";
import type { TurnToolCall } from "../turn-journal.ts";
import type { InterruptedRunView, ResumeOps, ResumeRefusalCode } from "../turn-resume.ts";
import { refusalText } from "../program-approval.ts";
import { APP_ACTOR } from "../targets.ts";
import { canAuthorizeRetry } from "../turn/retry-guard.ts";
import {
	type AppChannelDeps,
	configPatchBody,
	configView,
	jsonBodyRefusal,
	NO_STORE,
} from "./app-shared.ts";
import { appSseWriter } from "./app-sse.ts";
import type {
	AppApprovalDecisionResponse,
	AppApprovalsResponse,
	AppCompactResponse,
	AppContextSegment,
	AppContextView,
	AppConversationCreate,
	AppConversationList,
	AppConversationMemoryResponse,
	AppConversationMemoryView,
	AppConversationPatch,
	AppDecideResponse,
	AppInterruptedList,
	AppInterruptedRun,
	AppMessageList,
	AppRatedReply,
	AppReplyRatingList,
	AppReplyRatingResponse,
	AppResumeBlocked,
	AppResumeResponse,
	AppRunCall,
	AppSearchResponse,
	AppStopResponse,
} from "./app-wire.ts";

const createBody = z.object({
	id: appIdSchema.optional(),
	title: z.string().min(1).max(200).optional(),
	projectId: z.string().min(1).optional(),
});

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

const decideBody = z.object({
	callId: z.string().min(1).max(200),
	decision: z.enum(["record-result", "authorize-retry", "skip"]),
	note: z.string().max(4000).optional(),
});

const memoryBody = z.object({ memoryExcluded: z.boolean() }).strict();

const programDecisionBody = z.object({
	action: z.enum(["approve", "reject"]),
});

const mailDecisionBody = z.object({
	action: z.enum(["send", "cancel"]),
});

const replyRatingBody = z.object({
	messageId: z.string().min(1).max(200),
	rating: z.enum(["up", "down"]),
});

async function parsedJson<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
	const refusedJson = jsonBodyRefusal(req);
	if (refusedJson !== null) return refusedJson;
	let json: unknown;
	try {
		json = await req.json();
	} catch {
		return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Response.json(
			{ error: z.prettifyError(parsed.error) },
			{ status: 422, headers: NO_STORE },
		);
	}
	return parsed.data;
}

function approvalUnavailable(): Response {
	return Response.json(
		{ error: "approvals are not configured" },
		{ status: 503, headers: NO_STORE },
	);
}

function appRunCall(c: TurnToolCall): AppRunCall {
	return {
		toolCallId: c.toolCallId,
		name: c.name,
		args: c.args,
		state: c.state,
		result: c.result,
		error: c.error,
		resolutionNote: c.resolutionNote,
		resolvedMs: c.resolvedMs,
		canAuthorizeRetry: canAuthorizeRetry(c),
	};
}

function appInterruptedRun(view: InterruptedRunView): AppInterruptedRun {
	return {
		runId: view.run.runId,
		resumedFrom: view.run.resumedFrom,
		startedMs: view.run.startedMs,
		finishedMs: view.run.finishedMs,
		calls: view.run.calls,
		toolCalls: view.calls.map(appRunCall),
	};
}

function refusalStatus(code: ResumeRefusalCode): number {
	switch (code) {
		case "not-found":
			return 404;
		case "conflict":
			return 409;
		case "invalid":
			return 422;
		case "unavailable":
			return 503;
	}
}

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

export async function handleConversationsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;
	const { store, runtime } = deps;

	if (path === "/api/app/approvals") {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const body: AppApprovalsResponse = {
			programs: deps.approvals.program.pending().map((proposal) => ({
				id: proposal.id,
				kind: proposal.kind,
				targetId: proposal.targetId,
				target: proposal.target,
				state: proposal.state,
				createdAt: proposal.createdAt,
				decidedAt: proposal.decidedAt,
				decidedBy: proposal.decidedBy,
				activatedId: proposal.activatedId,
				candidate: deps.approvals!.program.candidate(proposal),
			})),
			mail: deps.approvals.mail.pending().map((row) => ({
				id: row.id,
				to: row.to,
				cc: row.cc,
				subject: row.subject,
				body: row.body,
				replyToId: row.replyToId,
				target: row.target,
				status: row.status,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
				decidedAt: row.decidedAt,
				decidedBy: row.decidedBy,
				sentId: row.sentId,
			})),
		};
		return Response.json(body, { headers: NO_STORE });
	}

	const programApprovalMatch = path.match(/^\/api\/app\/approvals\/program\/(\d+)$/);
	if (programApprovalMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const body = await parsedJson(req, programDecisionBody);
		if (body instanceof Response) return body;
		const outcome = await deps.approvals.program.decide(
			Number(programApprovalMatch[1]),
			body.action,
			APP_ACTOR,
		);
		const response: AppApprovalDecisionResponse =
			outcome.kind === "activated"
				? {
						status: "activated",
						message: `program "${outcome.program.name}" is active`,
						...(outcome.hookUrl !== undefined ? { hookUrl: outcome.hookUrl } : {}),
					}
				: outcome.kind === "rejected"
					? { status: "rejected", message: "proposal rejected — nothing was granted" }
					: outcome.kind === "needs-public-url"
						? {
								status: "needs-public-url",
								message:
									"publicUrl isn't set — set it in settings, then approve again; the proposal stays pending",
							}
						: {
								status: "refused",
								message: refusalText(outcome.refusal),
							};
		return Response.json(response, {
			status: outcome.kind === "needs-public-url" ? 422 : 200,
			headers: NO_STORE,
		});
	}

	const mailApprovalMatch = path.match(/^\/api\/app\/approvals\/mail\/(\d+)$/);
	if (mailApprovalMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (deps.approvals === undefined) return approvalUnavailable();
		const body = await parsedJson(req, mailDecisionBody);
		if (body instanceof Response) return body;
		const outcome = await deps.approvals.mail.decide(
			Number(mailApprovalMatch[1]),
			body.action,
			APP_ACTOR,
		);
		const response: AppApprovalDecisionResponse = {
			status: outcome.kind,
			message:
				outcome.kind === "gone"
					? "draft gone"
					: outcome.kind === "settled"
						? `already ${outcome.row.status}`
						: outcome.kind === "busy"
							? "sending — wait for the verdict"
							: outcome.kind === "expired"
								? "draft expired"
								: outcome.kind === "cancelled"
									? "draft cancelled — never sent"
									: outcome.kind === "sent"
										? "draft sent"
										: outcome.kind === "retry"
											? outcome.message
											: "send raced another decision",
		};
		return Response.json(response, { headers: NO_STORE });
	}

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
			store.applySettings(convId.id, { memoryExcluded: parsed.data.memoryExcluded });
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
			turns: found.length,
			segments: segmentsOf(last?.promptChars ?? null, input),
		};
		log.debug("app context served", {
			conversation: convId.id,
			input,
			limit,
			turns: body.turns,
		});
		return Response.json(body, { headers: NO_STORE });
	}

	const interruptedMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/interrupted$/);
	if (interruptedMatch) {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(interruptedMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const body: AppInterruptedList = {
			runs: ops.interrupted(convId.id).map(appInterruptedRun),
		};
		return Response.json(body, { headers: NO_STORE });
	}

	const decideMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/runs\/([^/]+)\/decide$/);
	if (decideMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(decideMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
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
		const parsed = decideBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const outcome = ops.decide(
			convId.id,
			decideMatch[2]!,
			parsed.data.callId,
			parsed.data.decision,
			parsed.data.note,
		);
		if (outcome.kind === "ok") {
			const body: AppDecideResponse = { ok: true };
			return Response.json(body, { headers: NO_STORE });
		}
		log.info("app decide refused", {
			conversation: convId.id,
			run: decideMatch[2],
			reason: outcome.reason,
		});
		return Response.json(
			{ error: outcome.reason },
			{ status: refusalStatus(outcome.code), headers: NO_STORE },
		);
	}

	const resumeMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/runs\/([^/]+)\/resume$/);
	if (resumeMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(resumeMatch[1]!);
		if (convId instanceof Response) return convId;
		if (store.get(convId.id) === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		const ops = deps.resumeOps?.();
		if (ops === undefined) {
			return Response.json(
				{ error: "turn resume is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const outcome = ops.resume(convId.id, resumeMatch[2]!);
		if (outcome.kind === "resumed") {
			log.info("app resume admitted", { conversation: convId.id, run: outcome.runId });
			const body: AppResumeResponse = { resumed: true, runId: outcome.runId };
			return Response.json(body, { headers: NO_STORE });
		}
		if (outcome.kind === "needs-decisions") {
			const body: AppResumeBlocked = {
				error: "undecided tool calls block resume",
				calls: outcome.calls.map(appRunCall),
			};
			return Response.json(body, { status: 409, headers: NO_STORE });
		}
		log.info("app resume refused", {
			conversation: convId.id,
			run: resumeMatch[2],
			reason: outcome.reason,
		});
		return Response.json(
			{ error: outcome.reason },
			{ status: refusalStatus(outcome.code), headers: NO_STORE },
		);
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
		const body: AppMessageList = {
			messages: detail.map((entry) => entry.message),
			ratings: ratedReplies(store, convId.id, rateable),
			rateableMessageIds: [...rateable.keys()],
		};
		log.debug("app history served", { conversation: convId.id, messages: body.messages.length });
		return Response.json(body, { headers: NO_STORE });
	}

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

	const compactMatch = path.match(/^\/api\/app\/conversations\/([^/]+)\/compact$/);
	if (compactMatch) {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const convId = conversationFromSegment(compactMatch[1]!);
		if (convId instanceof Response) return convId;
		const conv = store.get(convId.id);
		if (conv === null) {
			return Response.json({ error: "no such conversation" }, { status: 404, headers: NO_STORE });
		}
		try {
			const outcome = await runtime.compact(conv);
			const body: AppCompactResponse =
				outcome.kind === "compacted"
					? {
							compacted: true,
							eventsCompacted: outcome.eventsCompacted,
							tailEvents: outcome.tailEvents,
							tokensBefore: outcome.tokensBefore,
						}
					: { compacted: false, reason: outcome.reason };
			log.info("app compact", {
				conversation: convId.id,
				kind: outcome.kind,
				...(outcome.kind === "compacted"
					? { events: outcome.eventsCompacted, tokensBefore: outcome.tokensBefore }
					: { reason: outcome.reason }),
			});
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			log.error("app compact failed", err, { conversation: convId.id });
			return Response.json(
				{ error: `compact failed: ${err instanceof Error ? err.message : String(err)}` },
				{ status: 500, headers: NO_STORE },
			);
		}
	}

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
			writer.dispose();
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		for (const chunk of replay) writer.write(chunk);
		log.info("app stream attach", { conversation: convId.id, replay: replay.length });
		return new Response(writer.body, {
			headers: { ...UI_MESSAGE_STREAM_HEADERS, ...NO_STORE },
		});
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

	if (path === "/api/app/search") {
		if (req.method !== "GET") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
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

	return null;
}
