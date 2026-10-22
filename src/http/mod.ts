import type { Program, ProgramsStore } from "../programs.ts";
import type { System1Client } from "../system1.ts";
import type { DelegationsStore } from "../delegations.ts";
import { log } from "../log.ts";
import { readBodyCapped, serveInjectionCheck } from "./check.ts";
import { serveAppDist } from "./app-dist.ts";
import { validateInitData, type InitDataResult } from "./auth.ts";
import { handleOperatorRoute, type OperatorDeps } from "./operator.ts";

export interface HttpDeps extends OperatorDeps {
	/** Absent when Telegram is disabled: /app stays live, while the
	 * Telegram mini-app door and its /api tails answer an explicit 503. */
	botToken?: string | undefined;
	programs?: Pick<ProgramsStore, "list">;
	delegations?: Pick<DelegationsStore, "list" | "active"> | null;
	hooks?: {
		programs: ProgramsStore;
		accepting(): boolean;
		fire(program: Program, event: string | undefined, now: Date): boolean;
	};
	checkInjection?: { gate: Pick<System1Client, "decide"> };
	appApi?: (req: Request, url: URL) => Promise<Response>;
	appDistDir?: string;
}

const NO_STORE = { "cache-control": "no-store" };

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const OPERATOR_TAILS: Record<string, string> = {
	"/api/settings": "config",
	"/api/thinking-levels": "thinking-levels",
	"/api/secrets": "secrets",
	"/api/memory/status": "memory/status",
	"/api/memory/documents": "memory/documents",
	"/api/programs": "programs",
	"/api/delegations": "delegations",
	"/api/status": "status",
	"/api/skills": "skills",
	"/api/skills/from": "skills/from",
	"/api/skills/file": "skills/file",
	"/api/skills/decide": "skills/decide",
	"/api/attachments": "attachments",
	"/api/attachments/file": "attachments/file",
	"/api/identity": "identity",
	"/api/log": "log",
};

const HOOK_BODY_CAP = 32 * 1024;
const HOOK_THROTTLE_MS = 60_000;

export function startHttp(deps: HttpDeps): { port: number; stop(): void } {
	const hookLastFired = new Map<number, number>();
	const serveClient = (rel: string) => serveAppDist(rel, deps.appDistDir);

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
		if (program === null || !program.enabled) return done(404, program ?? undefined);
		const body = await readBodyCapped(req, HOOK_BODY_CAP);
		if (body.oversize) return done(413, program);
		const fresh = hooks.programs.findByHook(hash);
		if (fresh === null || !fresh.enabled) return done(404, fresh ?? undefined);
		const last = hookLastFired.get(fresh.id);
		const now = new Date();
		if (last !== undefined && now.getTime() - last < HOOK_THROTTLE_MS) {
			return done(429, fresh);
		}
		if (!hooks.accepting()) return done(503, fresh, { "retry-after": "30" });
		const landed = hooks.fire(fresh, body.text, now);
		if (landed) {
			hookLastFired.set(fresh.id, now.getTime());
		}
		return done(landed ? 202 : 500, fresh);
	}
	type AuthOutcome = InitDataResult | { ok: false; why: "channel-disabled" };
	function authedUser(req: Request): AuthOutcome {
		if (deps.botToken === undefined) return { ok: false, why: "channel-disabled" };
		const initData = req.headers.get("x-init-data") ?? "";
		const allowed = new Set(deps.configRef.current.operators);
		return validateInitData(initData, deps.botToken, allowed);
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: deps.configRef.current.http.port,
		idleTimeout: 255,
		// Bun.serve's onError never fires for handler throws in this Bun
		// (verified sync and async) — hence the wrapping try/catch.
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
			if (deps.appApi === undefined) {
				log.warn("app api refused — app surface not wired", { path: url.pathname });
				return Response.json(
					{ error: "app channel is not configured" },
					{ status: 503, headers: NO_STORE },
				);
			}
			return deps.appApi(req, url);
		}
		if (url.pathname === "/app") {
			return serveClient("");
		}
		if (url.pathname.startsWith("/app/c/")) {
			const appId = url.pathname.slice("/app/c/".length);
			if (!APP_ID_RE.test(appId)) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return serveClient("");
		}
		if (
			/^\/app\/(?:settings|memory|delegations|programs|status|projects|notes|skills|files|log)\/?$/.test(
				url.pathname,
			)
		) {
			return serveClient("");
		}
		if (url.pathname.startsWith("/app/p/")) {
			const projectId = url.pathname.slice("/app/p/".length);
			if (!APP_ID_RE.test(projectId)) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return serveClient("");
		}
		if (url.pathname.startsWith("/app/n/")) {
			const noteId = url.pathname.slice("/app/n/".length);
			if (!APP_ID_RE.test(noteId)) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return serveClient("");
		}
		if (url.pathname.startsWith("/app/")) {
			return serveClient(url.pathname.slice("/app/".length));
		}
		if (
			url.pathname === "/t" ||
			url.pathname === "/t/" ||
			/^\/t\/(?:settings|memory)\/?$/.test(url.pathname)
		) {
			if (deps.botToken === undefined) {
				return Response.json(
					{ error: "telegram channel is disabled" },
					{ status: 503, headers: NO_STORE },
				);
			}
			return serveClient("");
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(null, { status: 302, headers: { location: "/app/", ...NO_STORE } });
		}
		const memDocTail = url.pathname.match(/^\/api\/memory\/documents\/([^/]+)$/);
		const operatorTail =
			OPERATOR_TAILS[url.pathname] ?? (memDocTail ? `memory/documents/${memDocTail[1]}` : null);
		if (operatorTail !== null) {
			const auth = authedUser(req);
			if (!auth.ok) {
				// Category and path only — the presented credential never logs.
				log.warn("mini-app auth refused", { path: url.pathname, why: auth.why });
				if (auth.why === "channel-disabled") {
					return Response.json(
						{ error: "telegram channel is disabled" },
						{ status: 503, headers: NO_STORE },
					);
				}
				return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
			}
			const res = await handleOperatorRoute(
				deps,
				{ via: "mini-app", userId: auth.user.id },
				req,
				operatorTail,
				url,
			);
			return res ?? new Response("not found", { status: 404 });
		}
		if (url.pathname === "/api/check-injection") {
			return serveInjectionCheck(req, deps.checkInjection);
		}
		return new Response("not found", { status: 404 });
	}

	const port = server.port ?? deps.configRef.current.http.port;
	log.info("http listening", { port });
	return { port, stop: () => server.stop() };
}
