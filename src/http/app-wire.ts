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
 * etag — the editor's If-Match guard rides it. `stateRev` orders
 * every accepted mutation (flags included) — it's the token stale
 * responses are judged against; `rev` alone can't see a flag flip. */
export interface AppNote {
	id: string;
	projectId: string | null;
	title: string;
	body: string;
	rev: number;
	stateRev: number;
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
	stateRev: number;
	pinnedAt: string | null;
	archivedAt: string | null;
	updatedAt: string;
	preview: string;
}
export interface AppNoteList {
	notes: AppNoteSummary[];
	/** True when the filter matched past the server's bound — the
	 * list is a prefix, and a narrower project/q filter reaches the
	 * rest. Required so a capped shelf can never read as complete. */
	truncated: boolean;
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

/** GET /api/app/conversations/<id>/context — the last turn's window
 * utilization against the active model's catalog limit, plus the
 * cache-hit rates across stored turns. Nulls mean unknown (no turns
 * yet, or the catalog doesn't list the model) — never zero. */
export interface AppContextView {
	/** The active "<provider>/<model>" ref the limit was looked up for. */
	model: string;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	/** Last turn's cacheRead/input, null when uncomputable. */
	cacheHitRate: number | null;
	/** Mean cacheRead/input across stored turns, null when none qualify. */
	avgCacheHitRate: number | null;
	/** Catalog context limit in tokens, null when unlisted. */
	limit: number | null;
	/** input/limit as a percentage with one decimal, null when unknown. */
	pct: number | null;
	/** Stored turns carrying usage — the average's denominator. */
	turns: number;
}

/** One journaled tool call on an interrupted run, as the decision UI
 * needs it. `dispatched` is the only state still awaiting an operator
 * decision; resolved-* rows carry what was chosen. */
export interface AppRunCall {
	toolCallId: string;
	name: string;
	args: unknown;
	state:
		| "planned"
		| "dispatched"
		| "completed"
		| "failed"
		| "resolved-done"
		| "resolved-retry"
		| "resolved-skip";
	result: string | null;
	error: string | null;
	resolutionNote: string | null;
	resolvedMs: number | null;
}

/** One interrupted run. GET /api/app/conversations/<id>/interrupted. */
export interface AppInterruptedRun {
	runId: string;
	resumedFrom: string | null;
	startedMs: number;
	finishedMs: number | null;
	calls: {
		planned: number;
		dispatched: number;
		completed: number;
		failed: number;
		resolved: number;
	};
	toolCalls: AppRunCall[];
}
export interface AppInterruptedList {
	runs: AppInterruptedRun[];
}

/** POST /api/app/conversations/<id>/runs/<runId>/decide — the operator's
 * verdict on one ambiguous call. `callId` is the journaled toolCallId
 * (a prefix resolves when unambiguous). `note` is the asserted result
 * for done, a free note for retry/skip. */
export interface AppDecideRequest {
	callId: string;
	decision: "record-result" | "authorize-retry" | "skip";
	note?: string;
}
export interface AppDecideResponse {
	ok: true;
}

/** POST /api/app/conversations/<id>/runs/<runId>/resume — admits the
 * fresh turn. 200 carries AppResumeResponse; 409 with undecided calls
 * carries AppResumeBlocked. */
export interface AppResumeResponse {
	resumed: true;
	runId: string;
}
export interface AppResumeBlocked {
	error: string;
	calls: AppRunCall[];
}
