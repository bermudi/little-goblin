import { defineDoc } from "@earendil-works/pi-durable";

// The outcome carries the input revision it answered: a resume that
// persisted new intent but crashed before clearing the doc can't be
// mis-settled by the old question's outcome.
export type RunOutcomeBody =
	| { kind: "done"; result: string; files: string[] }
	| { kind: "ask"; question: string }
	| { kind: "aborted"; reason: string };
export type RunOutcome = RunOutcomeBody & { rev: number };
type RunDocState = {
	runId: number | null;
	inputRev: number;
	outcome: RunOutcome | null;
};
export const RunDoc = defineDoc<RunDocState>({
	kind: "goblin.subagent-run",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	// Deltas only: the state is a few small fields, never appended to,
	// so a stored base would not be smaller than the change itself.
	checkpointWhen: () => false,
	initial: () => ({ runId: null, inputRev: 0, outcome: null }),
});
