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

// A branch is a fresh app conversation copied through one durable
// message — the same shape create returns, so the client navigates with
// one code path.
export type AppConversationBranch = AppConversationCreate;

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

export type AppReplyRating = "up" | "down";

export interface AppMessageList {
	messages: UIMessage[];
	ratings: AppRatedReply[];
	rateableMessageIds: string[];
}

export interface AppRatedReply {
	messageId: string;
	eventSeq: number;
	anchorSeq: number | null;
	rating: AppReplyRating;
	createdAt: string;
}

export interface AppReplyRatingList {
	ratings: AppRatedReply[];
}

export interface AppReplyRatingResponse {
	rating: AppRatedReply;
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

export interface ModelOption {
	id: string;
	name: string | null;
	releaseDate: string | null;
}

export interface ProviderModelCatalog {
	provider: string;
	models: ModelOption[];
}

export interface AppConfigView {
	model: string;
	thinking: string;
	favorites: string[];
	thinkingLevels: string[];
	/** The configured providers' cached model catalogs — the composer
	 *  picker's friendly names and its "All models…" list. Empty on a
	 *  cold models.dev cache; the picker still takes typed refs. */
	catalog: ProviderModelCatalog[];
}

export interface AppFavoriteToggleRequest {
	ref: string;
	on: boolean;
}

export interface AppFavoritesResponse {
	favorites: string[];
}

export interface AppConfigPatch {
	model?: string;
	thinking?: string;
}

export interface AppConversationMemoryView {
	memoryExcluded: boolean;
	projectMemory: "shared" | "off" | null;
}

export interface AppConversationMemoryResponse extends AppConversationMemoryView {
	cancelled: number;
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

// The in-flight turn's window occupancy, pushed over the chat stream as
// a transient `data-context` part after each model step — the composer's
// gauge shows it while the turn runs: input drives the label and ring,
// cacheRead/input feeds the popover's cache-hit row. Transient: never
// lands in message parts or durable history; the wire log replays the
// last figure to a late joiner.
export interface AppLiveContext {
	input: number | null;
	cacheRead: number | null;
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

// ---------- the context window view (design/app.md → Context window view) ----------

export interface AppWindowTool {
	name: string;
	description: string | null;
	/** JSON Schema of the tool input; null when the SDK's async schema
	 *  converter hadn't materialized it at capture time. */
	parameters: unknown;
}

export interface AppWindowCall {
	callId: string;
	purpose: string | null;
	model: string;
	startedMs: number;
	finishedMs: number | null;
	status: string;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	prefixRelation: string;
	sharedMessages: number;
}

/** GET /api/app/conversations/<id>/window — the newest model call's
 *  outbound prompt, captured at prepareStep and stored verbatim
 *  (window-capture.ts; media bytes stubbed to byte counts), plus the
 *  conversation's model-call lineage. Null sections: no step has run
 *  yet. Captured at the source, never reconstructed. */
export interface AppWindowView {
	/** The conversation's current model — may differ from the captured
	 *  one; the view says so instead of hiding the staleness. */
	model: string;
	capturedAt: string | null;
	capturedModel: string | null;
	steps: number | null;
	/** Serialized characters per segment — the src/turn/itemize.ts keys,
	 *  defined structurally: this file stays a leaf. */
	segments: {
		identity: number;
		environment: number;
		project: number;
		agentsMd: number;
		userMd: number;
		skills: number;
		toolDefs: number;
		history: number;
		toolResults: number;
	} | null;
	system: string | null;
	tools: AppWindowTool[] | null;
	/** The captured prompt as sent — ModelMessage-shaped with media bytes
	 *  stubbed to `{omitted: "bytes", count}` (window-capture.ts), so
	 *  typed loose: a stub is deliberately not a DataContent. */
	messages: unknown[] | null;
	calls: AppWindowCall[];
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
	/** Server-derived: this call may take authorize-retry (a dispatched
	 *  ambiguity or a known completed/failed/resolved-done execution). */
	canAuthorizeRetry: boolean;
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

export interface AppProgramCandidate {
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hook: boolean;
	mailFilter: string | null;
}

export interface AppProgramProposal {
	id: number;
	kind: "create" | "update";
	targetId: number | null;
	target: string;
	state: "pending" | "approved" | "rejected" | "superseded";
	createdAt: string;
	decidedAt: string | null;
	decidedBy: string | null;
	activatedId: number | null;
	candidate: AppProgramCandidate | null;
}

export interface AppMailDraft {
	id: number;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	replyToId: string | null;
	target: string;
	status: "pending" | "sent" | "cancelled" | "expired";
	createdAt: string;
	expiresAt: string;
	decidedAt: string | null;
	decidedBy: string | null;
	sentId: string | null;
}

export interface AppApprovalsResponse {
	programs: AppProgramProposal[];
	mail: AppMailDraft[];
}

export type AppAttentionPage = "programs" | "memory" | "skills" | "delegations";
export type AppAttentionTarget =
	| { kind: "page"; page: AppAttentionPage }
	| { kind: "conversation"; conversationId: string };

export interface AppAttentionItem {
	id: string;
	kind:
		| "program-approval"
		| "mail-approval"
		| "memory-blocked"
		| "skill-proposal"
		| "interrupted-run"
		| "delegation-input";
	title: string;
	detail: string;
	createdAt: string | null;
	target: AppAttentionTarget;
}

export interface AppAttentionResponse {
	items: AppAttentionItem[];
	unavailable: string[];
}

export interface AppApprovalDecisionResponse {
	status:
		| "activated"
		| "rejected"
		| "refused"
		| "needs-public-url"
		| "gone"
		| "settled"
		| "busy"
		| "expired"
		| "cancelled"
		| "sent"
		| "retry"
		| "conflict";
	message: string;
	/** One authenticated reveal for a newly granted webhook URL. Never
	 *  persisted or repeated by a later GET. */
	hookUrl?: string;
}

export interface AppProgramView {
	id: number;
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hasHook: boolean;
	mailFilter: string | null;
	enabled: boolean;
	target: string;
	lastRun: string | null;
	nextRun: string | null;
}

export interface AppProgramMutationResponse {
	status: "updated" | "proposal" | "deleted" | "rotated" | "error";
	message: string;
	program?: AppProgramView;
	proposalId?: number;
	/** One authenticated reveal for a direct hook rotation. Never
	 *  persisted or repeated by a later GET. */
	hookUrl?: string;
}

export interface AppPushSubscriptionView {
	endpointHash: string;
	userAgent: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AppPushSubscriptionRequest {
	endpoint: string;
	expirationTime?: number | null;
	keys: {
		p256dh: string;
		auth: string;
	};
}

export interface AppPushStatus {
	configured: boolean;
	subscriptions: AppPushSubscriptionView[];
}

export interface AppPushPublicKeyResponse {
	publicKey: string;
}

export interface AppPushRegisterResponse {
	endpointHash: string;
}

export interface AppPushUnregisterResponse {
	removed: boolean;
}

// ---------- responsibilities (design/work.md — the project feed) ----------

export interface AppResponsibilityUnderstanding {
	outcome: string;
	situation: string;
	nextAction: string;
	checkpoints: string[];
	completionEvidence: string[];
}

export interface AppResponsibility {
	responsibilityId: string;
	projectId: string;
	status: "active" | "waiting_for_operator" | "blocked" | "paused" | "completed" | "cancelled";
	revision: number;
	understanding: AppResponsibilityUnderstanding;
	outcome: string;
	coordinationConversationId: string;
	handoverKey: string | null;
	followupProgramId: string | null;
	armed: boolean;
	notArmedReason: string | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface AppAttachmentTarget {
	server: string;
	session: string;
	agentName: string;
	paneId: string | null;
	terminalId: string | null;
	agentSession: string | null;
	kind: string | null;
	cwd: string | null;
}

export interface AppResponsibilityAttachment {
	attachmentId: number;
	responsibilityId: string;
	generation: number;
	target: AppAttachmentTarget;
	baseline: unknown;
	health: "attached" | "missing" | "identity_changed" | "detached";
	cursor: unknown;
	createdAt: string;
	detachedAt: string | null;
}

export interface AppPromptOperation {
	operationId: string;
	responsibilityId: string;
	attachmentId: number;
	attachmentGeneration: number;
	responsibilityRevision: number;
	brief: string;
	state: string;
	refusal: string | null;
	journalRunId: string | null;
	toolCallId: string | null;
	sentAt: string | null;
	outcome: unknown;
	createdAt: string;
}

export interface AppFeedEvent {
	eventId: number;
	sourceKey: string;
	kind: string;
	text: string;
	facts: unknown;
	origin: string;
	createdAt: string;
	conversationId: string;
	wake: {
		wakeId: number;
		state: string;
		lastError: string | null;
		settledAt: string | null;
		runId: string | null;
	} | null;
}

/** One feed row — GET /api/app/responsibilities (open, all projects)
 * and GET /api/app/projects/<id>/responsibilities (the project feed). */
export interface AppFeedItem {
	responsibility: AppResponsibility;
	attachments: AppResponsibilityAttachment[];
	operations: AppPromptOperation[];
	events: AppFeedEvent[];
	/** Older durable events the feed window omitted — the rows remain. */
	eventsTruncated: number;
	nextCheckinAt: string | null;
	lastActivityAt: string | null;
}

export interface AppResponsibilityFeed {
	items: AppFeedItem[];
}

/** POST /api/app/responsibilities/<id>/correct — a comment becomes a
 * durable operator event; an understanding patch bumps revision. */
export interface AppCorrectRequest {
	text?: string;
	understanding?: AppResponsibilityUnderstanding;
}
