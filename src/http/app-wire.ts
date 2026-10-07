// App channel wire types — the contract between /api/app/* and the
// React client in app/. This module is a leaf by design: it type-imports
// only ai's UIMessage and the two domain types the envelopes carry.
// Nothing deeper (runtime, store plumbing, node plumbing) may enter —
// the client tsconfig (lib DOM) typechecks every file these imports
// transitively pull, and DOM's ReadableStream is not async-iterable.

import type { UIMessage } from "ai";
import type { AppConversationSummary } from "../conversation.ts";
import type { AttachmentRef } from "../agent/attachments.ts";

/** GET /api/app/conversations — the app pool, newest activity first. */
export interface AppConversationList {
	conversations: AppConversationSummary[];
}

/** POST /api/app/conversations — id is client-minted or server-minted. */
export interface AppConversationCreate {
	id: string;
	title: string | null;
	createdAt: string;
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

/** PATCH /api/app/conversations/<id> — an explicit rename always wins. */
export interface AppConversationRename {
	title: string;
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

/** GET /api/app/config — the operator knobs the composer shows. */
export interface AppConfigView {
	/** The active "<provider>/<model>" ref. */
	model: string;
	thinking: string;
	/** The pickable model list (config.favorites). */
	favorites: string[];
	/** Thinking rungs the active model can express. */
	thinkingLevels: string[];
}

/** POST /api/app/config — last-wins patch over the on-disk config. */
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
	/** Set when the turn's answer was forced — the step budget cut
	 * the tool loop and made the model answer. Null on natural finishes;
	 * the UI stamps it so degraded-goods answers are never silent
	 * (2026-10-07 ruling, design/model.md). */
	forcedCompletion: "budget" | null;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
	};
}
