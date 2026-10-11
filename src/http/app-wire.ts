// App channel wire types — the contract between /api/app/* and the
// React client in app/. This module is a leaf by design: it type-imports
// only ai's UIMessage and the two domain types the envelopes carry.
// Nothing deeper (runtime, store plumbing, node plumbing) may enter —
// the client tsconfig (lib DOM) typechecks every file these imports
// transitively pull, and DOM's ReadableStream is not async-iterable.

import type { UIMessage } from "ai";
import type { AppConversationSummary } from "../conversation.ts";
import type { AttachmentRef } from "../agent/attachments.ts";

/** GET /api/app/conversations — the app pool, pinned rows first, then
 * newest activity. */
export interface AppConversationList {
	conversations: AppConversationSummary[];
}

/** POST /api/app/conversations — id is client-minted or server-minted. */
export interface AppConversationCreate {
	id: string;
	title: string | null;
	createdAt: string;
}

/** One project as the app sees it — the domain Project minus `home`
 * (goblin-owned scratch the client never addresses). GET/POST
 * /api/app/projects, GET/PATCH /api/app/projects/<id>. */
export interface AppProject {
	id: string;
	name: string;
	slug: string;
	dir: string;
	managed: boolean;
	instructions: string;
	memory: "shared" | "off";
	createdAt: string;
	archivedAt: string | null;
}

/** GET /api/app/projects — every project, archived included, newest first. */
export interface AppProjectList {
	projects: AppProject[];
}

/** One note as the app sees it. GET /api/app/notes/<id>; POST
 * /api/app/notes, PATCH /api/app/notes/<id>. `rev` doubles as the
 * etag — the editor's If-Match guard rides it. */
export interface AppNote {
	id: string;
	projectId: string | null;
	title: string;
	body: string;
	rev: number;
	lastSource: "app" | "agent" | "rewrite" | "append" | "restore";
	pinnedAt: string | null;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The rail/index row — AppNote minus the body. GET /api/app/notes. */
export interface AppNoteSummary {
	id: string;
	projectId: string | null;
	title: string;
	rev: number;
	pinnedAt: string | null;
	archivedAt: string | null;
	updatedAt: string;
	preview: string;
}
export interface AppNoteList {
	notes: AppNoteSummary[];
}

/** GET /api/app/notes/<id>/versions — metadata only; the body is a
 * per-rev fetch because the panel previews on demand. */
export interface AppNoteVersionMeta {
	rev: number;
	source: "app" | "agent" | "rewrite" | "append" | "restore";
	conversation: string | null;
	at: string;
	bytes: number;
}
export interface AppNoteVersionList {
	versions: AppNoteVersionMeta[];
}

/** GET /api/app/notes/<id>/versions/<rev> — the version's own
 * title+body (what restore would write back). */
export interface AppNoteVersion extends AppNoteVersionMeta {
	title: string;
	body: string;
}

/** POST /api/app/notes/<id>/rewrite — one plain generate call on the
 * root app-default model; the server writes nothing. The accepted
 * proposal comes back through the ordinary PATCH with source rewrite. */
export interface AppNoteRewriteRequest {
	selection: string;
	instruction: string;
}
export interface AppNoteRewriteResponse {
	replacement: string;
}

/** GET /api/app/conversations/<id>/messages — stored UIMessages verbatim. */
export interface AppMessageList {
	messages: UIMessage[];
}

/** POST /api/app/chat — one user message into an app conversation. */
export interface AppChatRequest {
	conversationId: string;
	message: UIMessage;
}

/** POST /api/app/attachments — the durable ref the message part carries. */
export interface AppAttachmentResponse {
	ref: AttachmentRef;
}

/** POST /api/app/conversations/<id>/stop — whether a live turn was stopped. */
export interface AppStopResponse {
	stopped: boolean;
}

/** PATCH /api/app/conversations/<id> — applied fields echoed back. An
 * explicit title always wins over auto-titling; archived moves the row
 * between the rail and the archived section (activity clears it
 * server-side); pinned floats the row above the rail's activity order
 * (archiving clears it server-side). */
export interface AppConversationPatch {
	title?: string;
	archived?: boolean;
	pinned?: boolean;
}

/** GET /api/app/search — one FTS hit inside the app pool. */
export interface AppSearchHit {
	conversationId: string;
	title: string | null;
	seq: number;
	role: string;
	// The hit's flattened text — the client's own flatLine gets the
	// single-line label the rail rows use.
	text: string;
	createdAt: string;
}
export interface AppSearchResponse {
	hits: AppSearchHit[];
}

/** GET /api/app/config — app defaults for future conversations.
 * GET /api/app/conversations/<id>/config — that conversation's settings. */
export interface AppConfigView {
	/** The active "<provider>/<model>" ref. */
	model: string;
	thinking: string;
	/** The pickable model list (config.favorites). */
	favorites: string[];
	/** Thinking rungs the active model can express. */
	thinkingLevels: string[];
}

/** PATCH /api/app/config (POST alias) — future app defaults.
 * PATCH /api/app/conversations/<id>/config — applies next turn only. */
export interface AppConfigPatch {
	model?: string;
	thinking?: string;
}

/** POST /api/app/tts — reply text → speech chunks, base64 ogg/opus. */
export interface AppTtsResponse {
	chunks: string[];
	mediaType: "audio/ogg";
}

/** Turn stats stamped on assistant message.metadata at stream finish
 * (runtime.ts's messageMetadata callback writes it; stored history
 * carries it back to the client on reload). */
export interface TurnMetadata {
	model: string;
	finishReason: string;
	durationMs: number;
	/** Set when the turn's answer was forced — a loop landing (repeat
	 * detector, loop watchdog, or context) cut the tool loop and made the
	 * model answer. Null on natural finishes; the UI stamps it so
	 * degraded-goods answers are never silent
	 * (2026-10-07 ruling, design/model.md). */
	forcedCompletion: "repeat" | "watchdog" | "context" | null;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
	};
}
