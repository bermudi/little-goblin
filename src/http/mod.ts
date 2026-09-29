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
import { loadConfig, parseConfig, fetchKinds, providerKinds, searchKinds, writeConfig, type Config, type ProviderConfig, type ThinkingLevel } from "../config.ts";
import { log } from "../log.ts";
import { memoryStatus, type MemoryState } from "../memory.ts";
import type { BlockedRetention, MemoryQueueCounts } from "../memory-queue.ts";
// Type-only imports must stay shallow here: app.js's JSDoc wire types
// pull this module into the client tsconfig (DOM lib) — a type import
// of scheduler.ts would drag wake → tg/delivery → agent/tts.ts in with
// it and DOM's stricter BlobPart would fail the client typecheck.
import type { Program, ProgramsStore } from "../programs.ts";
import { APP_HTML } from "./app.ts";
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
	// Long-term memory status — the same seams the /memory command reads
	// (queue counts + blocked detail, bound to the boot-time target, and
	// recall telemetry). Absent = memory not configured at boot.
	memory?: {
		/** Boot-bound queue/client destination; edits apply after restart. */
		target?: { baseUrl: string; bankId: string };
		counts(): MemoryQueueCounts;
		blockedDetail(): BlockedRetention[];
		lastRecallOk(): boolean | null;
		lastRecallAt(): string | null;
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
}

const NO_STORE = { "cache-control": "no-store" };
const HTML = { "content-type": "text/html; charset=utf-8", ...NO_STORE };
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
	transcription: "" | { kind: "groq"; model: string; auth: string };
	search: "" | Array<{ kind: string; auth?: string }>;
	fetch: "" | Array<{ kind: string; auth?: string }>;
	allowedUsers: number[];
	telegram: { apiRoot: string | undefined };
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

function memoryStatusResponse(deps: HttpDeps): MemoryStatusResponse {
	// Same gate as the /memory command: the provider is a boot-time
	// snapshot, the config is live — memory removed via a save reads as
	// not configured until restart.
	const configured = deps.configRef.current.memory;
	const targetChanged = configured && deps.memory?.target &&
		(configured.baseUrl !== deps.memory.target.baseUrl || configured.bankId !== deps.memory.target.bankId);
	const mem = deps.memory && configured && !targetChanged ? deps.memory : null;
	if (!mem) {
		return {
			state: "disabled",
			detail: targetChanged ? "memory destination changed — restart to apply" : "memory is not configured",
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

// Read a request body with a hard cap — Content-Length is a hint, not
// the contract, so the stream itself is bounded too.
async function readBodyCapped(
	req: Request,
	cap: number,
): Promise<{ text: string; oversize: boolean }> {
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > cap) return { text: "", oversize: true };
	const body = req.body;
	if (body === null) return { text: "", oversize: false };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > cap) return { text: "", oversize: true };
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks)), oversize: false };
}

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

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: deps.configRef.current.http.port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/hook/")) {
				return handleHook(req, url.pathname.slice("/hook/".length));
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
						} satisfies ConfigResponse,
						{ headers: { ...NO_STORE, etag: configTag(config) } },
					);
				}
				if (req.method === "POST") {
					let body: unknown;
					let wrote = false;
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
					try {
						// The page sends a partial; merge over the freshest on-disk
						// config — a hand edit since boot must not be silently
						// discarded by an app save. An invalid on-disk file fails
						// here with its own parse error.
						const base = loadConfig() ?? deps.configRef.current;
						const expected = req.headers.get("if-match");
						if (!expected) {
							log.warn("mini app config save refused — missing version", { userId: user.id });
							return Response.json(
								{ error: "load settings before saving" },
								{ status: 428, headers: NO_STORE },
							);
						}
						if (expected !== configTag(base)) {
							log.warn("mini app config save refused — stale version", { userId: user.id });
							return Response.json(
								{ error: "settings changed since this page loaded — reopen settings before saving" },
								{ status: 409, headers: NO_STORE },
							);
						}
						const merged = parseConfig({ ...base, ...body });
						// The mini app is an operator's only door that doesn't need
						// a shell — a save that drops the requester's own id locks
						// them out of it and the bot gate. Refuse before writing.
						if (!merged.allowedUsers.includes(user.id)) {
							return Response.json(
								{ error: `config would remove your own telegram user id (${user.id})` },
								{ status: 422, headers: NO_STORE },
							);
						}
						writeConfig(merged);
						wrote = true;
						const fresh = loadConfig();
						if (fresh) deps.configRef.current = fresh;
						deps.onConfigWritten();
						log.info("config written via mini app");
						return Response.json({ ok: true }, {
							headers: { ...NO_STORE, etag: configTag(fresh ?? merged) },
						});
					} catch (err) {
						if (!(err instanceof z.ZodError)) {
							log.error("mini app config save failed", err, { userId: user.id, wrote });
							return Response.json({
								error: wrote
									? "settings were saved but could not be applied — check the service log"
									: "settings could not be written — check the service log",
							}, { status: 500, headers: NO_STORE });
						}
						const msg =
							z.prettifyError(err);
						return Response.json({ error: msg }, { status: 422, headers: NO_STORE });
					}
				}
				return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
			}
			return new Response("not found", { status: 404 });
		},
	});

	const port = server.port ?? deps.configRef.current.http.port;
	log.info("mini-app http listening", { port });
	return { port, stop: () => server.stop() };
}
