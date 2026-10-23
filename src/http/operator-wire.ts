// Leaf by design like app-wire.ts — app/src imports these, so the client
// tsconfig (lib DOM) typechecks everything they transitively pull.

import type {
	authDefaults,
	Config,
	ProviderConfig,
	ThinkingLevel,
	transcriptionDefaults,
	transcriptionKinds,
	ttsCloudDefaults,
} from "../config.ts";

export interface ModelOption {
	id: string;
	name: string | null;
	releaseDate: string | null;
}

export interface ProviderModelCatalog {
	provider: string;
	models: ModelOption[];
}

export interface ConfigResponse {
	config: Config;
	providerKinds: readonly string[];
	searchKinds: readonly string[];
	fetchKinds: readonly string[];
	transcriptionKinds: typeof transcriptionKinds;
	transcriptionDefaults: typeof transcriptionDefaults;
	ttsDefaults: typeof ttsCloudDefaults;
	authDefaults: typeof authDefaults;
	authNames: string[];
	modelCatalog: ProviderModelCatalog[];
}

export interface ConfigPostBody {
	providers: Record<string, ProviderConfig>;
	model: string;
	titleModel: string;
	favorites: string[];
	thinking: ThinkingLevel;
	tts:
		| ""
		| { kind: "edge"; voice: string; rate: string | undefined; voices: string[] | undefined }
		| {
				kind: "openrouter" | "logfare" | "mimo" | "onemin";
				model?: string;
				auth?: string;
				voice?: string;
		  };
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
				fallbacks?: {
					kind: (typeof transcriptionKinds)[number];
					model?: string | undefined;
					auth?: string | undefined;
					language?: string | undefined;
					keywords?: string[] | undefined;
					engine?: string | undefined;
					weights?: string | undefined;
				}[];
		  };
	vision: "" | { model: string; maxTokens: number; mode?: "auto" | "always" };
	search: "" | Array<{ kind: string; auth?: string }>;
	fetch: "" | Array<{ kind: string; auth?: string }>;
	operators: number[];
	allowedUsers: number[];
	telegram: {
		enabled?: boolean;
		apiRoot: string;
		dmGapMinutes: number;
		model?: string;
		thinking?: ThinkingLevel;
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

export interface ThinkingLevelsResponse {
	levels: string[];
}

export interface SecretStoreResponse {
	ok: true;
	name: string;
	replaced: boolean;
}

export type MemoryState = "disabled" | "healthy" | "degraded" | "pending";

export interface MemoryBlockedItem {
	document: string;
	error: string | null;
	attempts: number;
}

export interface MemoryStatusResponse {
	state: MemoryState;
	deleting: number;
	detail: string;
	completed: number;
	blocked: number;
	dismissed: number;
	queued: number;
	lastRecallAt: string | null;
	lastRecallOk: boolean | null;
	topicNote: null;
	blockedDetail: MemoryBlockedItem[];
}

export interface MemoryBlockedResponse {
	ok: true;
	action: "retry" | "dismiss";
	affected: number;
}

export interface MemoryDocListItem {
	id: string;
	createdAt: string | null;
	updatedAt: string | null;
	textLength: number;
	factCount: number;
	conversationId: string | null;
}

export interface MemoriesListResponse {
	items: MemoryDocListItem[];
	total: number;
	limit: number;
	offset: number;
}

export interface MemoryFactItem {
	id: string;
	text: string;
	factType: string | null;
	state: string | null;
	occurredStart: string | null;
	occurredEnd: string | null;
	mentionedAt: string | null;
	entities: string | null;
}

export interface MemoryDocDetailResponse {
	document: MemoryDocListItem;
	originalText: string | null;
	facts: MemoryFactItem[];
	factsTotal: number;
}

export interface MemoryForgetResponse {
	ok: true;
	cancelled: number;
	redacted: number;
}

export interface ThreadSkillItem {
	skill: string;
	state: "installed" | "proposed" | "gone";
	// A proposal is parked in skills-proposed/ right now — orthogonal to
	// state, which installed wins: an installed skill can still carry an
	// undecided update proposal.
	pending: boolean;
	kind: "reviewer" | "turn";
	firstAt: string;
	lastAt: string;
}

export interface ThreadSkillsResponse {
	items: ThreadSkillItem[];
}

export interface OperatorProgramItem {
	id: number;
	name: string;
	charter: string;
	cron: string | null;
	maxLatenessMinutes: number | null;
	hasHook: boolean;
	mailFilter: string | null;
	enabled: boolean;
	target: string;
	chatId: number;
	threadId: number | null;
	createdAt: string;
	lastRun: string | null;
	nextRun: string | null;
}

export interface OperatorProgramsResponse {
	programs: OperatorProgramItem[];
}

export interface OperatorDelegationItem {
	id: number;
	name: string;
	harness: string;
	status: "starting" | "running" | "needs_input" | "done" | "failed" | "stopped";
	target: string | null;
	task: string;
	cwd: string;
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

export interface OperatorStatusResponse {
	version: string;
	startedAt: string;
	uptimeSec: number;
	restartHints: string[];
	memory: MemoryStatusResponse;
	programs: { total: number; enabled: number } | null;
	delegations: { total: number; active: number } | null;
}

export interface SkillDecideBody {
	name: string;
	action: "install" | "discard";
}

// Temp-skill preview card (ruling 2026-10-21): everything the yes/no
// decision needs — size and verdict especially. `path`/`dir` pin the
// cached copy the staged part references.
export interface SkillPreviewResponse {
	name: string;
	description: string;
	sourceUrl: string;
	path: string;
	dir: string;
	digest: string;
	bodyBytes: number;
	fileCount: number;
	dirBytes: number;
	cached: boolean;
	verdict: {
		status: "clean" | "suspicious" | "malicious" | "unavailable";
		injection: number | null;
		severity: number | null;
	};
}

export interface SkillDecideResponse {
	ok: true;
	skill: string;
	action: "install" | "discard";
	replaced: boolean;
	state: "installed" | "gone";
}

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
