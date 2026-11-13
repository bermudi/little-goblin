// Leaf by design: app/src imports these types, and the client tsconfig
// (lib DOM) typechecks every file they transitively pull — DOM's
// ReadableStream is not async-iterable, so nothing deeper may enter.

import type { UIMessage } from "ai";
import type { AppConversationSummary } from "../conversation-read.ts";
import type { AttachmentRef } from "../agent/attachments.ts";
import type { DiffLine } from "../line-diff.ts";

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
	/** Fold pointers as transcript marks, oldest first — each renders a
	 *  pill after `messages[afterIndex]` (-1 = before the first). */
	compactions: AppCompactionMark[];
}

export interface AppCompactionMark {
	boundarySeq: number;
	/** Index into `messages` the pill renders after: the last message
	 *  that existed when the fold ran (its created_at ≤ the row's) —
	 *  where the fold ran, not at the cut. -1 = before every message. */
	afterIndex: number;
	/** Index into `messages` of the first message the model still sees
	 *  verbatim after this fold — the causal cut's far side. */
	firstKeptIndex: number;
	eventsCompacted: number;
	/** Fold-time tail size; null on rows written before it was recorded. */
	tailEvents: number | null;
	tokensBefore: number;
	summary: string;
	model: string;
	createdAt: string;
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
	/** True when the stopped turn's terminal delivery (history writes,
	 *  sink notifications) had settled before this response was sent —
	 *  false only when the settle wait timed out. */
	settled: boolean;
}

// Rides `metadata` of the system unlanded-progress event (design/runtime-turn.md → Unlanded-turn progress).
export interface UnlandedTurnMetadata {
	unlanded: {
		kind: "failed" | "aborted" | "interrupted";
		runId: string;
		// The reply as the wire streamed it, for display. Absent when no wire log exists or nothing was streamed.
		reply?: UIMessage["parts"];
	};
}

// A suggestion only — nothing is written; the PATCH stays the one saver.
export interface AppSuggestTitleResponse {
	title: string;
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
	/** The chat picker's curated membership — null = not curated, the
	 *  picker offers the whole catalog; a list = exactly these refs, in
	 *  order, custom refs included (settings → Models owns it). */
	pickerModels: string[] | null;
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

// One rate-limit window as the codex backend reports it — the
// adapter's receipts.ts parses the headers/SSE event into this shape;
// every other consumer sees it already validated.
export interface AppQuotaWindow {
	usedPercent: number;
	windowMinutes: number | null;
	/** Unix seconds. */
	resetsAt: number | null;
}

export interface AppQuota {
	limitName: string | null;
	primary: AppQuotaWindow | null;
	secondary: AppQuotaWindow | null;
}

export interface TurnMetadata {
	model: string;
	finishReason: string;
	durationMs: number;
	/** Turn start → the model's first streamed content token (text,
	 * reasoning, or tool input), same base as durationMs. Absent when
	 * nothing streamed and on pre-stamp history. */
	ttftMs?: number;
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
	/** Codex rate-limit snapshot at turn end, when the provider issued one. */
	quota?: AppQuota;
	/** Candidates that failed before `model` served (design/model.md →
	 *  Model fallback list); absent when the conversation's own model did. */
	fallbackFrom?: Array<{ ref: string; reason: string }>;
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
	/** Codex rate-limit snapshot while the turn runs, when issued. */
	quota?: AppQuota;
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
	/** A settled turn at or above this share of the limit compacts. */
	compactAtPct: number;
	turns: number;
	/** Last turn's window itemization, scaled to tokens. Null on turns
	 *  without itemization metadata. */
	segments: AppContextSegment[] | null;
	/** Latest settled turn's quota receipt, when the provider issued one. */
	quota?: AppQuota;
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

/** One field an update proposal changes. `lines` is a line diff (unchanged
 *  runs collapsed to gaps) for long text; null for single-line fields. */
export interface AppProgramChange {
	field: keyof AppProgramCandidate;
	label: string;
	before: string;
	after: string;
	lines: DiffLine[] | null;
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
	/** Update proposals: fields that differ from the program the proposal
	 *  was staged against. null on creates and when that base is gone. */
	changes: AppProgramChange[] | null;
}

export interface AppMailDraft {
	id: number;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	replyToId: string | null;
	target: string;
	status: "pending" | "sending" | "sent" | "cancelled" | "expired";
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

/** One cause of blocked memory saves, with what the operator needs to decide. */
export interface AppAttentionMemoryCause {
	/** The stored error text; the key that scopes Try again / Drop them. */
	error: string | null;
	count: number;
	conversations: { conversationId: string | null; name: string | null; count: number }[];
	/** What to do about this kind of error. */
	fix: string;
}

export interface AppAttentionItem {
	id: string;
	kind:
		| "program-approval"
		| "mail-approval"
		| "memory-blocked"
		| "skill-proposal"
		| "interrupted-run"
		| "delegation-input"
		| "responsibility";
	title: string;
	detail: string;
	createdAt: string | null;
	target: AppAttentionTarget;
	/** Only on `memory-blocked` items. */
	memory?: AppAttentionMemoryCause;
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
		| "unknown"
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
	lastSkippedAt: string | null;
	lastSkipReason: string | null;
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
	status: "active" | "paused" | "completed" | "cancelled";
	revision: number;
	understanding: AppResponsibilityUnderstanding;
	outcome: string;
	coordinationConversationId: string;
	handoverKey: string | null;
	followupProgramId: string | null;
	followup: {
		token: string;
		kind: "commitment" | "silence";
		dueAt: string;
		reason: string;
	};
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

export interface AppResponsibilityStage {
	waitsFor: "operator" | "goblin" | "worker" | "nobody";
	stage:
		| "closed"
		| "paused"
		| "delivery-uncertain"
		| "question"
		| "assess"
		| "review"
		| "blocked"
		| "failed"
		| "waiting"
		| "working";
	reason: string;
}

export interface AppResponsibilityReport {
	reportId: number;
	responsibilityId: string;
	revision: number;
	reporter: "goblin" | "worker" | "migration";
	state: "progress" | "waiting" | "ready" | "blocked" | "failed" | "done" | "dropped";
	reason: string;
	question: string | null;
	resumeWhen: string | null;
	evidence: { item: string; ref: string; checked: string }[];
	purpose: "status" | "finding" | "draft" | "change";
	artifacts: { title: string; ref: string }[];
	sourceKey: string | null;
	createdAt: string;
}

/** An outcome post on a feed row — one report, with whose word it is.
 * `unreviewed` is a worker's claim goblin has not yet reported on. */
export interface AppFeedPost {
	report: AppResponsibilityReport;
	review: "assessed" | "unreviewed" | "reviewed" | "migrated";
	/** False once an operator correction has overtaken it. */
	current: boolean;
}

/** One feed row — GET /api/app/responsibilities (open, all projects)
 * and GET /api/app/projects/<id>/responsibilities (the project feed). */
export interface AppFeedItem {
	responsibility: AppResponsibility;
	attachments: AppResponsibilityAttachment[];
	operations: AppPromptOperation[];
	stage: AppResponsibilityStage;
	latestReport: AppResponsibilityReport | null;
	/** Outcome posts, newest first — bounded; older ones stay on record. */
	posts: AppFeedPost[];
	postsTruncated: number;
	events: AppFeedEvent[];
	/** Older durable events the feed window omitted — the rows remain. */
	eventsTruncated: number;
	nextCheckinAt: string | null;
	nextCheckinReason: string | null;
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
