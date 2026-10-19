// Leaf by design: app/src imports these types, and the client tsconfig
// (lib DOM) typechecks every file they transitively pull — DOM's
// ReadableStream is not async-iterable, so nothing deeper may enter.

import type { UIMessage } from "ai";
import type { AppConversationSummary } from "../conversation.ts";
import type { AttachmentRef } from "../agent/attachments.ts";

export interface AppConversationList {
	conversations: AppConversationSummary[];
}

export interface AppConversationCreate {
	id: string;
	title: string | null;
	createdAt: string;
}

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

export interface AppProjectList {
	projects: AppProject[];
}

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
	truncated: boolean;
}

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

export interface AppNoteVersion extends AppNoteVersionMeta {
	title: string;
	body: string;
}

export interface AppNoteRewriteRequest {
	selection: string;
	instruction: string;
}
export interface AppNoteRewriteResponse {
	replacement: string;
}

export interface AppMessageList {
	messages: UIMessage[];
}

export interface AppChatRequest {
	conversationId: string;
	message: UIMessage;
}

export interface AppAttachmentResponse {
	ref: AttachmentRef;
}

export interface AppStopResponse {
	stopped: boolean;
}

export type AppCompactResponse =
	| {
			compacted: true;
			eventsCompacted: number;
			tailEvents: number;
			tokensBefore: number;
	  }
	| { compacted: false; reason: string };

export interface AppConversationPatch {
	title?: string;
	archived?: boolean;
	pinned?: boolean;
}

export interface AppSearchHit {
	conversationId: string;
	title: string | null;
	seq: number;
	role: string;
	text: string;
	createdAt: string;
}
export interface AppSearchResponse {
	hits: AppSearchHit[];
}

export interface AppConfigView {
	model: string;
	thinking: string;
	favorites: string[];
	thinkingLevels: string[];
}

export interface AppConfigPatch {
	model?: string;
	thinking?: string;
}

export interface AppTtsResponse {
	chunks: string[];
	mediaType: "audio/ogg";
}

export interface TurnMetadata {
	model: string;
	finishReason: string;
	durationMs: number;
	forcedCompletion: "repeat" | "watchdog" | "context" | null;
	usage: {
		/** Whole turn's billed prompt, summed across the tool loop's steps. */
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		/** Final step's prompt — the current window occupancy. */
		lastInput: number | null;
		lastCacheRead: number | null;
	};
	/** Itemization of the final step's prompt in serialized characters
	 *  (src/turn/itemize.ts keys); absent on pre-itemization turns. */
	promptChars?: Record<string, number>;
}

export interface AppContextSegment {
	key: string;
	tokens: number;
}

export interface AppContextView {
	model: string;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	cacheHitRate: number | null;
	avgCacheHitRate: number | null;
	limit: number | null;
	pct: number | null;
	turns: number;
	/** Last turn's window itemization, scaled to tokens. Null on turns
	 *  without itemization metadata. */
	segments: AppContextSegment[] | null;
}

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

export interface AppDecideRequest {
	callId: string;
	decision: "record-result" | "authorize-retry" | "skip";
	note?: string;
}
export interface AppDecideResponse {
	ok: true;
}

export interface AppResumeResponse {
	resumed: true;
	runId: string;
}
export interface AppResumeBlocked {
	error: string;
	calls: AppRunCall[];
}
