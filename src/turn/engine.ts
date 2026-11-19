// The named engine boundary at the agent loop's fork. Every engine
// consumes the same deps object minus the step (plus its own step
// variant) and emits the identical UIMessageChunk wire, journal rows,
// and telemetry contract — channel sinks, replay/attach, and
// crash-resume stay engine-neutral.

import type { StreamDeps, StreamOutcome, WireMember } from "./stream.ts";

/** The optional turn rules an engine follows (design/runtime-turn.md → Engine rules). Mandatory rules are not listed: every engine follows them. */
export interface EngineRules {
	/** #477: an unstarted tool call is skipped while a steer waits. */
	readonly toolLaunchGate: boolean;
	/** design/compaction.md → Timing: `preemptCheck` before every model call. */
	readonly preemptFold: boolean;
	/** One same-step re-ask after a provider content filter. */
	readonly contentFilterReask: boolean;
	/** One delayed re-dispatch after a transient transport failure. */
	readonly transientRetry: boolean;
	/** `onContextFill` reported at each step. */
	readonly contextFill: boolean;
}

/** The deps object every engine consumes, minus the step it adds back. */
export type EngineInput<M extends WireMember> = Omit<StreamDeps<M>, "step">;

export interface EngineStep {
	readonly engine: string;
}

export interface TurnEngine<S extends EngineStep = EngineStep> {
	/** Which engine this is: "ai-sdk" | "claude-code" | future. */
	readonly id: string;
	readonly rules: EngineRules;
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
