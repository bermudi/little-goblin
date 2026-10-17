// The typed run document (design/subagents.md → crash gaps): goblin's
// row and Pi's transcript are two stores; the terminal outcome is
// committed HERE, inside the tool invocation, before the tool returns.

import { defineDoc } from "@earendil-works/pi-durable";

// The crash gap this closes: goblin's row and Pi's transcript are two
// stores. The outcome is committed HERE, inside the tool invocation,
// before the tool returns — and it carries the input revision it
// answered, so a resume that persisted new intent but crashed before
// clearing the doc can't be mis-settled by the old question's outcome.
export type RunOutcomeBody =
	| { kind: "done"; result: string; files: string[] }
	| { kind: "ask"; question: string }
	// Written by the approval gate when a crash decision abandons a
	// crash-ambiguous call — settlement reports the verdict, not a
	// generic "no terminal tool" failure.
	| { kind: "aborted"; reason: string };
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
