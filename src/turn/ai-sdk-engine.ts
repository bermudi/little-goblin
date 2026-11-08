// The default turn engine: turn/stream.ts's driveStream behind the
// TurnEngine boundary (turn/engine.ts).

import type { ClaudeStep } from "../agent/claude-code/mod.ts";
import type { ModelStep } from "../runtime.ts";
import { type EngineInput, isClaudeStep, type TurnEngine } from "./engine.ts";
import { type StreamOutcome, driveStream, type WireMember } from "./stream.ts";

export const aiSdkEngine: TurnEngine<ModelStep> = {
	id: "ai-sdk",
	accepts(step: ModelStep | ClaudeStep): step is ModelStep {
		return !isClaudeStep(step);
	},
	run<M extends WireMember>(input: EngineInput<M> & { step: ModelStep }): Promise<StreamOutcome> {
		return driveStream<M>(input);
	},
};
