// App channel HTTP surface (DESIGN.md, App channel) — the React client's
// API under /api/app/*. The auth mode resolves once at boot
// (resolveAppAuth, wired by index.ts): config.appToken names an
// auth.jsonl record → bearer required per request; unset → trust mode —
// the tailnet is the only lock and requests pass unauthenticated
// (device-level trust, the collie precedent). Trust mode adds one
// line on top of reachability (#75): a mutation speaking a *browser*
// origin must speak ours — a page riding the operator's device is not
// the operator. Non-browser clients carry no browser headers and pass
// untouched; see browserMutationRefusal in app-auth.ts.
//
// Chat rides the shared runtime unchanged: a submitted message lands in
// the same serial lane, the same steering and /stop fencing apply, and
// the response stream is the runtime's own UIMessage stream — this
// app-sse.ts TurnSink serializes it to the SSE wire verbatim
// (`data: <chunk>\n\n`, terminated by `data: [DONE]\n\n`), exactly what
// @ai-sdk/react's useChat consumes.

import { type ConversationStore } from "../conversation.ts";
import type { AuthStore } from "../auth.ts";
import type { Runtime } from "../runtime.ts";
import type { SpeechFile } from "../agent/transcribe.ts";
import { type ConfigRef } from "../config.ts";
import { log } from "../log.ts";
import { type NoteStore } from "../notes.ts";
import { type ProjectStore } from "../projects.ts";
import type { AppNoteRewriteRequest } from "./app-wire.ts";
import { handleOperatorRoute, type OperatorDeps } from "./operator.ts";

import { NO_STORE } from "./app-shared.ts";
import { appAuth, jsonBodyRefusal } from "./app-auth.ts";
export { resolveAppAuth } from "./app-auth.ts";

import { handleAppConversationsRoute } from "./app-conversations.ts";

import { handleAppProjectsRoute } from "./app-projects.ts";

import { handleAppNotesRoute } from "./app-notes.ts";

import { handleAppConfigRoute } from "./app-config.ts";

import { handleAppChatRoute } from "./app-chat.ts";

import { handleAppAttachmentsRoute } from "./app-attachments.ts";

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
	// Exact key — it must win over the legacy /api/app/attachments/<name>
	// read-back prefix below.
	"/api/app/attachments/file": "attachments/file",
	"/api/app/identity": "identity",
	"/api/app/log": "log",
};

export interface AppChannelDeps {
	store: ConversationStore;
	runtime: Runtime;
	// The project domain (design/projects.md) — list/create/get/patch
	// and the conversation-binding checks in POST /conversations.
	projects: ProjectStore;
	// The notes surface — the /api/app/notes routes and the data-note
	// intake expansion on chat POST (the server reads the note; the
	// client only names it).
	notes: NoteStore;
	// auth.jsonl resolution — the record config.appToken names.
	auth: Pick<AuthStore, "resolve">;
	// Live config + shared post-write hook for app defaults. Conversation
	// settings live separately in SQLite and never rewrite this file.
	configRef: ConfigRef;
	onConfigWritten(): void;
	// Speech→text for speech-flagged attachments, the same seam tg
	// intake runs on voice notes. Absent = transcription unconfigured —
	// the ref keeps speech:true with no transcript and materialization
	// degrades to the path reference.
	transcribe?: (file: SpeechFile) => Promise<string | null>;
	// Reply read-aloud — synthesizeSpeech over the live tts block.
	// Absent or a null return = speech unavailable (503 to the client).
	speak?: (text: string) => Promise<Uint8Array[] | null>;
	// First-turn naming via titleModel — the same closure the tg lane
	// uses for implicit topics. Absent = no auto-titling.
	titleFor?: (text: string) => Promise<string | null>;
	// Selection rewrite — one generate call, no write (design/projects.md
	// → AI rewrite). Absent = the route refuses 503.
	rewriteNote?: (
		noteId: string,
		input: AppNoteRewriteRequest,
		signal: AbortSignal,
	) => Promise<string>;
	// The operator surface (operator.ts) — shared verbatim with the mini
	// app's /api/* routes; configRef/onConfigWritten already live on this
	// deps object so the bundle carries only the extra seams. Absent =
	// the operator routes refuse 503.
	operator?: Omit<OperatorDeps, "configRef" | "onConfigWritten">;
}

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
		if ((opTail === "config" || opTail === "secrets") && req.method === "POST") {
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

	const conversations = await handleAppConversationsRoute(req, url, deps);
	if (conversations !== null) return conversations;
	const projects = await handleAppProjectsRoute(req, url, deps);
	if (projects !== null) return projects;
	const notes = await handleAppNotesRoute(req, url, deps);
	if (notes !== null) return notes;
	const config = await handleAppConfigRoute(req, url, deps);
	if (config !== null) return config;
	const chat = await handleAppChatRoute(req, url, deps);
	if (chat !== null) return chat;
	const attachments = await handleAppAttachmentsRoute(req, url, deps);
	if (attachments !== null) return attachments;

	return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
}
