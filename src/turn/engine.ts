// The named engine boundary at the agent loop's fork. Every engine
// consumes the same deps object minus the step (plus its own step
// variant) and emits the identical UIMessageChunk wire, journal rows,
// and telemetry contract — channel sinks, replay/attach, and
// crash-resume stay engine-neutral.

import type { StreamDeps, StreamOutcome, WireMember } from "./stream.ts";

/** The deps object every engine consumes, minus the step it adds back. */
export type EngineInput<M extends WireMember> = Omit<StreamDeps<M>, "step">;

export interface EngineStep {
	readonly engine: string;
}

export interface TurnEngine<S extends EngineStep = EngineStep> {
	/** Which engine this is: "ai-sdk" | "claude-code" | future. */
	readonly id: string;
	accepts(step: EngineStep): step is S;
	run<M extends WireMember>(input: EngineInput<M> & { step: S }): Promise<StreamOutcome>;
}

/** First engine whose `accepts` is true; none is a loud turn failure. */
export function pickEngine(
	engines: readonly TurnEngine[],
	step: EngineStep,
	convId: string,
): TurnEngine {
	const engine = engines.find((candidate) => candidate.accepts(step));
	if (engine === undefined) {
		throw new Error(
			`conversation ${convId} has no engine for step engine "${step.engine}" (engines: ${engines
				.map((candidate) => candidate.id)
				.join(", ")})`,
		);
	}
	return engine;
}
