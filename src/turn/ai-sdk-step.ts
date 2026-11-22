import type { MediaPosition } from "../agent/attachments.ts";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

export interface ModelStep {
	readonly engine: "ai-sdk";
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	label?: string;
	inputModalities?: Set<string>;
	carries?(mediaType: string, position: MediaPosition): boolean;
	keepProviderExecuted?: boolean;
	contextWindow?: number;
	uncapped?: boolean;
	maxRetries?: number;
	transientRetryDelayMs?: number;
}
