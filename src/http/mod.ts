// Mini-app serving. The process serves an HTTP endpoint on localhost; the
// bot links the page via the chat menu button. Telegram requires HTTPS and
// the page is fetched by the client device, so the public door is a config
// knob (publicUrl → tailscale serve/funnel/any reverse proxy). Nothing
// here assumes a public IP.

import { z } from "zod";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { thinkingLevelsFor } from "../agent/providers.ts";
import { loadConfig, parseConfig, fetchKinds, providerKinds, searchKinds, writeConfig, type Config } from "../config.ts";
import { log } from "../log.ts";
import { memoryStatus, type MemoryState } from "../memory.ts";
import type { BlockedRetention, MemoryQueueCounts } from "../memory-queue.ts";
import { APP_HTML } from "./app.ts";
import { validateInitData, type InitDataUser } from "./auth.ts";

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
		counts(): MemoryQueueCounts;
		blockedDetail(): BlockedRetention[];
		lastRecallOk(): boolean | null;
		lastRecallAt(): string | null;
	};
}

const NO_STORE = { "cache-control": "no-store" };
const HTML = { "content-type": "text/html; charset=utf-8", ...NO_STORE };
const JS = { "content-type": "text/javascript; charset=utf-8", ...NO_STORE };

// The mini app's read-only view of memory — the same sources the
// /memory command renders, reduced by memoryStatus(). `topicNote` is
// always null: the panel has no conversation address, so "this topic"
// lines belong to /memory in Telegram; the field stays present so the
// shape tells the same story the command does.
export interface MemoryStatusResponse {
	state: MemoryState;
	detail: string;
	pending: number;
	completed: number;
	blocked: number;
	dismissed: number;
	// pending+submitted — everything the worker still owes Hindsight.
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
	const mem = deps.memory && deps.configRef.current.memory ? deps.memory : null;
	if (!mem) {
		return {
			state: "disabled",
			detail: "memory is not configured",
			pending: 0,
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
		pending: status.pending,
		completed: counts.completed,
		blocked: counts.blocked,
		dismissed: counts.dismissed,
		queued: counts.pending + counts.submitted,
		lastRecallAt,
		lastRecallOk,
		topicNote: null,
		blockedDetail: status.blockedDetail,
	};
}

// Resolved from the server's own zod import — wherever the process runs
// from, the vendored tree is the tree the server actually validates with.
const ZOD_ROOT = dirname(fileURLToPath(import.meta.resolve("zod")));

export function startHttp(deps: HttpDeps): { port: number; stop(): void } {
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
			if (url.pathname === "/" || url.pathname === "/index.html") {
				// no-store: a webview must never pair stale page code with a
				// fresh /api/config after an update.
				// Provider and chain kinds are served from the schema's lists
				// (single source — config.ts); a bare identifier makes a missed
				// injection fail loud (ReferenceError), not silent.
				return new Response(
					APP_HTML.replace("__PROVIDER_KINDS__", JSON.stringify(providerKinds))
						.replace("__SEARCH_KINDS__", JSON.stringify(searchKinds))
						.replace("__FETCH_KINDS__", JSON.stringify(fetchKinds)),
					{ headers: HTML },
				);
			}
			if (url.pathname.startsWith("/vendor/zod/")) {
				// Vendored zod for the page's client-side validation. The page has
				// no build step, so zod's published ESM tree is served as-is from
				// the process's own node_modules and the browser resolves zod's
				// relative imports against this prefix. Library code only — no
				// secrets — so it is unauthenticated like the page shell, and
				// confined by two independent guards: a charset regex and a
				// resolved-prefix check.
				const rel = url.pathname.slice("/vendor/zod/".length);
				if (!/^[\w-]+(?:\/[\w.-]+)*\.js$/.test(rel)) {
					return new Response("not found", { status: 404 });
				}
				const abs = join(ZOD_ROOT, rel);
				if (!abs.startsWith(ZOD_ROOT + sep)) {
					return new Response("not found", { status: 404 });
				}
				const file = Bun.file(abs);
				if (!(await file.exists())) {
					return new Response("not found", { status: 404 });
				}
				return new Response(file, { headers: JS });
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
					return Response.json(deps.configRef.current, { headers: NO_STORE });
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
					try {
						// The page sends a partial; merge over the freshest on-disk
						// config — a hand edit since boot must not be silently
						// discarded by an app save. An invalid on-disk file fails
						// here with its own parse error.
						const base = loadConfig() ?? deps.configRef.current;
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
						const fresh = loadConfig();
						if (fresh) deps.configRef.current = fresh;
						deps.onConfigWritten();
						log.info("config written via mini app");
						return Response.json({ ok: true }, { headers: NO_STORE });
					} catch (err) {
						const msg =
							err instanceof z.ZodError
								? z.prettifyError(err)
								: err instanceof Error
									? err.message
									: String(err);
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
