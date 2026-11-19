// The AI SDK engine's step — kept out of engine.ts so the neutral engine contract names no vendor type (#596).
import type { MediaPosition } from "../agent/attachments.ts";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

export interface ModelStep {
	readonly engine: "ai-sdk";
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	// Stored reply metadata uses this resolved config reference.
	label?: string;
	// Controls which stored attachments materialize as file parts; absent means
	// attachments degrade to path references. This keeps unsupported media out
	// of the model request rather than failing the whole turn.
	inputModalities?: Set<string>;
	// Second, position-aware gate for inlining media through the provider pipe;
	// a model capability alone is not enough when the provider cannot carry it.
	carries?(mediaType: string, position: MediaPosition): boolean;
	// Whether the provider replays provider-executed tool parts (Codex
	// hosted web_search); false/absent drops them from the model view.
	keepProviderExecuted?: boolean;
	// Context-window denominator for utilization logging, when known.
	contextWindow?: number;
	// Retry budget for the provider's chat calls, when the provider's own
	// rules override the SDK default (2) — 1min bills every attempt, so
	// its steps carry 0. Absent keeps the default.
	maxRetries?: number;
	// Delay before the transient-transport step retry re-dispatches.
	// Absent keeps the SDK retry ladder's initial delay; tests zero it.
	transientRetryDelayMs?: number;
}
