// The default turn engine: turn/stream.ts's driveStream behind the
// TurnEngine boundary (turn/engine.ts).

import type { ModelStep } from "./ai-sdk-step.ts";
import { type EngineInput, type TurnEngine } from "./engine.ts";
import { type StreamOutcome } from "./attempt-recorder.ts";
import { driveStream, type WireMember } from "./stream.ts";

export const aiSdkEngine: TurnEngine<ModelStep> = {
	id: "ai-sdk",
	rules: {
		toolLaunchGate: true,
		preemptFold: true,
		contentFilterReask: true,
		transientRetry: true,
		contextFill: true,
	},
	accepts(step): step is ModelStep {
		return step.engine === "ai-sdk";
	},
	run<M extends WireMember>(input: EngineInput<M> & { step: ModelStep }): Promise<StreamOutcome> {
		return driveStream<M>(input);
	},
};
