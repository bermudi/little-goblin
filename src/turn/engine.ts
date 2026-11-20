
import type { StreamDeps, WireMember } from "./stream.ts";
import type { StreamOutcome } from "./attempt-recorder.ts";

export interface EngineRules {
	readonly toolLaunchGate: boolean;
	readonly preemptFold: boolean;
	readonly contentFilterReask: boolean;
	readonly transientRetry: boolean;
	readonly contextFill: boolean;
}

export type EngineInput<M extends WireMember> = Omit<StreamDeps<M>, "step">;

export interface EngineStep {
	readonly engine: string;
}

export interface TurnEngine<S extends EngineStep = EngineStep> {
	readonly id: string;
	readonly rules: EngineRules;
	accepts(step: EngineStep): step is S;
	run<M extends WireMember>(input: EngineInput<M> & { step: S }): Promise<StreamOutcome>;
}

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
