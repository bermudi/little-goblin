import { z } from "zod";
import { log } from "../log.ts";
import { type ForgetSource, forgetDocument } from "../memory/forget.ts";
import {
	type HindsightClient,
	HindsightError,
	identifier,
	type MemoryDocPage,
	type MemoryDocSummary,
	type MemoryFact,
} from "../memory/hindsight.ts";
import { memoryStatus } from "../memory/mod.ts";
import { conversationOfDocId, splitSaves } from "../memory/saves.ts";
import type { OperatorDeps, OperatorRequest } from "./operator.ts";
import { fail, json, methodNotAllowed, readBody } from "./operator-http.ts";
import type {
	MemoriesListResponse,
	MemoryBlockedResponse,
	MemoryDocDetailResponse,
	MemoryDocListItem,
	MemoryFactItem,
	MemoryForgetResponse,
	MemoryForgetThreadResponse,
	MemorySavesResponse,
	MemoryStatusResponse,
} from "./operator-wire.ts";

type Memory = NonNullable<OperatorDeps["memory"]>;

export async function memoryRoute(r: OperatorRequest): Promise<Response | null> {
	const { deps, actor, who, req, tail, url } = r;
	const channel = actor.via === "mini-app" ? "mini-app" : "app";

	if (tail === "memory/status") {
		const view = memoryStatusResponse(deps);
		log.debug("memory status served", {
			...who,
			via: actor.via,
			state: view.state,
			queued: view.queued,
			blocked: view.blocked,
		});
		return json(view);
	}

	if (tail === "memory/blocked") {
		if (req.method !== "POST") return methodNotAllowed();
		const gate = memoryGate(deps);
		if (typeof gate === "string" || gate.queue === undefined || gate.client === undefined) {
			return fail(typeof gate === "string" ? gate : "memory queue is not wired", 503);
		}
		const parsed = await readBody(req, memoryBlockedBody);
		if (parsed instanceof Response) return parsed;
		const scope = parsed.error === undefined ? undefined : { error: parsed.error };
		const affected =
			parsed.action === "retry"
				? gate.queue.retryBlocked(gate.client.target, scope)
				: gate.queue.dismissBlocked(gate.client.target, scope);
		log.info(
			`memory blocked retentions ${parsed.action === "retry" ? "requeued" : "dismissed"} via ${actor.via}`,
			{
				...who,
				affected,
				scoped: scope !== undefined,
				cause: scope?.error ?? null,
			},
		);
		const body: MemoryBlockedResponse = {
			ok: true,
			action: parsed.action,
			affected,
		};
		return json(body);
	}

	if (tail === "memory/saves") {
		if (req.method !== "GET") return methodNotAllowed();
		const gate = browseGate(deps);
		if (typeof gate === "string") return fail(gate, 503);
		const parsed = savesQuerySchema.safeParse({
			...(url.searchParams.has("q") ? { q: url.searchParams.get("q") ?? undefined } : {}),
			limit: url.searchParams.get("limit") ?? undefined,
			offset: url.searchParams.get("offset") ?? undefined,
		});
		if (!parsed.success) return fail(z.prettifyError(parsed.error), 422);
		try {
			const { q, limit, offset } = parsed.data;
			// Hindsight filters only by id substring, so splitting kept from
			// nothing-kept (and matching conversation names) means scanning
			// the whole exchange set, then paging here.
			const rows = (await allExchanges(gate.client)).map((doc) => {
				const conversationId =
					doc.document_metadata?.conversation_id ?? conversationOfDocId(doc.id);
				return {
					doc,
					conversationId,
					name: conversationName(gate.mem, conversationId),
				};
			});
			const split = splitSaves(rows, q);
			const body: MemorySavesResponse = {
				kept: {
					items: split.kept
						.slice(offset, offset + limit)
						.map((row) => memoryDocListItem(row.doc, gate.mem)),
					total: split.kept.length,
					limit,
					offset,
				},
				nothingKept: split.nothingKept,
			};
			log.debug("memory saves served", {
				...who,
				via: actor.via,
				q: q ?? null,
				scanned: rows.length,
				kept: body.kept.total,
				nothingKept: body.nothingKept.total,
				offset,
			});
			return json(body);
		} catch (err) {
			return memoryUpstreamError(err, "memory saves failed");
		}
	}

	if (tail === "memory/documents") {
		if (req.method !== "GET") return methodNotAllowed();
		const gate = browseGate(deps);
		if (typeof gate === "string") return fail(gate, 503);
		const parsed = browseQuerySchema.safeParse({
			...(url.searchParams.has("q") ? { q: url.searchParams.get("q") ?? undefined } : {}),
			...(url.searchParams.has("conversation")
				? { conversation: url.searchParams.get("conversation") ?? undefined }
				: {}),
			limit: url.searchParams.get("limit") ?? undefined,
			offset: url.searchParams.get("offset") ?? undefined,
		});
		if (!parsed.success) return fail(z.prettifyError(parsed.error), 422);
		try {
			const { conversation, q, limit, offset } = parsed.data;
			let page: MemoryDocPage<MemoryDocSummary>;
			if (conversation !== undefined) {
				const docs = await conversationExchanges(gate.client, conversation);
				page = {
					items: docs.slice(offset, offset + limit),
					total: docs.length,
					limit,
					offset,
				};
			} else {
				page = await gate.client.listDocuments({
					...(q !== undefined ? { q } : {}),
					limit,
					offset,
				});
			}
			const body: MemoriesListResponse = {
				items: page.items.map((d) => memoryDocListItem(d, gate.mem)),
				total: page.total,
				limit: page.limit,
				offset: page.offset,
			};
			log.debug("memory browse served", {
				...who,
				via: actor.via,
				q: q ?? null,
				conversation: conversation ?? null,
				total: body.total,
				offset: body.offset,
				returned: body.items.length,
			});
			return json(body);
		} catch (err) {
			return memoryUpstreamError(err, "memory browse failed");
		}
	}

	if (tail.startsWith("memory/documents/")) {
		const id = documentId(tail.slice("memory/documents/".length));
		if (id === null) return fail("no such document", 404);
		if (req.method === "GET") {
			const gate = browseGate(deps);
			if (typeof gate === "string") return fail(gate, 503);
			const started = Date.now();
			try {
				const [doc, facts] = await Promise.all([
					gate.client.getDocument(id),
					gate.client.listMemories({ documentId: id, limit: 200, offset: 0 }),
				]);
				if (doc === null) return fail("no such document", 404);
				const body: MemoryDocDetailResponse = {
					document: memoryDocListItem(
						{
							id: doc.id,
							created_at: doc.created_at,
							updated_at: doc.updated_at,
							text_length: doc.original_text === null ? 0 : doc.original_text.length,
							memory_unit_count: doc.memory_unit_count,
						},
						gate.mem,
					),
					originalText: doc.original_text,
					facts: facts.items.map(memoryFactItem),
					factsTotal: facts.total,
				};
				log.debug("memory document served", {
					...who,
					via: actor.via,
					document: id,
					facts: facts.total,
					ms: Date.now() - started,
				});
				return json(body);
			} catch (err) {
				return memoryUpstreamError(err, "memory document failed");
			}
		}
		if (req.method === "DELETE") {
			const gate = forgetGate(deps);
			if (typeof gate === "string") return fail(gate, 503);
			const started = Date.now();
			try {
				const result = await forgetDocument(gate.source, id, { channel });
				if (result.outcome !== "forgotten") return fail(forgetRefusal(r, id, result, started), 409);
				log.info(`memory forget via ${actor.via}`, {
					...who,
					document: id,
					cancelled: result.cancelled,
					redacted: result.redacted,
					ms: Date.now() - started,
				});
				const body: MemoryForgetResponse = {
					ok: true,
					cancelled: result.cancelled,
					redacted: result.redacted,
				};
				return json(body);
			} catch (err) {
				return memoryUpstreamError(err, "memory forget failed");
			}
		}
		return methodNotAllowed();
	}

	if (tail === "memory/forget-thread") {
		if (req.method !== "POST") return methodNotAllowed();
		const gate = forgetGate(deps);
		if (typeof gate === "string") return fail(gate, 503);
		const parsed = await readBody(req, z.object({ conversation: z.string().min(1).max(256) }));
		if (parsed instanceof Response) return parsed;
		const { conversation } = parsed;
		const started = Date.now();
		try {
			const ids = (await conversationExchanges(gate.client, conversation)).map((d) => d.id);
			// Per document the SAME heavyweight forget the single-doc
			// DELETE runs (suppress, park, remote delete, redact); one
			// failure never stops the rest of the thread.
			const failed: MemoryForgetThreadResponse["failed"] = [];
			let forgotten = 0;
			for (const id of ids) {
				try {
					const result = await forgetDocument(gate.source, id, { channel });
					if (result.outcome === "forgotten") forgotten++;
					else failed.push({ id, error: forgetRefusal(r, id, result, started) });
				} catch (err) {
					if (err instanceof HindsightError) {
						log.warn("memory forget failed", {
							...who,
							document: id,
							kind: err.kind,
							status: err.status,
						});
						failed.push({ id, error: UNAVAILABLE });
					} else {
						log.error("memory forget failed", err, { ...who, document: id });
						failed.push({ id, error: REQUEST_FAILED });
					}
				}
			}
			log.info(`memory thread forget via ${actor.via}`, {
				...who,
				conversation,
				forgotten,
				failed: failed.length,
				ms: Date.now() - started,
			});
			const body: MemoryForgetThreadResponse = {
				ok: true,
				forgotten,
				failed,
				remaining: failed.length,
			};
			return json(body);
		} catch (err) {
			return memoryUpstreamError(err, "memory forget failed");
		}
	}

	return null;
}

const UNAVAILABLE = "memory unavailable — try again later";
const REQUEST_FAILED = "memory request failed — check the service log";

type ForgetResult = Awaited<ReturnType<typeof forgetDocument>>;

type ForgetRefused = Exclude<Awaited<ReturnType<typeof forgetDocument>>, { outcome: "forgotten" }>;

// Why a forget left the document alone, logged.
function forgetRefusal(
	{ actor, who }: OperatorRequest,
	id: string,
	result: ForgetRefused,
	started: number,
): string {
	if (result.outcome === "busy") {
		log.warn(`memory forget via ${actor.via} refused`, {
			...who,
			document: id,
			unsettled: result.unsettled,
			ms: Date.now() - started,
		});
		return "memory for that document is still processing remotely — retry in a minute";
	}
	log.warn(`memory forget via ${actor.via} refused — previous bank not addressable`, {
		...who,
		document: id,
		target: result.target,
		ms: Date.now() - started,
	});
	return "that document has memory work bound to a previous memory bank that can't be reached — nothing was changed; point memory back at that bank (restart) and retry";
}

function documentId(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	const parsed = identifier.safeParse(decoded);
	return parsed.success ? parsed.data : null;
}

// Every exchange document: q='exchange/' pages in limit-100 batches,
// walked to the upstream total.
async function allExchanges(client: HindsightClient): Promise<MemoryDocSummary[]> {
	const docs: MemoryDocSummary[] = [];
	for (let scanOffset = 0; ; ) {
		const batch = await client.listDocuments({
			q: "exchange/",
			limit: 100,
			offset: scanOffset,
		});
		docs.push(...batch.items);
		scanOffset += batch.items.length;
		if (scanOffset >= batch.total) break;
		if (batch.items.length === 0) throw new HindsightError("protocol");
	}
	return docs;
}

// One conversation's exchanges: its prefix plus exactly two more id segments.
async function conversationExchanges(
	client: HindsightClient,
	conversation: string,
): Promise<MemoryDocSummary[]> {
	const prefix = `exchange/${conversation}/`;
	return (await allExchanges(client)).filter(
		(d) => d.id.startsWith(prefix) && d.id.slice(prefix.length).split("/").length === 2,
	);
}

function memoryGate(deps: OperatorDeps): Memory | string {
	const configured = deps.configRef.current.memory;
	const targetChanged =
		configured &&
		deps.memory?.target &&
		(configured.baseUrl !== deps.memory.target.baseUrl ||
			configured.bankId !== deps.memory.target.bankId);
	if (!deps.memory || !configured || targetChanged) {
		return targetChanged
			? "memory destination changed — restart to apply"
			: "memory is not configured";
	}
	return deps.memory;
}

function browseGate(deps: OperatorDeps): { mem: Memory; client: HindsightClient } | string {
	const mem = memoryGate(deps);
	if (typeof mem === "string") return mem;
	if (!mem.client) return "memory browsing is not wired";
	return { mem, client: mem.client };
}

function forgetGate(
	deps: OperatorDeps,
): { mem: Memory; client: HindsightClient; source: ForgetSource } | string {
	const mem = memoryGate(deps);
	if (typeof mem === "string") return mem;
	if (!mem.client || !mem.contexts || !mem.queue || !mem.withWorkerPaused) {
		return "memory forgetting is not wired";
	}
	return {
		mem,
		client: mem.client,
		source: {
			client: mem.client,
			...(mem.clientForTarget ? { clientForTarget: mem.clientForTarget } : {}),
			contexts: mem.contexts,
			queue: mem.queue,
			withWorkerPaused: mem.withWorkerPaused,
		},
	};
}

function memoryUpstreamError(err: unknown, what: string): Response {
	if (err instanceof HindsightError) {
		log.warn(what, { kind: err.kind, status: err.status });
		return fail(UNAVAILABLE, 503);
	}
	log.error(what, err);
	return fail(REQUEST_FAILED, 500);
}

// What the page shows for a conversation: its name, else why it has none.
// Without the lookup seam the raw id stays — the pre-#163 behaviour.
export function conversationName(mem: Memory, id: string | null): string | null {
	if (id === null) return null;
	if (mem.conversationTitle === undefined) return id;
	const found = mem.conversationTitle(id);
	if (found === null) return "Deleted conversation";
	return found.title ?? "Untitled conversation";
}

export function memoryStatusResponse(deps: OperatorDeps): MemoryStatusResponse {
	const gate = memoryGate(deps);
	if (typeof gate === "string") {
		return {
			state: "disabled",
			detail: gate,
			deleting: 0,
			completed: 0,
			blocked: 0,
			dismissed: 0,
			queued: 0,
			lastRecallAt: null,
			lastRecallOk: null,
			topicNote: null,
			blockedDetail: [],
			lastSaveAt: null,
			blockedConversations: [],
			blockedCauses: [],
			retry: null,
		};
	}
	const mem = gate;
	const counts = mem.counts();
	const lastRecallAt = mem.lastRecallAt();
	const lastRecallOk = mem.lastRecallOk();
	const status = memoryStatus({
		enabled: true,
		counts,
		deletingAll: mem.deletingAll(),
		lastRecallOk,
		lastRecallAt,
		blockedDetail: mem.blockedDetail(),
	});
	const target = mem.client?.target;
	const queue = mem.queue;
	const summary =
		queue !== undefined && target !== undefined && counts.blocked > 0
			? queue.blockedSummary(target)
			: null;
	const retry = queue !== undefined && target !== undefined ? queue.retryProgress(target) : null;
	const lastSave = queue !== undefined && target !== undefined ? queue.lastSaveAt(target) : null;
	return {
		state: status.state,
		detail: status.detail,
		deleting: status.deleting,
		completed: counts.completed,
		blocked: counts.blocked,
		dismissed: counts.dismissed,
		queued: status.pending,
		lastRecallAt,
		lastRecallOk,
		topicNote: null,
		blockedDetail: status.blockedDetail.map((b) => ({
			document: b.document,
			error: b.error,
			attempts: b.attempts,
			conversationId: b.conversationId,
			conversationName: conversationName(mem, b.conversationId),
		})),
		lastSaveAt: lastSave === null ? null : new Date(lastSave).toISOString(),
		blockedConversations: (summary?.byConversation ?? []).map((g) => ({
			conversationId: g.conversationId,
			name: conversationName(mem, g.conversationId),
			count: g.count,
		})),
		blockedCauses: (summary?.byCause ?? []).map(({ error, count }) => ({
			error,
			count,
		})),
		retry:
			retry === null
				? null
				: {
						startedAt: new Date(retry.startedAt).toISOString(),
						done: retry.done,
						queued: retry.queued,
						failed: retry.failed,
						conversations: retry.conversations.map((c) => ({
							...c,
							name: conversationName(mem, c.conversationId),
						})),
					},
	};
}

function memoryDocListItem(source: MemoryDocSummary, mem: Memory): MemoryDocListItem {
	const conversationId =
		source.document_metadata?.conversation_id ?? conversationOfDocId(source.id);
	return {
		id: source.id,
		createdAt: source.created_at ?? null,
		updatedAt: source.updated_at ?? null,
		textLength: source.text_length ?? 0,
		factCount: source.memory_unit_count ?? 0,
		conversationId,
		conversationName: conversationName(mem, conversationId),
	};
}

function memoryFactItem(source: MemoryFact): MemoryFactItem {
	return {
		id: source.id,
		text: source.text,
		factType: source.fact_type ?? null,
		state: source.state ?? null,
		occurredStart: source.occurred_start ?? null,
		occurredEnd: source.occurred_end ?? null,
		mentionedAt: source.mentioned_at ?? null,
		entities: source.entities ?? null,
	};
}

const savesQuerySchema = z.object({
	q: z.string().min(1).max(256).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});

const browseQuerySchema = z
	.object({
		q: z.string().min(1).max(256).optional(),
		conversation: z.string().min(1).max(256).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(25),
		offset: z.coerce.number().int().min(0).default(0),
	})
	.refine((v) => !(v.q !== undefined && v.conversation !== undefined), {
		message: "q and conversation are mutually exclusive",
	});

// `error` scopes the action to one cause (an attention card); absent
// means every blocked exchange (the Memory page).
const memoryBlockedBody = z
	.object({
		action: z.enum(["retry", "dismiss"]),
		error: z.string().nullable().optional(),
	})
	.strict();
