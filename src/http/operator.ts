import { createHash } from "node:crypto";
import { z } from "zod";
import { thinkingLevelsFor } from "../agent/thinking.ts";
import {
	authDefaults,
	type Config,
	ConfigValidationError,
	fetchKinds,
	loadConfig,
	parseConfig,
	paths,
	providerKinds,
	searchKinds,
	transcriptionDefaults,
	transcriptionKinds,
	ttsCloudDefaults,
	writeConfig,
} from "../config.ts";
import { appendAuthRecord, type WritableAuthStore } from "../auth.ts";
import { prepareAppSettingsForConfig, type ConversationStore } from "../conversation.ts";
import type { Delegation, DelegationsStore } from "../delegations.ts";
import { log } from "../log.ts";
import { resolveSkillProposal, type SkillAction, type SkillDecision } from "../skill-decisions.ts";
import { type ForgetSource, forgetDocument } from "../memory/forget.ts";
import {
	type HindsightClient,
	HindsightError,
	identifier,
	type MemoryDocPage,
	type MemoryDocSummary,
	type MemoryFact,
} from "../memory/hindsight.ts";
import { type MemoryContexts, memoryStatus, type MemoryWiring } from "../memory/mod.ts";
import type { BlockedRetention, MemoryQueue, MemoryQueueCounts } from "../memory/queue.ts";
import type { Program, ProgramsStore } from "../programs.ts";
import {
	liveStateOf,
	skillDiskPresence,
	type SkillSourceRow,
	SkillSources,
	skillNameSchema,
} from "../skill-provenance.ts";
import type { SkillDecideResponse } from "./operator-wire.ts";
import {
	AttachmentTooLargeError,
	identityFiles,
	listAttachments,
	listSkills,
	readAttachmentBytes,
	readSkillFile,
	tailLog,
} from "../stateview.ts";
import type {
	ConfigPostBody,
	ConfigResponse,
	MemoriesListResponse,
	MemoryDocDetailResponse,
	MemoryDocListItem,
	MemoryFactItem,
	MemoryForgetResponse,
	MemoryStatusResponse,
	OperatorDelegationItem,
	OperatorDelegationsResponse,
	OperatorProgramItem,
	OperatorProgramsResponse,
	OperatorStatusResponse,
	SecretStoreResponse,
	ThreadSkillItem,
	ThreadSkillsResponse,
} from "./operator-wire.ts";

const NO_STORE = { "cache-control": "no-store" };

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

const ATTACHMENT_SERVE_CAP = 32 * 1024 * 1024;

export interface OperatorDeps {
	configRef: { current: Config };
	onConfigWritten(): void;
	beforeConfigWritten?(previous: Config, next: Config): void;
	memory?: {
		target?: { baseUrl: string; bankId: string };
		counts(): MemoryQueueCounts;
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
	// auth.jsonl record names only — values never cross this surface.
	authNames?: () => string[];
	secrets?: {
		has(name: string): boolean;
		isCommand(name: string): boolean;
		store(name: string, value: string): void;
	};
	service?: {
		version: string;
		startedAt: string;
		restartHints(): string[];
	};
	skillSources?: {
		forConversation(conversationId: string): SkillSourceRow[];
		skillsDir: string;
		proposedDir: string;
	};
	skillDecisions?: {
		decide(skill: string, action: SkillAction): SkillDecision;
	};
}

export type OperatorActor = { via: "mini-app"; userId: number } | { via: "app" };

export interface OperatorSeamsDeps {
	store: ConversationStore;
	memory: MemoryWiring;
	programs: ProgramsStore;
	delegations: DelegationsStore | null;
	skillSources: SkillSources;
	auth: WritableAuthStore;
	paths: { auth(): string; skills(): string; skillsProposed(): string; workspace(): string };
	version: string;
	startedAt: string;
	restartHints(): string[];
}

export function makeOperatorSeams(
	deps: OperatorSeamsDeps,
): Omit<OperatorDeps, "configRef" | "onConfigWritten"> {
	const { store, memory, programs, delegations, skillSources, auth, paths } = deps;
	const surfaces = memory.surfaces;
	const bootConfig = memory.config;
	return {
		beforeConfigWritten: (previous: Config, next: Config) =>
			prepareAppSettingsForConfig(store, previous, next),
		...(surfaces
			? {
					memory: {
						...surfaces,
						...(bootConfig
							? {
									target: {
										baseUrl: bootConfig.baseUrl,
										bankId: bootConfig.bankId,
									},
								}
							: {}),
						counts: () => store.memoryQueue.counts(surfaces.client.target),
						deletingAll: () => store.memoryQueue.deletingCount(),
						blockedDetail: () => store.memoryQueue.blockedDetail(surfaces.client.target),
					},
				}
			: {}),
		programs,
		delegations,
		service: { version: deps.version, startedAt: deps.startedAt, restartHints: deps.restartHints },
		authNames: () => auth.names(),
		secrets: {
			has: (name: string) => auth.has(name),
			isCommand: (name: string) => auth.isCommand(name),
			store: (name: string, value: string) => {
				appendAuthRecord(paths.auth(), name, value);
				auth.put(name, value);
			},
		},
		skillSources: {
			forConversation: (conversationId: string) => skillSources.forConversation(conversationId),
			skillsDir: paths.skills(),
			proposedDir: paths.skillsProposed(),
		},
		skillDecisions: {
			decide: (skill: string, action: SkillAction) =>
				resolveSkillProposal(
					{
						workspaceDir: paths.workspace(),
						skillsDir: paths.skills(),
						proposedDir: paths.skillsProposed(),
						forSkill: (s: string) => skillSources.forSkill(s),
						store,
					},
					skill,
					action,
				),
		},
	};
}

function configTag(config: Config): string {
	return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

let configSaveQueue: Promise<unknown> = Promise.resolve();

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

// Values never log; errors name the record only.
const secretPostBody = z
	.object({
		name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
		value: z.string().trim().min(1).max(4096),
	})
	.strict();

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

export async function handleOperatorRoute(
	deps: OperatorDeps,
	actor: OperatorActor,
	req: Request,
	tail: string,
	url: URL,
): Promise<Response | null> {
	const who = actor.via === "mini-app" ? { userId: actor.userId } : {};

	if (tail === "thinking-levels") {
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
			const attempt = configSaveQueue.then(() => saveConfig(deps, actor, req, body));
			configSaveQueue = attempt.catch((err: unknown) => {
				log.error("config save queue attempt failed", err, who);
			});
			return attempt;
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	if (tail === "secrets") {
		if (req.method !== "POST") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		const secrets = deps.secrets;
		if (secrets === undefined) {
			return Response.json(
				{ error: "the auth store is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = secretPostBody.safeParse(raw);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		const { name, value } = parsed.data;
		if (value.startsWith("!")) {
			return Response.json(
				{
					error:
						'values starting with "!" resolve as shell commands — command records stay hand-edited',
				},
				{ status: 422, headers: NO_STORE },
			);
		}
		if (secrets.isCommand(name)) {
			return Response.json(
				{
					error: `"${name}" resolves through a command record — it stays hand-managed; pick another name`,
				},
				{ status: 409, headers: NO_STORE },
			);
		}
		const replaced = secrets.has(name);
		try {
			secrets.store(name, value);
		} catch (err) {
			log.error(`${actor.via} secret store failed`, err, { ...who, name });
			return Response.json(
				{ error: "the secret could not be written — check the service log" },
				{ status: 500, headers: NO_STORE },
			);
		}
		log.info(`auth record stored via ${actor.via}`, { ...who, name, replaced });
		const stored: SecretStoreResponse = { ok: true, name, replaced };
		return Response.json(stored, { headers: NO_STORE });
	}

	if (tail === "memory/status") {
		const view = memoryStatusResponse(deps);
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
		try {
			const { conversation, q, limit, offset } = parsed.data;
			let page: MemoryDocPage<MemoryDocSummary>;
			if (conversation !== undefined) {
				const prefix = `exchange/${conversation}/`;
				const items: MemoryDocSummary[] = [];
				let total = 0;
				for (let scanOffset = 0; ; ) {
					const batch = await gate.client.listDocuments({
						q: "exchange/",
						limit: 100,
						offset: scanOffset,
					});
					for (const item of batch.items) {
						if (!item.id.startsWith(prefix) || item.id.slice(prefix.length).split("/").length !== 2)
							continue;
						if (total >= offset && items.length < limit) items.push(item);
						total++;
					}
					scanOffset += batch.items.length;
					if (scanOffset >= batch.total) break;
					if (batch.items.length === 0) throw new HindsightError("protocol");
				}
				page = { items, total, limit, offset };
			} else {
				page = await gate.client.listDocuments({
					...(q !== undefined ? { q } : {}),
					limit,
					offset,
				});
			}
			const body: MemoriesListResponse = {
				items: page.items.map(memoryDocListItem),
				total: page.total,
				limit: page.limit,
				offset: page.offset,
			};
			log.debug("memory browse served", {
				...who,
				via: actor.via,
				q: q ?? null,
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

	if (tail === "skills") {
		if (req.method !== "GET")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const body = listSkills(paths.skills(), paths.skillsProposed());
		return Response.json(body, { headers: NO_STORE });
	}

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
		const items: ThreadSkillItem[] = rows.map((row) => {
			const presence = skillDiskPresence(sources.skillsDir, sources.proposedDir, row.skill);
			return {
				skill: row.skill,
				state: liveStateOf(presence),
				pending: presence.proposed,
				kind: row.kind,
				firstAt: row.firstAt,
				lastAt: row.lastAt,
			};
		});
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

	if (tail === "skills/decide") {
		if (req.method !== "POST")
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		const decisions = deps.skillDecisions;
		if (decisions === undefined)
			return Response.json(
				{ error: "skill decisions unavailable" },
				{ status: 503, headers: NO_STORE },
			);
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		const parsed = z
			.object({
				name: skillNameSchema,
				action: z.enum(["install", "discard"]),
			})
			.safeParse(raw);
		if (!parsed.success)
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		const outcome = decisions.decide(parsed.data.name, parsed.data.action);
		if (!outcome.ok) {
			return Response.json(
				{ error: outcome.reason === "gone" ? "proposal not found" : outcome.reason },
				{ status: outcome.reason === "gone" ? 404 : 409, headers: NO_STORE },
			);
		}
		log.info("skill proposal decided via operator door", {
			...who,
			via: actor.via,
			skill: parsed.data.name,
			action: outcome.action,
			...(outcome.action === "install" ? { replaced: outcome.replaced } : {}),
		});
		const body: SkillDecideResponse = {
			ok: true,
			skill: parsed.data.name,
			action: outcome.action,
			replaced: outcome.action === "install" ? outcome.replaced : false,
			state: outcome.action === "install" ? "installed" : "gone",
		};
		return Response.json(body, { headers: NO_STORE });
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
		if (!name.success || name.data.startsWith("."))
			return Response.json({ error: "bad name" }, { status: 400, headers: NO_STORE });
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
