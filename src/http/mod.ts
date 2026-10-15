// HTTP serving. The process serves an HTTP endpoint on localhost; the
// Telegram mini app links the built client via the chat menu button.
// Telegram requires HTTPS and the page is fetched by the client device,
// so the public door is a config knob (publicUrl → tailscale
// serve/funnel/any reverse proxy). Nothing here assumes a public IP.

import type { Program, ProgramsStore } from "../programs.ts";
import type { System1Client } from "../system1.ts";
import type { DelegationsStore } from "../delegations.ts";
import { log } from "../log.ts";
import { readBodyCapped, serveInjectionCheck } from "./check.ts";
import { serveAppDist } from "./app-dist.ts";
import { validateInitData, type InitDataResult } from "./auth.ts";
import { handleOperatorRoute, type OperatorDeps } from "./operator.ts";

// HttpDeps is OperatorDeps (the shared operator surface — settings,
// memory, programs, delegations, status) plus the initData door's own
// seams: initData auth (botToken), program webhooks, injection check,
// and the app-channel handler.
export interface HttpDeps extends OperatorDeps {
	botToken: string;
	// The operator surface's extra read seams, consumed by the /api/*
	// operator routes (and mirrored under /api/app/* via appApi).
	programs?: Pick<ProgramsStore, "list">;
	delegations?: Pick<DelegationsStore, "list" | "active"> | null;
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
	// class as the hook token-in-URL). The composition root passes its
	// shared System1Client instance; http only calls decide. Absent = no
	// client (neither system1 nor reviewer block), the route answers 503.
	checkInjection?: { gate: Pick<System1Client, "decide"> };
	// The app channel's API (DESIGN.md, App channel). Auth — bearer
	// token or trust mode — is baked into the closure at boot by the
	// composition root (index.ts): no per-request config read, so a
	// mid-run appToken flip applies only after restart. The handler is
	// injected opaque so this serving layer stays out of the app
	// channel's import graph (runtime, the AI SDK, undici form types).
	// Absent = every /api/app/* refuses 503 with a log line.
	appApi?: (req: Request, url: URL) => Promise<Response>;
	// Constructor-only client-root override for tests and verification —
	// production leaves it undefined and the shell resolves against the
	// real app/dist. No config/env/HTTP surface for it.
	appDistDir?: string;
}

const NO_STORE = { "cache-control": "no-store" };

// The deep link's path segment — mirrors conversation.ts's
// appIdSchema, kept local to keep this module a thin serving layer.
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Operator tails, named identically on both doors: this initData door
// mounts them at /api/*, the app channel at /api/app/* (ruling
// 2026-10-10 in design/telegram.md — the legacy /api/config and
// /api/memory-status names died with the plain-JS page). The memories
// document detail rides a regex in dispatch (path segment), everything
// else is an exact match.
const OPERATOR_TAILS: Record<string, string> = {
	"/api/settings": "config",
	"/api/thinking-levels": "thinking-levels",
	"/api/memory/status": "memory/status",
	"/api/memory/documents": "memory/documents",
	"/api/programs": "programs",
	"/api/delegations": "delegations",
	"/api/status": "status",
	// State viewer (ruling 2026-10-11): the tails mount on both doors per
	// this table's convention — the mini app's PAGES stay settings/memory,
	// but initData-authed API access matches the rest of the console.
	"/api/skills": "skills",
	"/api/skills/file": "skills/file",
	"/api/attachments": "attachments",
	"/api/attachments/file": "attachments/file",
	"/api/identity": "identity",
	"/api/log": "log",
};

const HOOK_BODY_CAP = 32 * 1024;
const HOOK_THROTTLE_MS = 60_000;

export function startHttp(deps: HttpDeps): { port: number; stop(): void } {
	// One fire per program per 60 s — in-memory: a restart resets the
	// window, which is acceptable (the program just runs again).
	const hookLastFired = new Map<number, number>();
	// The client shell/assets dispatch — one seam so a test can point
	// the root at a fixture build instead of the real app/dist.
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
	function authedUser(req: Request): InitDataResult {
		const initData = req.headers.get("x-init-data") ?? "";
		// Read per-request so config writes take effect without a restart.
		// Mini app door: operators only (design/telegram.md → Roles and
		// permissions) — allowedUsers are sandboxed on the Telegram lanes
		// and have no app surface at all.
		const allowed = new Set(deps.configRef.current.operators);
		return validateInitData(initData, deps.botToken, allowed);
	}

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
			return serveClient("");
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
			return serveClient("");
		}
		// The operator-console client routes (settings, memory, …) —
		// same reasoning as /app/c/<id>: the shell resolves them.
		if (
			/^\/app\/(?:settings|memory|delegations|programs|status|projects|notes|skills|files|log)\/?$/.test(
				url.pathname,
			)
		) {
			return serveClient("");
		}
		// Project pages (design/projects.md): /app/p/<projectId> — same
		// shell dispatch as /app/c/<id>. Project ids are randomUUIDs,
		// inside the same url-safe shape.
		if (url.pathname.startsWith("/app/p/")) {
			const projectId = url.pathname.slice("/app/p/".length);
			if (!APP_ID_RE.test(projectId)) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return serveClient("");
		}
		// Note pages (design/projects.md → Notes): /app/n/<noteId> —
		// the same shell dispatch; note ids are randomUUIDs too.
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
		// The Telegram mini app door (design/telegram.md → Mini Apps):
		// the same built client as /app, at the deep links the menu
		// button and history carry. The page is public like /app's —
		// telegram mode (client-side: the /t/ prefix) authenticates with
		// initData against /api/*. Same origin as /app: client-side this
		// is one security boundary — the door split narrows exposure, it
		// does not isolate. The page scope is deliberate (settings +
		// memories); everything else under /t/ is a 404.
		if (
			url.pathname === "/t" ||
			url.pathname === "/t/" ||
			/^\/t\/(?:settings|memory)\/?$/.test(url.pathname)
		) {
			return serveClient("");
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			// The plain-JS mini app lived here; the menu button now points
			// at /t/settings. Relative Location — #105: never bounce off a
			// Host the backend guessed.
			return new Response(null, { status: 302, headers: { location: "/app/", ...NO_STORE } });
		}
		// The operator surface — settings, memory browse/forget, programs,
		// delegations, service status — is owned by operator.ts and shared
		// verbatim with the app channel (handleOperatorRoute does the
		// routing; this door's auth is initData, the app's is bearer/trust).
		const memDocTail = url.pathname.match(/^\/api\/memory\/documents\/([^/]+)$/);
		const operatorTail =
			OPERATOR_TAILS[url.pathname] ?? (memDocTail ? `memory/documents/${memDocTail[1]}` : null);
		if (operatorTail !== null) {
			const auth = authedUser(req);
			if (!auth.ok) {
				// Category and path only — the presented credential never logs.
				log.warn("mini-app auth refused", { path: url.pathname, why: auth.why });
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
