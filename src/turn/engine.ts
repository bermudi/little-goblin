// The named engine boundary at the agent loop's fork. Every engine
// consumes the same deps object minus the step (plus its own step
// variant) and emits the identical UIMessageChunk wire, journal rows,
// and telemetry contract — channel sinks, replay/attach, and
// crash-resume stay engine-neutral.

import type { MediaPosition } from "../agent/attachments.ts";
import type { ClaudeStep } from "../agent/claude-code/mod.ts";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type { StreamDeps, StreamOutcome, WireMember } from "./stream.ts";

/** One model call as the engines consume it — the ai-sdk step variant. */
export interface ModelStep {
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

/** The deps object every engine consumes, minus the step it adds back. */
export type EngineInput<M extends WireMember> = Omit<StreamDeps<M>, "step">;

export interface TurnEngine<S extends ModelStep | ClaudeStep = ModelStep | ClaudeStep> {
	/** Which engine this is: "ai-sdk" | "claude-code" | future. */
	readonly id: string;
	accepts(step: ModelStep | ClaudeStep): step is S;
	run<M extends WireMember>(input: EngineInput<M> & { step: S }): Promise<StreamOutcome>;
}

/**
 * The ref stamped on the landed reply's metadata.model — one
 * computation shared by the view context (reasoning origin, #417) and
 * both engines' reply metadata so they cannot diverge.
 */
export function stepModelRef(step: ModelStep | ClaudeStep): string {
	if (step.label !== undefined) return step.label;
	// ModelStep is the only variant whose label can be absent.
	const model = (step as ModelStep).model;
	return typeof model === "string" ? model : model.modelId;
}

export function isClaudeStep(step: ModelStep | ClaudeStep): step is ClaudeStep {
	return "engine" in step && step.engine === "claude-code";
}

/** First engine whose `accepts` is true; none is a loud turn failure. */
export function pickEngine(
	engines: readonly TurnEngine[],
	step: ModelStep | ClaudeStep,
	convId: string,
): TurnEngine {
	const engine = engines.find((candidate) => candidate.accepts(step));
	if (engine === undefined) {
		throw new Error(
			`conversation ${convId} has no engine for this step (engines: ${engines
				.map((candidate) => candidate.id)
				.join(", ")})`,
		);
	}
	return engine;
}
