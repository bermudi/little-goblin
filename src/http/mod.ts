// Mini-app serving. The process serves an HTTP endpoint on localhost; the
// bot links the page via the chat menu button. Telegram requires HTTPS and
// the page is fetched by the client device, so the public door is a config
// knob (publicUrl → tailscale serve/funnel/any reverse proxy). Nothing
// here assumes a public IP.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { thinkingLevelsFor } from "../agent/providers.ts";
import {
	loadConfig,
	parseConfig,
	fetchKinds,
	providerKinds,
	searchKinds,
	transcriptionDefaults,
	transcriptionKinds,
	writeConfig,
	type Config,
	type ProviderConfig,
	type ThinkingLevel,
} from "../config.ts";
import { log } from "../log.ts";
import { memoryStatus, type MemoryState, type MemoryContexts } from "../memory.ts";
import type { BlockedRetention, MemoryQueue, MemoryQueueCounts } from "../memory-queue.ts";
import type { HindsightClient } from "../hindsight.ts";
// Type-only imports must stay shallow here: app.js's JSDoc wire types
// pull this module into the client tsconfig (DOM lib) — a type import
// of scheduler.ts would drag wake → tg/delivery → agent/tts.ts in with
// it and DOM's stricter BlobPart would fail the client typecheck.
// checkInjection's value import lives in check.ts for the same reason:
// injection.ts → jev.ts is shallow today, but this edge must never
// harden into a value pull of the server graph.
import type { Program, ProgramsStore } from "../programs.ts";
import type { JevClient } from "../jev.ts";
import { forgetDocument, type ForgetSource } from "../memory-forget.ts";
import {
	HindsightError,
	identifier,
	type MemoryDocSummary,
	type MemoryFact,
} from "../hindsight.ts";
import { readBodyCapped, serveInjectionCheck } from "./check.ts";
import { APP_HTML } from "./app.ts";
import { serveAppDist } from "./app-dist.ts";
import { validateInitData, type InitDataUser } from "./auth.ts";

// The mini app's client script, read once at boot and served verbatim at
// /app.js — no build step. A missing file fails here, loudly, before the
// process serves anything.
const APP_JS = readFileSync(join(import.meta.dir, "app.js"), "utf8");

// The page posts a full form snapshot. Require the version of the config
// it loaded, or a second tab/hand edit could be silently overwritten.
function configTag(config: Config): string {
	return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

export interface HttpDeps {
	configRef: { current: Config };
	botToken: string;
	// Called after a successful config write so the process hot-applies
	// model/thinking/favorites (structural fields apply on restart).
	onConfigWritten(): void;
	// Freeze legacy app rows against old defaults before a save. Opaque
	// callback keeps SQLite/runtime out of the client wire graph.
	beforeConfigWritten?(previous: Config, next: Config): void;
	// Long-term memory status — the same seams the /memory command reads
	// (queue counts + blocked detail, bound to the boot-time target, and
	// recall telemetry). Absent = memory not configured at boot. The
	// browse/delete members (client, contexts, queue, withWorkerPaused)
	// are the memories browser's seams — absent in status-only wirings,
	// and the browse routes degrade to "not wired" when missing.
	memory?: {
		/** Boot-bound queue/client destination; edits apply after restart. */
		target?: { baseUrl: string; bankId: string };
		counts(): MemoryQueueCounts;
		blockedDetail(): BlockedRetention[];
		lastRecallOk(): boolean | null;
		lastRecallAt(): string | null;
		/** Memories browser: read Hindsight through goblin's own client. */
		client?: HindsightClient;
		/** Forgetting: reconstruct a previous bank's client from destination history (#87). */
		clientForTarget?: (target: string) => HindsightClient | null;
		/** Forgetting: suppression + recall-snapshot redaction. */
		contexts?: MemoryContexts;
		/** Forgetting: cancel queued retention rows for a document. */
		queue?: MemoryQueue;
		/** Forgetting: quiesce the retention worker around the delete. */
		withWorkerPaused?: <T>(fn: () => Promise<T>) => Promise<T>;
	};
	// Program webhooks: POST /hook/<token>. The token is the credential —
	// no initData on this route (the caller is a CI runner or a GitHub
	// webhook, not a Telegram webview). Absent = no hook route.
	hooks?: {
		programs: ProgramsStore;
		// False once the runtime is shutting down — a wake then only
		// records history without running, so the hit is refused (503)
		// instead of a 202 that silently never executes.
		accepting(): boolean;
		// The firing owner's webhook entry point (scheduler.ts's
		// fireWebhook) — same wake path, owns the webhook accounting
		// (last_run only when landed). The route owns status and the
		// throttle clock.
		fire(program: Program, event: string | undefined, now: Date): boolean;
	};
	// Loopback-only injection scoring (POST /api/check-injection, no
	// initData — the 127.0.0.1 bind + Host check is the auth, same trust
	// class as the hook token-in-URL). The composition root passes the
	// SAME JevClient instance the reviewer holds; http only calls decide.
	// Absent = no reviewer/system1 gate, the route answers 503.
	checkInjection?: { gate: Pick<JevClient, "decide"> };
	// The app channel's API (DESIGN.md, App channel). Auth — bearer
	// token or trust mode — is baked into the closure at boot by the
	// composition root (index.ts): no per-request config read, so a
	// mid-run appToken flip applies only after restart. The handler is
	// injected opaque so the app channel's import graph — runtime, the
	// AI SDK, undici form types — stays out of this module entirely; a
	// type or value edge here would drag them into the client tsconfig's
	// DOM program via app.js's wire types. Absent = every /api/app/*
	// refuses 503 with a log line.
	appApi?: (req: Request, url: URL) => Promise<Response>;
}

const NO_STORE = { "cache-control": "no-store" };
const HTML = { "content-type": "text/html; charset=utf-8", ...NO_STORE };

// The deep link's path segment — mirrors conversation.ts's
// appIdSchema, kept local because a value import of that module would
// drag the server graph (sqlite, memory) into this file's DOM-lib
// typecheck program (the import comment above explains the boundary).
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JS = { "content-type": "text/javascript; charset=utf-8", ...NO_STORE };

// The page's single load-time fetch: the config plus the schema's kind
// lists (single source — config.ts). The client (app.js) types itself
// against this shape, so a field rename here is a typecheck failure
// there, not a silently broken control.
export interface ConfigResponse {
	config: Config;
	providerKinds: typeof providerKinds;
	searchKinds: typeof searchKinds;
	fetchKinds: typeof fetchKinds;
	transcriptionKinds: typeof transcriptionKinds;
	transcriptionDefaults: typeof transcriptionDefaults;
}

// What the page POSTs: the config with optional blocks sent as "" to
// clear (parseConfig normalizes "" away). Purely the wire contract for
// app.js's buildBody() — the handler below still takes unknown and
// validates through zod, which is the actual gate.
export interface ConfigPostBody {
	providers: Record<string, ProviderConfig>;
	model: string;
	// "" clears — server normalizes.
	titleModel: string;
	favorites: string[];
	thinking: ThinkingLevel;
	tts: "" | { kind: "edge"; voice: string; rate: string | undefined; voices: string[] | undefined };
	// Absent/blank fields mean "the kind's default" (model, auth) or
	// "detect" (language); keywords/engine/weights are whistle-only and
	// round-tripped untouched so a page save never drops hand edits.
	transcription:
		| ""
		| {
				kind: (typeof transcriptionKinds)[number];
				model?: string;
				auth?: string;
				language?: string;
				keywords?: string[];
				engine?: string;
				weights?: string;
		  };
	// The vision tool's image-Q&A model — "" clears, like titleModel.
	// mode is a hand-edit escape hatch the page round-trips untouched.
	vision: "" | { model: string; maxTokens: number; mode?: "auto" | "always" };
	search: "" | Array<{ kind: string; auth?: string }>;
	fetch: "" | Array<{ kind: string; auth?: string }>;
	allowedUsers: number[];
	telegram: {
		apiRoot: string | undefined;
		dmGapMinutes: number;
		model?: string;
		thinking?: ThinkingLevel;
	};
	publicUrl: string;
	http: { port: number };
	memory:
		| ""
		| {
				baseUrl: string;
				bankId: string;
				auth: string | undefined;
				budget: "low" | "mid" | "high";
				maxTokens: number | undefined;
				recallTimeoutMs: number | undefined;
		  };
	logLevel: "debug" | "info" | "warn" | "error";
}

// The mini app's read-only view of memory — the same sources the
// /memory command renders, reduced by memoryStatus(). `topicNote` is
// always null: the panel has no conversation address, so "this topic"
// lines belong to /memory in Telegram; the field stays present so the
// shape tells the same story the command does.
export interface MemoryStatusResponse {
	state: MemoryState;
	deleting: number;
	detail: string;
	completed: number;
	blocked: number;
	dismissed: number;
	// memoryStatus's `pending` — pending+submitted, everything the
	// worker still owes Hindsight.
	queued: number;
	lastRecallAt: string | null;
	lastRecallOk: boolean | null;
	topicNote: null;
	blockedDetail: BlockedRetention[];
}

// ---------- memories browser wire types ----------
// The GET /api/memory/documents page item. One retained exchange; the
// dates echo Hindsight's stored timestamps, conversationId is goblin's
// own conversation address (topic:<chat>:<thread> | dm:<chat>).
export interface MemoryDocListItem {
	id: string;
	createdAt: string | null;
	updatedAt: string | null;
	textLength: number;
	factCount: number;
	conversationId: string | null;
}

/** GET /api/memory/documents — one page plus the server-side total. */
export interface MemoriesListResponse {
	items: MemoryDocListItem[];
	total: number;
	limit: number;
	offset: number;
}

/** One extracted fact — what recall actually returns into turns. */
export interface MemoryFactItem {
	id: string;
	text: string;
	factType: string | null;
	// 'valid' | 'invalidated' per Hindsight 0.10 — the page dims
	// anything but valid so corrections are visible.
	state: string | null;
	occurredStart: string | null;
	occurredEnd: string | null;
	mentionedAt: string | null;
	entities: string | null;
}

/** GET /api/memory/documents/<id> — the document plus its facts. */
export interface MemoryDocDetailResponse {
	document: MemoryDocListItem;
	originalText: string | null;
	facts: MemoryFactItem[];
	factsTotal: number;
}

/** DELETE /api/memory/documents/<id> — the forget outcome. */
export interface MemoryForgetResponse {
	ok: true;
	cancelled: number;
	redacted: number;
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

// Query params for GET /api/memory/documents — bounded like every
// boundary; an out-of-range or malformed value is a 422, not a guess.
const browseQuerySchema = z.object({
	q: z.string().min(1).max(256).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	offset: z.coerce.number().int().min(0).default(0),
});

// The boot-target gate every memory route shares: the provider is a
// boot-time snapshot, the config is live — memory removed or re-pointed
// via a save reads as not configured until restart, and a stale
// destination must never be read (or forgotten against). Returns the
// usable deps or the operator-facing reason.
function memoryGate(deps: HttpDeps): NonNullable<HttpDeps["memory"]> | string {
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
	deps: HttpDeps,
): { mem: NonNullable<HttpDeps["memory"]>; client: HindsightClient } | string {
	const mem = memoryGate(deps);
	if (typeof mem === "string") return mem;
	if (!mem.client) return "memory browsing is not wired";
	return { mem, client: mem.client };
}

function forgetGate(
	deps: HttpDeps,
):
	| { mem: NonNullable<HttpDeps["memory"]>; client: HindsightClient; source: ForgetSource }
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

function memoryStatusResponse(deps: HttpDeps): MemoryStatusResponse {
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

const HOOK_BODY_CAP = 32 * 1024;
const HOOK_THROTTLE_MS = 60_000;

export function startHttp(deps: HttpDeps): { port: number; stop(): void } {
	// One fire per program per 60 s — in-memory: a restart resets the
	// window, which is acceptable (the program just runs again).
	const hookLastFired = new Map<number, number>();

	async function handleHook(req: Request, token: string): Promise<Response> {
		const t0 = Date.now();
		const done = (
			status: number,
			program?: Program,
			extraHeaders?: Record<string, string>,
		): Response => {
			log.info("program hook hit", {
				status,
				ms: Date.now() - t0,
				...(program ? { program: program.id, name: program.name } : {}),
			});
			return new Response(null, {
				status,
				headers: { ...NO_STORE, ...extraHeaders },
			});
		};
		if (req.method !== "POST") return done(405);
		const hooks = deps.hooks;
		if (!hooks) return done(404);
		const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
		const program = hooks.programs.findByHook(hash);
		// Unknown and disabled read identically — no existence oracle.
		if (program === null || !program.enabled) return done(404, program ?? undefined);
		const body = await readBodyCapped(req, HOOK_BODY_CAP);
		if (body.oversize) return done(413, program);
		// The row can change while a slow body streams — a disabled or
		// rotated hook is dead by now, and the fire wants the fresh row
		// (the charter may have been reworded mid-upload).
		const fresh = hooks.programs.findByHook(hash);
		if (fresh === null || !fresh.enabled) return done(404, fresh ?? undefined);
		const last = hookLastFired.get(fresh.id);
		const now = new Date();
		if (last !== undefined && now.getTime() - last < HOOK_THROTTLE_MS) {
			return done(429, fresh);
		}
		// No await between this check and fire — a closed runtime only
		// records the submit, so the hit is refused instead of fake-202.
		if (!hooks.accepting()) return done(503, fresh, { "retry-after": "30" });
		const landed = hooks.fire(fresh, body.text, now);
		// Only a landed fire consumes the window: a refused (503) or failed
		// (500) hit leaves it open, so the caller's retry is never answered
		// 429 for a fire that never happened. (last_run stamping is
		// fireWebhook's — this route only owns HTTP.)
		if (landed) {
			hookLastFired.set(fresh.id, now.getTime());
		}
		return done(landed ? 202 : 500, fresh);
	}
	function authedUser(req: Request): InitDataUser | null {
		const initData = req.headers.get("x-init-data") ?? "";
		// Read per-request so config writes take effect without a restart.
		const allowed = new Set(deps.configRef.current.allowedUsers);
		return validateInitData(initData, deps.botToken, allowed);
	}

	// Serialized config saves (audit #15): the POST route chains one save
	// at a time through configSaveQueue — If-Match checks the on-disk tag,
	// and two tabs passing against the same tag must not both write; the
	// second write would silently discard the first (lost update).
	let configSaveQueue: Promise<unknown> = Promise.resolve();
	const saveConfig = async (userId: number, req: Request, body: object): Promise<Response> => {
		let wrote = false;
		try {
			// The page sends a partial; merge over the freshest on-disk
			// config — a hand edit since boot must not be silently
			// discarded by an app save. An invalid on-disk file fails
			// here with its own parse error.
			const base = loadConfig() ?? deps.configRef.current;
			const expected = req.headers.get("if-match");
			if (!expected) {
				log.warn("mini app config save refused — missing version", { userId: userId });
				return Response.json(
					{ error: "load settings before saving" },
					{ status: 428, headers: NO_STORE },
				);
			}
			if (expected !== configTag(base)) {
				log.warn("mini app config save refused — stale version", { userId: userId });
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
			// The mini app is an operator's only door that doesn't need
			// a shell — a save that drops the requester's own id locks
			// them out of it and the bot gate. Refuse before writing.
			if (!merged.allowedUsers.includes(userId)) {
				return Response.json(
					{ error: `config would remove your own telegram user id (${userId})` },
					{ status: 422, headers: NO_STORE },
				);
			}
			deps.beforeConfigWritten?.(normalized, merged);
			writeConfig(merged);
			wrote = true;
			const fresh = loadConfig();
			if (fresh) deps.configRef.current = fresh;
			deps.onConfigWritten();
			log.info("config written via mini app", {
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
			if (!(err instanceof z.ZodError)) {
				log.error("mini app config save failed", err, { userId: userId, wrote });
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
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: deps.configRef.current.http.port,
		// 255 (the max): Bun's 10s default kills long-quiet SSE — tool
		// calls silence the app stream wire for tens of seconds, and a
		// killed wire reads client-side as a dead fetch body.
		// The appSseWriter heartbeat is the actual guarantee;
		// this is the ceiling behind it. Ruling in design/app.md.
		idleTimeout: 255,
		// The HTTP boundary's error trap. Bun.serve has an onError
		// option, but it never fires for handler throws in this Bun
		// (verified: sync and async fetch throws both serve the
		// framework's default error page with the error on stderr) — so
		// the dispatcher is wrapped instead. An unexpected handler
		// throw must land in goblin.log with the request's shape and
		// answer a plain 500: "a screenshot of the symptom plus the log
		// reconstructs what the process did", not a stack page the
		// operator can't correlate.
		async fetch(req) {
			const url = new URL(req.url);
			try {
				return await dispatch(req, url);
			} catch (err) {
				log.error("http request failed", err, {
					method: req.method,
					path: url.pathname,
				});
				return Response.json({ error: "internal" }, { status: 500, headers: NO_STORE });
			}
		},
	});

	async function dispatch(req: Request, url: URL): Promise<Response> {
		if (url.pathname.startsWith("/hook/")) {
			return handleHook(req, url.pathname.slice("/hook/".length));
		}
		if (url.pathname.startsWith("/api/app/")) {
			// The app channel — the wired closure carries the
			// boot-resolved auth mode (trust or bearer).
			if (deps.appApi === undefined) {
				log.warn("app api refused — app surface not wired", { path: url.pathname });
				return Response.json(
					{ error: "app channel is not configured" },
					{ status: 503, headers: NO_STORE },
				);
			}
			return deps.appApi(req, url);
		}
		// The app channel's built client (Vite output in app/dist).
		// Public like the mini app's page — the API carries the auth.
		// The shell itself, never a redirect: url.origin is the Host the
		// backend saw, and any door that rewrites Host to the loopback
		// target (nginx default, some tailscale serve configs) would
		// turn {publicUrl}/app into a bounce to a dead 127.0.0.1 URL
		// (#105) — the deep-link routes below serve it directly too.
		if (url.pathname === "/app") {
			return serveAppDist("");
		}
		// The spin-off deep link (design/app.md → Spin-off → Links):
		// /app/c/<appId> opens one conversation — serve the same
		// client shell, which selects it once the list loads. The id
		// is url-safe by schema, so the raw segment validates — a
		// malformed id is a 404, never an error page.
		if (url.pathname.startsWith("/app/c/")) {
			const appId = url.pathname.slice("/app/c/".length);
			if (!APP_ID_RE.test(appId)) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return serveAppDist("");
		}
		if (url.pathname.startsWith("/app/")) {
			return serveAppDist(url.pathname.slice("/app/".length));
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			// no-store: a webview must never pair stale page code with a
			// fresh /api/config after an update.
			return new Response(APP_HTML, { headers: HTML });
		}
		if (url.pathname === "/app.js") {
			// Static client code, no secrets — same no-store reasoning as the
			// page: never run last version's script against this API.
			return new Response(APP_JS, { headers: JS });
		}
		if (url.pathname === "/api/thinking-levels") {
			const user = authedUser(req);
			if (!user) {
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			// The page passes provider kind + base url from its own form
			// state — an unsaved provider card still resolves correctly.
			const levels = thinkingLevelsFor(
				url.searchParams.get("kind") ?? "",
				url.searchParams.get("model") ?? "",
				url.searchParams.get("base") ?? undefined,
			);
			return Response.json({ levels }, { headers: NO_STORE });
		}
		if (url.pathname === "/api/memory-status") {
			const user = authedUser(req);
			if (!user) {
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			const view = memoryStatusResponse(deps);
			// A read the page polls every 10s — debug, so the boundary is
			// observable without drowning the log at the default level.
			log.debug("memory status served", {
				state: view.state,
				queued: view.queued,
				blocked: view.blocked,
			});
			return Response.json(view, { headers: NO_STORE });
		}
		// ---------- memories browser ----------
		// Read through goblin's own Hindsight client — the service never
		// faces the page. Reads bind to the boot-time destination (the
		// shared gate); a changed block degrades to an operator-facing
		// reason until restart, exactly like the status card.
		if (url.pathname === "/api/memory/documents") {
			const user = authedUser(req);
			if (!user) {
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			if (req.method !== "GET")
				return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
			const gate = browseGate(deps);
			if (typeof gate === "string") {
				return Response.json({ error: gate }, { status: 503, headers: NO_STORE });
			}
			const parsed = browseQuerySchema.safeParse({
				...(url.searchParams.has("q") ? { q: url.searchParams.get("q") ?? undefined } : {}),
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
				const page = await gate.client.listDocuments({
					...(parsed.data.q !== undefined ? { q: parsed.data.q } : {}),
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
					userId: user.id,
					q: parsed.data.q ?? null,
					total: body.total,
					offset: body.offset,
					returned: body.items.length,
				});
				return Response.json(body, { headers: NO_STORE });
			} catch (err) {
				return memoryUpstreamError(err, "memory browse failed");
			}
		}
		const docMatch = url.pathname.match(/^\/api\/memory\/documents\/([^/]+)$/);
		if (docMatch) {
			const user = authedUser(req);
			if (!user) {
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			const rawId = docMatch[1];
			// Malformed percent-encoding (%E0%A4%A, a bare %) throws URIError
			// out of decodeURIComponent — undecodable is just another invalid
			// id here, so answer the route's 404 instead of letting it escape
			// the fetch handler as a generic 500.
			let decoded: string | undefined;
			try {
				decoded = rawId === undefined ? undefined : decodeURIComponent(rawId);
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
						userId: user.id,
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
					const result = await forgetDocument(gate.source, id, { channel: "mini-app" });
					if (result.outcome === "busy") {
						log.warn("memory forget via mini app refused", {
							userId: user.id,
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
						log.warn("memory forget via mini app refused — previous bank not addressable", {
							userId: user.id,
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
					log.info("memory forget via mini app", {
						userId: user.id,
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
		if (url.pathname === "/api/config") {
			const user = authedUser(req);
			if (!user) {
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			if (req.method === "GET") {
				const config = loadConfig() ?? deps.configRef.current;
				return Response.json(
					{
						config,
						providerKinds,
						searchKinds,
						fetchKinds,
						transcriptionKinds,
						transcriptionDefaults,
					} satisfies ConfigResponse,
					{ headers: { ...NO_STORE, etag: configTag(config) } },
				);
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
				// One save at a time (see saveConfig): the queue swallows
				// rejections so a failed save never poisons the next; each
				// attempt answers for itself.
				const attempt = configSaveQueue.then(() => saveConfig(user.id, req, body));
				configSaveQueue = attempt.catch(() => {});
				return attempt;
			}
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		if (url.pathname === "/api/check-injection") {
			return serveInjectionCheck(req, deps.checkInjection);
		}
		return new Response("not found", { status: 404 });
	}

	const port = server.port ?? deps.configRef.current.http.port;
	log.info("mini-app http listening", { port });
	return { port, stop: () => server.stop() };
}
