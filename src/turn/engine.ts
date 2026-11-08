// The named engine boundary at the agent loop's fork. Every engine
// consumes the same deps object minus the step (plus its own step
// variant) and emits the identical UIMessageChunk wire, journal rows,
// and telemetry contract — channel sinks, replay/attach, and
// crash-resume stay engine-neutral.

import type { ClaudeStep } from "../agent/claude-code/mod.ts";
import type { ModelStep } from "../runtime.ts";
import type { StreamDeps, StreamOutcome, WireMember } from "./stream.ts";

/** The deps object every engine consumes, minus the step it adds back. */
export type EngineInput<M extends WireMember> = Omit<StreamDeps<M>, "step">;

export interface TurnEngine<S extends ModelStep | ClaudeStep = ModelStep | ClaudeStep> {
	/** Which engine this is: "ai-sdk" | "claude-code" | future. */
	readonly id: string;
	accepts(step: ModelStep | ClaudeStep): step is S;
	run<M extends WireMember>(input: EngineInput<M> & { step: S }): Promise<StreamOutcome>;
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
