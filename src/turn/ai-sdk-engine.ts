// The default turn engine: turn/stream.ts's driveStream behind the
// TurnEngine boundary (turn/engine.ts).

import type { ModelStep } from "./ai-sdk-step.ts";
import { type EngineInput, type TurnEngine } from "./engine.ts";
import { type StreamOutcome, driveStream, type WireMember } from "./stream.ts";

export const aiSdkEngine: TurnEngine<ModelStep> = {
	id: "ai-sdk",
	accepts(step): step is ModelStep {
		return step.engine === "ai-sdk";
	},
	run<M extends WireMember>(input: EngineInput<M> & { step: ModelStep }): Promise<StreamOutcome> {
		return driveStream<M>(input);
	},
};
