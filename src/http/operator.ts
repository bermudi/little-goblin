// The operator surface — settings, memory browse/forget, programs,
// delegations, service status — shared verbatim between the two
// doors that can reach it: the mini app's /api/* routes (initData
// auth, actor carries a Telegram user id) and the app channel's
// /api/app/* routes (bearer/trust auth, no user id). Both doors call
// handleOperatorRoute after their own auth ran; the actor only
// changes audit fields and the save lockout guard (the app's schema
// min(1) on operators is the guard there — there is no requester
// id to preserve).
//
// Same import discipline as mod.ts: this module is pulled into the
// client typecheck program via the wire types, so value imports stay
// shallow (config, memory seams, hindsight) and never reach into
// runtime/tg/agent graphs.

import { createHash } from "node:crypto";
import { z } from "zod";
import { thinkingLevelsFor } from "../agent/providers.ts";
import {
	authDefaults,
	loadConfig,
	parseConfig,
	ConfigValidationError,
	fetchKinds,
	providerKinds,
	searchKinds,
	transcriptionDefaults,
	transcriptionKinds,
	ttsCloudDefaults,
	writeConfig,
	paths,
	type Config,
} from "../config.ts";
import { log } from "../log.ts";
import { memoryStatus, type MemoryContexts } from "../memory.ts";
import type { BlockedRetention, MemoryQueue, MemoryQueueCounts } from "../memory-queue.ts";
import {
	HindsightError,
	identifier,
	type HindsightClient,
	type MemoryDocSummary,
	type MemoryFact,
} from "../hindsight.ts";
import { forgetDocument, type ForgetSource } from "../memory-forget.ts";
import {
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	listSkills,
	readAttachmentBytes,
	readSkillFile,
	tailLog,
} from "../stateview.ts";
import type { Delegation, DelegationsStore } from "../delegations.ts";
import type { Program, ProgramsStore } from "../programs.ts";
import { skillLiveState, type SkillSourceRow } from "../skill-provenance.ts";
import type {
	ConfigPostBody,
	ConfigResponse,
	MemoryDocDetailResponse,
	MemoryDocListItem,
	MemoryFactItem,
	MemoryForgetResponse,
	MemoriesListResponse,
	MemoryStatusResponse,
	OperatorDelegationItem,
	OperatorDelegationsResponse,
	OperatorProgramItem,
	OperatorProgramsResponse,
	OperatorStatusResponse,
	ThreadSkillItem,
	ThreadSkillsResponse,
} from "./operator-wire.ts";

const NO_STORE = { "cache-control": "no-store" };

// State viewer name rules (ruling 2026-10-11): a skill/attachment name
// is one path segment; a file path inside a skill may carry slashes but
// every segment must itself be a legal name. Ordinary Unicode, spaces,
// parens and dots are names — only separators, controls and the exact
// "."/".." traversal segments are refused. Both gates sit in front of
// stateview.ts's containment check — validation here is input hygiene,
// containment is the wall.
const SEGMENT_SCHEMA = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[^/\\\x00-\x1f\x7f]+$/u)
	.refine((v) => v !== "." && v !== "..");
const REL_PATH_SCHEMA = z
	.string()
	.min(1)
	.max(4096)
	.refine((v) => v.split("/").every((part) => SEGMENT_SCHEMA.safeParse(part).success), {
		error: "invalid relative path",
	});

// Serving cap for attachments/file — the upload cap's twin (32 MiB);
// the viewer never serves what the composer cannot store.
const ATTACHMENT_SERVE_CAP = 32 * 1024 * 1024;

export interface OperatorDeps {
	configRef: { current: Config };
	onConfigWritten(): void;
	beforeConfigWritten?(previous: Config, next: Config): void;
	// Long-term memory — the same seams the /memory command reads; see
	// HttpDeps.memory for the member-by-member contract.
	memory?: {
		target?: { baseUrl: string; bankId: string };
		counts(): MemoryQueueCounts;
		// Outstanding forget work across all destinations — parked rows bind
		// to the bank that owns them, so this stays visible after a
		// destination change while counts() reads zero.
		deletingAll(): number;
		blockedDetail(): BlockedRetention[];
		lastRecallOk(): boolean | null;
		lastRecallAt(): string | null;
		client?: HindsightClient;
		clientForTarget?: (target: string) => HindsightClient | null;
		contexts?: MemoryContexts;
		queue?: MemoryQueue;
		withWorkerPaused?: <T>(fn: () => Promise<T>) => Promise<T>;
	};
	programs?: Pick<ProgramsStore, "list">;
	delegations?: Pick<DelegationsStore, "list" | "active"> | null;
	// auth.jsonl record names for the settings pickers — names only,
	// never values, and only as the boot-time store sees them (auth
	// edits need the approved restart). Absent = the pickers offer
	// nothing; a name typed against an empty list still saves.
	authNames?: () => string[];
	// Service identity for /status — the composition root owns boot
	// time and knows which fields are boot-pinned.
	service?: {
		version: string;
		startedAt: string;
		restartHints(): string[];
	};
	// Skill provenance reads (design/skills.md → Skill provenance) —
	// the thread panel's data. Absent = the tail 503s with the reason.
	skillSources?: {
		forConversation(conversationId: string): SkillSourceRow[];
		skillsDir: string;
		proposedDir: string;
	};
}

export type OperatorActor = { via: "mini-app"; userId: number } | { via: "app" };

// The page posts a full form snapshot. Require the version of the
// config it loaded, or a second tab/hand edit could be silently
// overwritten.
function configTag(config: Config): string {
	return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

// Serialized config saves across BOTH doors: the If-Match check reads
// the on-disk tag, and two requests passing against the same tag must
// not both write — the second write would silently discard the first
// (lost update). Module-level so a mini-app save and an app save
// serialize against each other, not just within their own door.
let configSaveQueue: Promise<unknown> = Promise.resolve();

// The POST body's key allowlist, tied to the wire type so a
// ConfigPostBody change breaks typecheck. The body merges over the
// saved config, so a key the page doesn't own (hand-edited-only
// blocks like sandbox, delegation, mail, guest, reviewer, system1,
// appToken — or anything new) would be silently accepted by
// parseConfig; the boundary check below refuses it before the save
// is enqueued.
const CONFIG_POST_KEYS = {
	providers: true,
	model: true,
	titleModel: true,
	favorites: true,
	thinking: true,
	tts: true,
	transcription: true,
	vision: true,
	search: true,
	fetch: true,
	operators: true,
	allowedUsers: true,
	telegram: true,
	publicUrl: true,
	http: true,
	memory: true,
	logLevel: true,
} as const satisfies Record<keyof ConfigPostBody, true>;

const CONFIG_POST_TELEGRAM_KEYS = {
	apiRoot: true,
	dmGapMinutes: true,
	model: true,
	thinking: true,
	richReplies: true,
	showReasoning: true,
} as const satisfies Record<keyof ConfigPostBody["telegram"], true>;

// Key shape only — every field is unknown+optional; values stay
// validated by parseConfig in saveConfig. .strict() turns a key not
// in the allowlist into an unrecognized_keys issue.
const configPostBodySchema = z
	.object(
		Object.fromEntries(
			(Object.keys(CONFIG_POST_KEYS) as (keyof ConfigPostBody)[]).map((k) => [
				k,
				k === "telegram"
					? z
							.object(
								Object.fromEntries(
									(
										Object.keys(CONFIG_POST_TELEGRAM_KEYS) as (keyof ConfigPostBody["telegram"])[]
									).map((tk) => [tk, z.unknown().optional()]),
								),
							)
							.strict()
							.optional()
					: z.unknown().optional(),
			]),
		),
	)
	.strict();

// Unknown top-level or telegram.* keys in the body — empty when the
// body is key-clean (value errors are never reported here).
function unknownConfigKeys(body: object): string[] {
	const parsed = configPostBodySchema.safeParse(body);
	if (parsed.success) return [];
	const unknown: string[] = [];
	for (const issue of parsed.error.issues) {
		if (issue.code !== "unrecognized_keys" || !("keys" in issue)) continue;
		const prefix = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
		for (const k of issue.keys) unknown.push(`${prefix}${k}`);
	}
	return unknown;
}

async function saveConfig(
	deps: OperatorDeps,
	actor: OperatorActor,
	req: Request,
	body: object,
): Promise<Response> {
	const who = actor.via === "mini-app" ? { userId: actor.userId } : {};
	let wrote = false;
	try {
		// The page sends a partial; merge over the freshest on-disk
		// config — a hand edit since boot must not be silently
		// discarded by an app save. An invalid on-disk file fails
		// here with its own parse error.
		const base = loadConfig() ?? deps.configRef.current;
		const expected = req.headers.get("if-match");
		if (!expected) {
			log.warn(`${actor.via} config save refused — missing version`, who);
			return Response.json(
				{ error: "load settings before saving" },
				{ status: 428, headers: NO_STORE },
			);
		}
		if (expected !== configTag(base)) {
			log.warn(`${actor.via} config save refused — stale version`, who);
			return Response.json(
				{ error: "settings changed since this page loaded — reopen settings before saving" },
				{ status: 409, headers: NO_STORE },
			);
		}
		// Pin legacy Telegram settings before applying app-default
		// edits. A channel patch must also preserve its transport
		// settings (apiRoot, rolling-DM gap).
		const normalized = parseConfig(base);
		const candidate = { ...normalized, ...body };
		if (
			"telegram" in body &&
			typeof body.telegram === "object" &&
			body.telegram !== null &&
			!Array.isArray(body.telegram)
		) {
			candidate.telegram = { ...normalized.telegram, ...body.telegram };
		}
		const merged = parseConfig(candidate);
		// The mini app is an operator's only door that doesn't need a
		// shell — a save that drops the requester's own id locks them
		// out of it and the bot gate. Refuse before writing. The app
		// door has no requester id; the schema's min(1) on operators
		// is the lockout guard there.
		if (actor.via === "mini-app" && !merged.operators.includes(actor.userId)) {
			return Response.json(
				{ error: `config would remove your own telegram user id (${actor.userId})` },
				{ status: 422, headers: NO_STORE },
			);
		}
		deps.beforeConfigWritten?.(normalized, merged);
		writeConfig(merged);
		wrote = true;
		const fresh = loadConfig();
		if (fresh) deps.configRef.current = fresh;
		deps.onConfigWritten();
		log.info(`config written via ${actor.via}`, {
			...who,
			appModel: merged.model,
			appThinking: merged.thinking,
			telegramModel: merged.telegram.model,
			telegramThinking: merged.telegram.thinking,
		});
		return Response.json(
			{ ok: true },
			{
				headers: { ...NO_STORE, etag: configTag(fresh ?? merged) },
			},
		);
	} catch (err) {
		if (err instanceof ConfigValidationError) {
			return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
		}
		if (!(err instanceof z.ZodError)) {
			log.error(`${actor.via} config save failed`, err, { ...who, wrote });
			return Response.json(
				{
					error: wrote
						? "settings were saved but could not be applied — check the service log"
						: "settings could not be written — check the service log",
				},
				{ status: 500, headers: NO_STORE },
			);
		}
		const msg = z.prettifyError(err);
		return Response.json({ error: msg }, { status: 422, headers: NO_STORE });
	}
}

// ---------- memory gates ----------

// The boot-target gate every memory route shares: the provider is a
// boot-time snapshot, the config is live — memory removed or re-pointed
// via a save reads as not configured until restart, and a stale
// destination must never be read (or forgotten against). Returns the
// usable deps or the operator-facing reason.
function memoryGate(deps: OperatorDeps): NonNullable<OperatorDeps["memory"]> | string {
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

// The memories browser's extra seams — a status-only wiring (tests,
// partial composition) serves status but not browse/delete.
function browseGate(
	deps: OperatorDeps,
): { mem: NonNullable<OperatorDeps["memory"]>; client: HindsightClient } | string {
	const mem = memoryGate(deps);
	if (typeof mem === "string") return mem;
	if (!mem.client) return "memory browsing is not wired";
	return { mem, client: mem.client };
}

function forgetGate(deps: OperatorDeps):
	| {
			mem: NonNullable<OperatorDeps["memory"]>;
			client: HindsightClient;
			source: ForgetSource;
	  }
	| string {
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

// Hindsight failures never echo the service's internals — the response
// is the operator-facing line the chat command uses; the log line
// carries kind/status for reconstruction. Anything else fails loud.
function memoryUpstreamError(err: unknown, what: string): Response {
	if (err instanceof HindsightError) {
		log.warn(what, { kind: err.kind, status: err.status });
		return Response.json(
			{ error: "memory unavailable — try again later" },
			{ status: 503, headers: NO_STORE },
		);
	}
	log.error(what, err);
	return Response.json(
		{ error: "memory request failed — check the service log" },
		{ status: 500, headers: NO_STORE },
	);
}

function memoryStatusResponse(deps: OperatorDeps): MemoryStatusResponse {
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
		blockedDetail: status.blockedDetail,
	};
}

function memoryDocListItem(source: MemoryDocSummary): MemoryDocListItem {
	return {
		id: source.id,
		createdAt: source.created_at ?? null,
		updatedAt: source.updated_at ?? null,
		textLength: source.text_length ?? 0,
		factCount: source.memory_unit_count ?? 0,
		conversationId: source.document_metadata?.conversation_id ?? null,
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

// Query params for the documents list — bounded like every boundary;
// an out-of-range or malformed value is a 422, not a guess. The two
// filters are mutually exclusive: `conversation` is the thread panel's
// server-side translation into the bank's id-substring `q`.
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

// ---------- list projections ----------

function programItem(program: Program): OperatorProgramItem {
	return {
		id: program.id,
		name: program.name,
		charter: program.charter,
		cron: program.cron,
		maxLatenessMinutes: program.maxLatenessMinutes,
		hasHook: program.hookHash !== null,
		mailFilter: program.mailFilter,
		enabled: program.enabled,
		chatId: program.chatId,
		threadId: program.threadId,
		createdAt: program.createdAt,
		lastRun: program.lastRun,
		nextRun: program.nextRun,
	};
}

function delegationItem(row: Delegation): OperatorDelegationItem {
	return {
		id: row.id,
		name: row.name,
		harness: row.harness,
		status: row.status,
		target: row.target,
		task: row.task,
		cwd: row.cwd,
		appConversation: row.appConversation,
		chatId: row.chatId,
		threadId: row.threadId,
		createdAt: row.createdAt,
		promptedAt: row.promptedAt,
		finishedAt: row.finishedAt,
	};
}

// ---------- the router ----------

// tail is the operator route relative to the door's mount point:
// "config", "thinking-levels", "memory/status", "memory/documents",
// "memory/documents/<raw id>", "programs", "delegations", "status",
// and the state viewer (ruling 2026-10-11): "skills", "skills/from",
// "skills/file", "attachments", "attachments/file", "identity", "log".
// Returns null when the tail matches nothing — the caller 404s.
export async function handleOperatorRoute(
	deps: OperatorDeps,
	actor: OperatorActor,
	req: Request,
	tail: string,
	url: URL,
): Promise<Response | null> {
	const who = actor.via === "mini-app" ? { userId: actor.userId } : {};

	if (tail === "thinking-levels") {
		// The page passes provider kind + base url from its own form
		// state — an unsaved provider card still resolves correctly.
		const levels = thinkingLevelsFor(
			url.searchParams.get("kind") ?? "",
			url.searchParams.get("model") ?? "",
			url.searchParams.get("base") ?? undefined,
		);
		return Response.json({ levels }, { headers: NO_STORE });
	}

	if (tail === "config") {
		if (req.method === "GET") {
			const config = loadConfig() ?? deps.configRef.current;
			const body: ConfigResponse = {
				config,
				providerKinds,
				searchKinds,
				fetchKinds,
				transcriptionKinds,
				transcriptionDefaults,
				ttsDefaults: ttsCloudDefaults,
				authDefaults,
				authNames: [...(deps.authNames?.() ?? [])].sort(),
			};
			return Response.json(body, {
				headers: { ...NO_STORE, etag: configTag(config) },
			});
		}
		if (req.method === "POST") {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return Response.json(
					{ error: "expected a json object" },
					{ status: 400, headers: NO_STORE },
				);
			}
			const unknownKeys = unknownConfigKeys(body);
			if (unknownKeys.length > 0) {
				log.warn(`${actor.via} config save refused — unknown keys`, {
					...who,
					keys: unknownKeys,
				});
				return Response.json(
					{ error: `unknown config keys: ${unknownKeys.join(", ")}` },
					{ status: 400, headers: NO_STORE },
				);
			}
			// One save at a time (see configSaveQueue): the queue swallows
			// rejections so a failed save never poisons the next; each
			// attempt answers for itself.
			const attempt = configSaveQueue.then(() => saveConfig(deps, actor, req, body));
			configSaveQueue = attempt.catch((err: unknown) => {
				log.error("config save queue attempt failed", err, who);
			});
			return attempt;
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	if (tail === "memory/status") {
		const view = memoryStatusResponse(deps);
		// A read the page polls — debug, so the boundary is observable
		// without drowning the log at the default level.
		log.debug("memory status served", {
			...who,
			via: actor.via,
			state: view.state,
			queued: view.queued,
			blocked: view.blocked,
		});
		return Response.json(view, { headers: NO_STORE });
	}

	if (tail === "memory/documents") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const gate = browseGate(deps);
		if (typeof gate === "string") {
			return Response.json({ error: gate }, { status: 503, headers: NO_STORE });
		}
		const parsed = browseQuerySchema.safeParse({
			...(url.searchParams.has("q") ? { q: url.searchParams.get("q") ?? undefined } : {}),
			...(url.searchParams.has("conversation")
				? { conversation: url.searchParams.get("conversation") ?? undefined }
				: {}),
			limit: url.searchParams.get("limit") ?? undefined,
			offset: url.searchParams.get("offset") ?? undefined,
		});
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		// The thread panel's filter: the document-id scheme stays server
		// knowledge (design/memory.md → Memories browser) — the trailing
		// slash is what keeps `app/1` from matching `app/12`.
		const filter =
			parsed.data.conversation !== undefined
				? `exchange/${parsed.data.conversation}/`
				: parsed.data.q;
		try {
			const page = await gate.client.listDocuments({
				...(filter !== undefined ? { q: filter } : {}),
				limit: parsed.data.limit,
				offset: parsed.data.offset,
			});
			const body: MemoriesListResponse = {
				items: page.items.map(memoryDocListItem),
				total: page.total,
				limit: page.limit,
				offset: page.offset,
			};
			log.debug("memory browse served", {
				...who,
				via: actor.via,
				q: filter ?? null,
				conversation: parsed.data.conversation ?? null,
				total: body.total,
				offset: body.offset,
				returned: body.items.length,
			});
			return Response.json(body, { headers: NO_STORE });
		} catch (err) {
			return memoryUpstreamError(err, "memory browse failed");
		}
	}

	if (tail.startsWith("memory/documents/")) {
		const rawId = tail.slice("memory/documents/".length);
		// Malformed percent-encoding (%E0%A4%A, a bare %) throws URIError
		// out of decodeURIComponent — undecodable is just another invalid
		// id here, so answer the route's 404 instead of letting it escape
		// the fetch handler as a generic 500.
		let decoded: string | undefined;
		try {
			decoded = decodeURIComponent(rawId);
		} catch {
			decoded = undefined;
		}
		const parsedId = decoded === undefined ? undefined : identifier.safeParse(decoded);
		if (!parsedId || !parsedId.success) {
			return Response.json({ error: "no such document" }, { status: 404, headers: NO_STORE });
		}
		const id = parsedId.data;
		if (req.method === "GET") {
			const gate = browseGate(deps);
			if (typeof gate === "string") {
				return Response.json({ error: gate }, { status: 503, headers: NO_STORE });
			}
			const started = Date.now();
			try {
				const [doc, facts] = await Promise.all([
					gate.client.getDocument(id),
					gate.client.listMemories({ documentId: id, limit: 200, offset: 0 }),
				]);
				if (doc === null) {
					return Response.json({ error: "no such document" }, { status: 404, headers: NO_STORE });
				}
				const body: MemoryDocDetailResponse = {
					document: memoryDocListItem({
						id: doc.id,
						created_at: doc.created_at,
						updated_at: doc.updated_at,
						text_length: doc.original_text === null ? 0 : doc.original_text.length,
						memory_unit_count: doc.memory_unit_count,
					}),
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
				return Response.json(body, { headers: NO_STORE });
			} catch (err) {
				return memoryUpstreamError(err, "memory document failed");
			}
		}
		if (req.method === "DELETE") {
			const gate = forgetGate(deps);
			if (typeof gate === "string") {
				return Response.json({ error: gate }, { status: 503, headers: NO_STORE });
			}
			const started = Date.now();
			try {
				const result = await forgetDocument(gate.source, id, {
					channel: actor.via === "mini-app" ? "mini-app" : "app",
				});
				if (result.outcome === "busy") {
					log.warn(`memory forget via ${actor.via} refused`, {
						...who,
						document: id,
						unsettled: result.unsettled,
						ms: Date.now() - started,
					});
					return Response.json(
						{
							error: "memory for that document is still processing remotely — retry in a minute",
						},
						{ status: 409, headers: NO_STORE },
					);
				}
				if (result.outcome === "foreign-bank") {
					log.warn(`memory forget via ${actor.via} refused — previous bank not addressable`, {
						...who,
						document: id,
						target: result.target,
						ms: Date.now() - started,
					});
					return Response.json(
						{
							error:
								"that document has memory work bound to a previous memory bank that can't be reached — nothing was changed; point memory back at that bank (restart) and retry",
						},
						{ status: 409, headers: NO_STORE },
					);
				}
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
				return Response.json(body, { headers: NO_STORE });
			} catch (err) {
				return memoryUpstreamError(err, "memory forget failed");
			}
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	if (tail === "programs") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		if (!deps.programs) {
			return Response.json({ error: "programs are not wired" }, { status: 503, headers: NO_STORE });
		}
		const body: OperatorProgramsResponse = { programs: deps.programs.list().map(programItem) };
		return Response.json(body, { headers: NO_STORE });
	}

	if (tail === "delegations") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		if (!deps.delegations) {
			return Response.json(
				{ error: "delegation is not configured" },
				{ status: 503, headers: NO_STORE },
			);
		}
		const rows = deps.delegations.list();
		const body: OperatorDelegationsResponse = { delegations: rows.map(delegationItem) };
		return Response.json(body, { headers: NO_STORE });
	}

	if (tail === "status") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const svc = deps.service;
		if (!svc) {
			return Response.json({ error: "status is not wired" }, { status: 503, headers: NO_STORE });
		}
		const programs = deps.programs?.list();
		const delegations = deps.delegations?.list();
		const active = deps.delegations?.active();
		const body: OperatorStatusResponse = {
			version: svc.version,
			startedAt: svc.startedAt,
			uptimeSec: Math.max(0, Math.floor((Date.now() - Date.parse(svc.startedAt)) / 1000)),
			restartHints: svc.restartHints(),
			memory: memoryStatusResponse(deps),
			programs: programs
				? { total: programs.length, enabled: programs.filter((p) => p.enabled).length }
				: null,
			delegations:
				delegations !== undefined && active !== undefined
					? { total: delegations.length, active: active.length }
					: null,
		};
		return Response.json(body, { headers: NO_STORE });
	}

	// ---------- state viewer (ruling 2026-10-11, read-only) ----------

	if (tail === "skills") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const body = listSkills(paths.skills(), paths.skillsProposed());
		return Response.json(body, { headers: NO_STORE });
	}

	// The thread panel's skills half (design/skills.md → Skill
	// provenance): rows the conversation authored, liveness resolved
	// from the catalog at read time. Read-only — approve/discard stays
	// conversational.
	if (tail === "skills/from") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		if (deps.skillSources === undefined)
			return Response.json(
				{ error: "skill provenance unavailable" },
				{ status: 503, headers: NO_STORE },
			);
		const conversation = z
			.string()
			.min(1)
			.max(256)
			.safeParse(url.searchParams.get("conversation") ?? "");
		if (!conversation.success)
			return Response.json(
				{ error: "expected conversation (1-256 chars)" },
				{ status: 422, headers: NO_STORE },
			);
		const sources = deps.skillSources;
		const rows = sources.forConversation(conversation.data);
		const items: ThreadSkillItem[] = rows.map((row) => ({
			skill: row.skill,
			state: skillLiveState(sources.skillsDir, sources.proposedDir, row.skill),
			kind: row.kind,
			firstAt: row.firstAt,
			lastAt: row.lastAt,
		}));
		log.debug("thread skills served", {
			...who,
			via: actor.via,
			conversation: conversation.data,
			returned: items.length,
		});
		const body: ThreadSkillsResponse = { items };
		return Response.json(body, { headers: NO_STORE });
	}

	if (tail === "skills/file") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const origin = z
			.union([z.literal("skills"), z.literal("proposed")])
			.safeParse(url.searchParams.get("origin") ?? "skills");
		if (!origin.success)
			return Response.json({ error: "bad origin" }, { status: 400, headers: NO_STORE });
		const name = SEGMENT_SCHEMA.safeParse(url.searchParams.get("name") ?? "");
		if (!name.success)
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		const rel = REL_PATH_SCHEMA.safeParse(url.searchParams.get("path") ?? "SKILL.md");
		if (!rel.success)
			return Response.json({ error: "bad path" }, { status: 400, headers: NO_STORE });
		// Throws on an over-cap file — loud 500, never a silent truncation.
		const file = readSkillFile(
			paths.skills(),
			paths.skillsProposed(),
			origin.data,
			name.data,
			rel.data,
		);
		if (file === null)
			return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
		return Response.json(file, { headers: NO_STORE });
	}

	if (tail === "attachments") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const body = listAttachments(paths.attachments());
		return Response.json(body, { headers: NO_STORE });
	}

	if (tail === "attachments/file") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const name = SEGMENT_SCHEMA.safeParse(url.searchParams.get("name") ?? "");
		// Dotfiles are persistAttachment's upload temps — the composer's
		// read-back refuses them; same refusal, same shape here.
		if (!name.success || name.data.startsWith("."))
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
		// Matches the upload cap: the viewer never serves more than the
		// composer accepts, and serving is a whole-file read.
		let served: ReturnType<typeof readAttachmentBytes>;
		try {
			served = readAttachmentBytes(paths.attachments(), name.data, ATTACHMENT_SERVE_CAP);
		} catch (e) {
			if (e instanceof AttachmentTooLargeError) {
				return Response.json({ error: "attachment too large" }, { status: 413, headers: NO_STORE });
			}
			throw e;
		}
		if (served === null)
			return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
		// The inert-byte defenses the upload read-back route carries: bytes
		// from outside are never same-origin executable content.
		const inline = /^(image|audio|video)\//.test(served.contentType);
		return new Response(served.bytes, {
			headers: {
				...NO_STORE,
				"content-type": served.contentType,
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
				...(inline ? {} : { "content-disposition": "attachment" }),
			},
		});
	}

	if (tail === "identity") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const body = identityFiles(paths.workspace());
		return Response.json(body, { headers: NO_STORE });
	}

	if (tail === "log") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const limitRaw = url.searchParams.get("limit");
		const limit =
			limitRaw === null
				? { success: true as const, data: 200 }
				: z.coerce.number().int().min(1).max(1000).safeParse(limitRaw);
		if (!limit.success)
			return Response.json({ error: "bad limit" }, { status: 400, headers: NO_STORE });
		const levelRaw = url.searchParams.get("level");
		const level =
			levelRaw === null || levelRaw === ""
				? { success: true as const, data: null }
				: z.enum(["debug", "info", "warn", "error"]).safeParse(levelRaw);
		if (!level.success)
			return Response.json({ error: "bad level" }, { status: 400, headers: NO_STORE });
		const qRaw = url.searchParams.get("q");
		const q =
			qRaw === null || qRaw === ""
				? { success: true as const, data: null }
				: z.string().max(300).safeParse(qRaw);
		if (!q.success) return Response.json({ error: "bad q" }, { status: 400, headers: NO_STORE });
		const body = tailLog(paths.logFile(), {
			limit: limit.data,
			level: level.data,
			q: q.data,
		});
		return Response.json(body, { headers: NO_STORE });
	}

	return null;
}
