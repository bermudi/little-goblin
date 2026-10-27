// The claude-code engine's pinned wire shapes — the subset of the SDK's
// event stream goblin consumes, structurally typed so the fake query
// (testkit/fake-claude.ts) and the live drift check construct them
// without importing the vendor package (module-boundaries: the SDK is
// known only inside this directory).
//
// Pinned from @anthropic-ai/claude-agent-sdk 0.3.311 (bundled CLI
// 2.1.311) by the Phase 0 spike: no-auth spawn, env replacement,
// CLAUDE_CONFIG_DIR isolation, and MCP registration were verified live
// 2026-10-27; the model-serving frames (stream events, real usage
// splits, rate-limit and overflow errors, abort mid-stream) are
// type-pinned until the live drift check runs against the subscription
// (live.test.ts) — treat those as UNVERIFIED.

// ---------- usage ----------

/** BetaUsage's billing fields, snake_case as the Messages API sends it. */
export interface ClaudeUsage {
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

/** ModelUsage on the result message — camelCase, per-model totals. */
export interface ClaudeModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUSD: number;
	contextWindow: number;
	maxOutputTokens: number;
}

// ---------- messages ----------

export interface ClaudeContentBlock {
	type: "text" | "thinking" | "redacted_thinking" | "tool_use" | (string & {});
	/** text blocks */
	text?: string;
	/** thinking blocks */
	thinking?: string;
	/** tool_use blocks */
	id?: string;
	name?: string;
	input?: unknown;
}

/** An assistant message as it arrives complete on the SDK stream. */
export interface ClaudeMessage {
	id: string;
	model: string;
	role: "assistant";
	content: ClaudeContentBlock[];
	stop_reason: string | null;
	usage: ClaudeUsage | null;
}

// ---------- streaming (includePartialMessages) ----------

export type ClaudeStreamEvent =
	| { type: "message_start"; message: { model?: string; usage: ClaudeUsage | null } }
	| {
			type: "content_block_start";
			index: number;
			content_block: { type: string; id?: string; name?: string; text?: string };
	  }
	| {
			type: "content_block_delta";
			index: number;
			delta: { type: string; text?: string; thinking?: string; partial_json?: string };
	  }
	| { type: "content_block_stop"; index: number }
	| {
			type: "message_delta";
			delta: { stop_reason: string | null };
			usage: Partial<ClaudeUsage> | null;
	  }
	| { type: "message_stop" };

// ---------- frames ----------

export interface ClaudeToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content?: unknown;
	is_error?: boolean | undefined;
}

export interface ClaudeInitEvent {
	type: "init";
	sessionId?: string;
	model?: string;
	cliVersion?: string;
	tools?: unknown[];
	mcpServers?: unknown[];
}

export interface ClaudeStreamFrameEvent {
	type: "stream";
	event: ClaudeStreamEvent;
}

export interface ClaudeAssistantEvent {
	type: "assistant";
	message: ClaudeMessage;
	/** The CLI's typed error taxonomy when this message is a synthetic error. */
	error?: string;
}

export interface ClaudeUserEvent {
	type: "user";
	content: string | ClaudeToolResultBlock[];
	toolUseResult?: unknown;
}

export interface ClaudeResultEvent {
	type: "result";
	subtype: string;
	isError: boolean;
	result: string;
	numTurns: number;
	durationMs: number;
	totalCostUsd: number;
	usage: ClaudeUsage | null;
	modelUsage: Record<string, ClaudeModelUsage> | null;
	terminalReason?: string | null;
}

/** The frames the engine consumes; every other SDK frame type is ignored. */
export type ClaudeEvent =
	| ClaudeInitEvent
	| ClaudeStreamFrameEvent
	| ClaudeAssistantEvent
	| ClaudeUserEvent
	| ClaudeResultEvent;

// ---------- the injectable query seam ----------

export interface ClaudeQueryCall {
	/** The full assembled view, serialized (media rides as blocks). */
	prompt: PromptContent;
	options: ClaudeQueryOptions;
}

/** One user message's content: text with inline media blocks. */
export interface PromptContent {
	blocks: Array<
		| { kind: "text"; text: string }
		| { kind: "image"; mediaType: string; data: string }
		| { kind: "document"; mediaType: string; data: string; filename?: string }
	>;
}

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeQueryOptions {
	model: string;
	systemPrompt: string;
	maxTurns: number;
	// SDK ThinkingConfig: adaptive is the model's own depth control.
	thinking: { type: "disabled" } | { type: "adaptive" };
	effort?: ClaudeEffort;
	mcpServers: unknown;
	allowedTools: string[];
	cwd: string;
	env: Record<string, string>;
	abortController: AbortController;
	stderr?: (data: string) => void;
}

export type ClaudeQuery = (call: ClaudeQueryCall) => AsyncIterable<ClaudeEvent>;
