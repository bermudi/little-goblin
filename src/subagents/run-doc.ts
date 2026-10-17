import { defineDoc } from "@earendil-works/pi-durable";

// ---------- the typed run document ----------

// The crash gap this closes: goblin's row and Pi's transcript are two
// stores. The outcome is committed HERE, inside the tool invocation,
// before the tool returns — and it carries the input revision it
// answered, so a resume that persisted new intent but crashed before
// clearing the doc can't be mis-settled by the old question's outcome.
export type RunOutcomeBody =
	| { kind: "done"; result: string; files: string[] }
	| { kind: "ask"; question: string };
export type RunOutcome = RunOutcomeBody & { rev: number };
type RunDocState = {
	runId: number | null;
	/** The input revision the conversation is currently answering. */
	inputRev: number;
	outcome: RunOutcome | null;
};
export const RunDoc = defineDoc<RunDocState>({
	kind: "goblin.subagent-run",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ runId: null, inputRev: 0, outcome: null }),
});

