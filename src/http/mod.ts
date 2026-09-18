// Mini-app serving. The process serves an HTTP endpoint on localhost; the
// bot links the page via the chat menu button. Telegram requires HTTPS and
// the page is fetched by the client device, so the public door is a config
// knob (publicUrl → tailscale serve/funnel/any reverse proxy). Nothing
// here assumes a public IP.

import { z } from "zod";
import { thinkingLevelsFor } from "../agent/providers.ts";
import { loadConfig, parseConfig, writeConfig, type Config } from "../config.ts";
import { log } from "../log.ts";
import { APP_HTML } from "./app.ts";
import { validateInitData, type InitDataUser } from "./auth.ts";

export interface HttpDeps {
	configRef: { current: Config };
	botToken: string;
	// Called after a successful config write so the process hot-applies
	// model/thinking/favorites (structural fields apply on restart).
	onConfigWritten(): void;
}

const NO_STORE = { "cache-control": "no-store" };
const HTML = { "content-type": "text/html; charset=utf-8", ...NO_STORE };

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
				return new Response(APP_HTML, { headers: HTML });
			}
			if (url.pathname === "/api/thinking-levels") {
				const user = authedUser(req);
				if (!user) {
					return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
				}
				// The page passes the provider kind from its own form state —
				// an unsaved provider card still resolves correctly.
				const levels = thinkingLevelsFor(
					url.searchParams.get("kind") ?? "",
					url.searchParams.get("model") ?? "",
				);
				return Response.json({ levels }, { headers: NO_STORE });
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
