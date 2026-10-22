import { log } from "../log.ts";
import { handleAttachmentsRoute } from "./app-attachments.ts";
import { handleAttentionRoute } from "./app-attention.ts";
import { appAuth } from "./app-auth.ts";
import { handleChatRoute } from "./app-chat.ts";
import { handleConfigRoute } from "./app-config.ts";
import { handleConversationsRoute } from "./app-conversations.ts";
import { handleNotesRoute } from "./app-notes.ts";
import { handleProgramRoutes } from "./app-programs.ts";
import { handleProjectsRoute } from "./app-projects.ts";
import { handleAppPushRoute } from "./app-push.ts";
import { handleResponsibilitiesRoute } from "./app-responsibilities.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import { handleOperatorRoute } from "./operator.ts";

export { resolveAppAuth } from "./app-auth.ts";
export type { AppChannelDeps };

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

	const opTail =
		APP_OPERATOR_TAILS[path] ??
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
		if (
			(opTail === "config" ||
				opTail === "secrets" ||
				opTail === "skills/decide" ||
				opTail === "memory/blocked") &&
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
		(await handleProgramRoutes(req, url, deps)) ??
		(await handleAttentionRoute(req, url, deps)) ??
		(await handleAppPushRoute(req, url, deps)) ??
		(await handleConversationsRoute(req, url, deps)) ??
		(await handleProjectsRoute(req, url, deps)) ??
		(await handleResponsibilitiesRoute(req, url, deps)) ??
		(await handleNotesRoute(req, url, deps)) ??
		(await handleConfigRoute(req, url, deps)) ??
		(await handleChatRoute(req, url, deps)) ??
		(await handleAttachmentsRoute(req, url, deps));
	return route ?? Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
