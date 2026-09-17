// Mini-app serving. The process serves an HTTP endpoint on localhost; the
// bot links the page via the chat menu button. Telegram requires HTTPS and
// the page is fetched by the client device, so the public door is a config
// knob (publicUrl → tailscale serve/funnel/any reverse proxy). Nothing
// here assumes a public IP.

import { loadConfig, writeConfig, type Config } from "../config.ts";
import { log } from "../log.ts";
import { APP_HTML } from "./app.ts";
import { validateInitData } from "./auth.ts";

export interface HttpDeps {
	configRef: { current: Config };
	botToken: string;
	// Called after a successful config write so the process hot-applies
	// model/thinking/favorites (structural fields apply on restart).
	onConfigWritten(): void;
}

const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

export function startHttp(deps: HttpDeps): { port: number; stop(): void } {
	function authed(req: Request): boolean {
		const initData = req.headers.get("x-init-data") ?? "";
		// Read per-request so config writes take effect without a restart.
		const allowed = new Set(deps.configRef.current.allowedUsers);
		return validateInitData(initData, deps.botToken, allowed) !== null;
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: deps.configRef.current.http.port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(APP_HTML, { headers: { "content-type": "text/html" } });
			}
			if (url.pathname === "/api/config") {
				if (!authed(req)) {
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
					try {
						// The page sends a partial; merge over current config.
						writeConfig({ ...deps.configRef.current, ...(body as object) });
						const fresh = loadConfig();
						if (fresh) deps.configRef.current = fresh;
						deps.onConfigWritten();
						log.info("config written via mini app");
						return Response.json({ ok: true }, { headers: NO_STORE });
					} catch (err) {
						return Response.json(
							{ error: err instanceof Error ? err.message : String(err) },
							{ status: 422, headers: NO_STORE },
						);
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
