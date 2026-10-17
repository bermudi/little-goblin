// App channel HTTP surface (DESIGN.md, App channel) — the React client's
// API under /api/app/*. The auth mode resolves once at boot
// (resolveAppAuth, wired by index.ts): config.appToken names an
// auth.jsonl record → bearer required per request; unset → trust mode —
// the tailnet is the only lock and requests pass unauthenticated
// (device-level trust, the collie precedent). Trust mode adds one
// line on top of reachability (#75): a mutation speaking a *browser*
// origin must speak ours — a page riding the operator's device is not
// the operator. Non-browser clients carry no browser headers and pass
// untouched; see the auth gate in app-auth.ts.
//
// Chat rides the shared runtime unchanged: a submitted message lands in
// the same serial lane, the same steering and /stop fencing apply, and
// the response stream is the runtime's own UIMessage stream — the
// SSE sink (app-sse.ts) serializes it to the wire verbatim
// (`data: <chunk>\n\n`, terminated by `data: [DONE]\n\n`), exactly what
// @ai-sdk/react's useChat consumes.
//
// This module is the door's dispatcher: the operator dual-mount, then
// the route modules in order, then the 404. Route families live in
// app-conversations / app-projects / app-notes / app-config / app-chat /
// app-attachments; the deps contract they share is app-shared.ts.

import { log } from "../log.ts";
import { handleAttachmentsRoute } from "./app-attachments.ts";
import { appAuth } from "./app-auth.ts";
import { handleChatRoute } from "./app-chat.ts";
import { handleConfigRoute } from "./app-config.ts";
import { handleConversationsRoute } from "./app-conversations.ts";
import { handleNotesRoute } from "./app-notes.ts";
import { handleProjectsRoute } from "./app-projects.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import { handleOperatorRoute } from "./operator.ts";

export { resolveAppAuth } from "./app-auth.ts";
export type { AppChannelDeps };

// App-side mount points for the operator surface (operator.ts owns the
// handlers; /api/app/memory/* maps by prefix because document ids ride
// the path). `/api/app/config` is the composer's app-defaults route —
// the full editor answers at /api/app/settings. The state viewer's
// listing deliberately stays OUT of this table: `/api/app/attachments`
// is dual-mounted (GET → viewer, POST → the composer's upload route
// below), so it is resolved method-aware in the dispatch, not here.
const APP_OPERATOR_TAILS: Record<string, string> = {
	"/api/app/settings": "config",
	"/api/app/thinking-levels": "thinking-levels",
	"/api/app/secrets": "secrets",
	"/api/app/programs": "programs",
	"/api/app/delegations": "delegations",
	"/api/app/status": "status",
	"/api/app/skills": "skills",
	"/api/app/skills/from": "skills/from",
	"/api/app/skills/file": "skills/file",
	"/api/app/skills/decide": "skills/decide",
	// Exact key — it must win over the legacy /api/app/attachments/<name>
	// read-back prefix below.
	"/api/app/attachments/file": "attachments/file",
	"/api/app/identity": "identity",
	"/api/app/log": "log",
};

export async function handleAppApi(
	req: Request,
	url: URL,
	configuredToken: string | undefined,
	deps: AppChannelDeps,
): Promise<Response> {
	const path = url.pathname;
	const refused = await appAuth(req, path, deps, configuredToken);
	if (refused !== null) return refused;

	// The operator surface — the mini app's /api/* console routes under
	// this door's auth. `/api/app/config` is already the composer's
	// app-defaults route, so the full editor mounts at /settings.
	const opTail =
		APP_OPERATOR_TAILS[path] ??
		// Dual mount: GET lists attachments for the state viewer; POST is
		// the composer's upload, which owns the method and falls through.
		(path === "/api/app/attachments" && req.method === "GET" ? "attachments" : null) ??
		(path.startsWith("/api/app/memory/")
			? `memory/${path.slice("/api/app/memory/".length)}`
			: null);
	if (opTail !== null) {
		if (deps.operator === undefined) {
			log.warn("app operator route refused — not wired", { path });
			return Response.json(
				{ error: "operator surface is not wired" },
				{ status: 503, headers: NO_STORE },
			);
		}
		// JSON-body mutations carry the same CSRF backstop as every other
		// app mutation (wire contract, not trust).
		if (
			(opTail === "config" || opTail === "secrets" || opTail === "skills/decide") &&
			req.method === "POST"
		) {
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
		}
		const res = await handleOperatorRoute(
			{ ...deps.operator, configRef: deps.configRef, onConfigWritten: deps.onConfigWritten },
			{ via: "app" },
			req,
			opTail,
			url,
		);
		return res ?? Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
	}

	const route =
		(await handleConversationsRoute(req, url, deps)) ??
		(await handleProjectsRoute(req, url, deps)) ??
		(await handleNotesRoute(req, url, deps)) ??
		(await handleConfigRoute(req, url, deps)) ??
		(await handleChatRoute(req, url, deps)) ??
		(await handleAttachmentsRoute(req, url, deps));
	return route ?? Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
