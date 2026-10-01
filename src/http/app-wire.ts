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
