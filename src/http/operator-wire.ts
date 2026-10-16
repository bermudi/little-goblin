// Operator-surface wire types — the contract shared by the mini app's
// /api/* routes and the app channel's /api/app/* operator routes
// (settings, memory browser, programs, delegations, service status).
// Leaf module by design, like app-wire.ts: type-only imports and only
// from config.ts, which is already in every consumer's typecheck
// program — both clients compile against these shapes.

import type {
	authDefaults,
	Config,
	ProviderConfig,
	ThinkingLevel,
	transcriptionDefaults,
	transcriptionKinds,
	ttsCloudDefaults,
} from "../config.ts";

/** GET config — the config plus the schema's kind lists. */
export interface ConfigResponse {
	config: Config;
	providerKinds: readonly string[];
	searchKinds: readonly string[];
	fetchKinds: readonly string[];
	transcriptionKinds: typeof transcriptionKinds;
	transcriptionDefaults: typeof transcriptionDefaults;
	/** Cloud-TTS defaults (model + auth record) per kind, like
	 *  transcriptionDefaults — the editor's placeholders track the
	 *  server instead of hardcoding them. */
	ttsDefaults: typeof ttsCloudDefaults;
	/** Blank-auth defaults per kind — one source with the schema. */
	authDefaults: typeof authDefaults;
	/** auth.jsonl record names as loaded at boot (sorted, values never). */
	authNames: string[];
}

/** POST config — the form's body; "" clears an optional block. */
export interface ConfigPostBody {
	providers: Record<string, ProviderConfig>;
	model: string;
	// "" clears — server normalizes.
	titleModel: string;
	favorites: string[];
	thinking: ThinkingLevel;
	// Blank model/auth on a cloud arm mean the kind's defaults —
	// the schema materializes them server-side like transcription.
	tts:
		| ""
		| { kind: "edge"; voice: string; rate: string | undefined; voices: string[] | undefined }
		| { kind: "openrouter" | "logfare" | "mimo"; model?: string; auth?: string; voice?: string };
	// Absent/blank fields mean "the kind's default" (model, auth) or
	// "detect" (language); keywords/engine/weights are whistle-only and
	// round-tripped untouched so a page save never drops hand edits.
	transcription:
		| ""
		| {
				kind: (typeof transcriptionKinds)[number];
				model?: string;
				auth?: string;
				language?: string;
				keywords?: string[];
				engine?: string;
				weights?: string;
		  };
	// mode is a hand-edit escape hatch the form round-trips untouched.
	vision: "" | { model: string; maxTokens: number; mode?: "auto" | "always" };
	search: "" | Array<{ kind: string; auth?: string }>;
	fetch: "" | Array<{ kind: string; auth?: string }>;
	operators: number[];
	allowedUsers: number[];
	telegram: {
		// "" clears; an absent key would keep the saved root (JSON drops undefined).
		apiRoot: string;
		dmGapMinutes: number;
		model?: string;
		thinking?: ThinkingLevel;
		// Rich-reply kill switch + reasoning toggle — the phone-only
		// operator's off-switch for draft streaming (design/telegram.md).
		richReplies: boolean;
		showReasoning: boolean;
	};
	publicUrl: string;
	http: { port: number };
	memory:
		| ""
		| {
				baseUrl: string;
				bankId: string;
				auth: string | undefined;
				budget: "low" | "mid" | "high";
				maxTokens: number | undefined;
				recallTimeoutMs: number | undefined;
		  };
	logLevel: "debug" | "info" | "warn" | "error";
}

/** GET thinking-levels?kind&model&base — the rungs a model can express. */
export interface ThinkingLevelsResponse {
	levels: string[];
}

export type MemoryState = "disabled" | "healthy" | "degraded" | "pending";

export interface MemoryBlockedItem {
	document: string;
	error: string | null;
	attempts: number;
}

/** GET memory/status — the /memory command's sources, reduced. */
export interface MemoryStatusResponse {
	state: MemoryState;
	/** Forget work parked across every bank, awaiting confirmation. */
	deleting: number;
	detail: string;
	completed: number;
	blocked: number;
	dismissed: number;
	/** pending + submitted — everything the worker still owes Hindsight. */
	queued: number;
	lastRecallAt: string | null;
	lastRecallOk: boolean | null;
	topicNote: null;
	blockedDetail: MemoryBlockedItem[];
}

/** GET memory/documents — one retained exchange. */
export interface MemoryDocListItem {
	id: string;
	createdAt: string | null;
	updatedAt: string | null;
	textLength: number;
	factCount: number;
	conversationId: string | null;
}

/** GET memory/documents — one page plus the server-side total. */
export interface MemoriesListResponse {
	items: MemoryDocListItem[];
	total: number;
	limit: number;
	offset: number;
}

/** One extracted fact — what recall actually returns into turns. */
export interface MemoryFactItem {
	id: string;
	text: string;
	factType: string | null;
	// 'valid' | 'invalidated' — the client dims anything but valid.
	state: string | null;
	occurredStart: string | null;
	occurredEnd: string | null;
	mentionedAt: string | null;
	entities: string | null;
}

/** GET memory/documents/<id> — the document plus its facts. */
export interface MemoryDocDetailResponse {
	document: MemoryDocListItem;
	originalText: string | null;
	facts: MemoryFactItem[];
	factsTotal: number;
}

/** DELETE memory/documents/<id> — the forget outcome. */
export interface MemoryForgetResponse {
	ok: true;
	cancelled: number;
	redacted: number;
}

/** GET skills/from?conversation — one skill generated by that thread. */
export interface ThreadSkillItem {
	skill: string;
	/** installed | proposed | gone — resolved live from the catalog. */
	state: "installed" | "proposed" | "gone";
	/** reviewer | turn — the authoring path that last wrote it here. */
	kind: "reviewer" | "turn";
	firstAt: string;
	lastAt: string;
}

/** GET skills/from?conversation — the thread's generated skills. */
export interface ThreadSkillsResponse {
	items: ThreadSkillItem[];
}

/** GET programs — one scheduled program. */
export interface OperatorProgramItem {
	id: number;
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hasHook: boolean;
	mailFilter: string | null;
	enabled: boolean;
	chatId: number;
	threadId: number | null;
	createdAt: string;
	lastRun: string | null;
	nextRun: string | null;
}

export interface OperatorProgramsResponse {
	programs: OperatorProgramItem[];
}

/** GET delegations — one delegated harness run. */
export interface OperatorDelegationItem {
	id: number;
	name: string;
	harness: string;
	status: "starting" | "running" | "needs_input" | "done" | "failed" | "stopped";
	target: string | null;
	task: string;
	cwd: string;
	/** Set on spin-offs — the app conversation that owns the work. */
	appConversation: string | null;
	chatId: number;
	threadId: number | null;
	createdAt: string;
	promptedAt: string;
	finishedAt: string | null;
}

export interface OperatorDelegationsResponse {
	delegations: OperatorDelegationItem[];
}

/** GET status — the service card: identity, uptime, drift, memory. */
export interface OperatorStatusResponse {
	version: string;
	startedAt: string;
	uptimeSec: number;
	/** Boot-pinned settings whose live values differ — restart applies. */
	restartHints: string[];
	memory: MemoryStatusResponse;
	programs: { total: number; enabled: number } | null;
	delegations: { total: number; active: number } | null;
}

// State viewer (ruling 2026-10-11): read-only views over $GOBLIN_HOME —
// skills, attachments, identity files, log tail. The shapes are owned
// and validated in stateview.ts next to the containment wall they
// describe; re-exported here so the client keeps one contract module.
export type {
	AttachmentsResponse,
	IdentityFile,
	IdentityResponse,
	LogTailItem,
	LogTailResponse,
	OperatorAttachmentItem,
	OperatorSkillItem,
	SkillFileResponse,
	SkillsResponse,
} from "../stateview.ts";
