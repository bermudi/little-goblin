// The loop watchdog's system1 question (design/model.md → "No step
// budget"). Exact repetition is the deterministic detector's job; this
// question exists for what a hash cannot see — calls that all differ
// but stop producing anything new.

import type { JevQuestion } from "./jev.ts";
import type { ToolCallDigest } from "./reviewer.ts";

export const LOOP_QUESTIONS: Record<string, JevQuestion> = {
	stuck: {
		type: "noul",
		instructions:
			"An agent is partway through a task, making tool calls. The state gives the operator's request and the agent's most recent tool calls with truncated results. Decide whether the agent is STUCK: its recent calls have stopped producing new information that moves the task forward. Stuck looks like: re-running the same or near-identical calls and getting the same results; cycling between a few approaches while the results do not change; searching rephrasings of a query that keeps returning nothing relevant; retrying a failing command with cosmetic changes and getting the same error. NOT stuck: many calls that each read, change, or test something new, even when they look alike (reading many files, running many diffs, iterating on a fix while the errors change); a long exploration that keeps turning up new material.",
		criteria: {
			true: "Recent results add little or nothing new: the same results, the same errors, or the same dead end approached from slightly different angles",
			false:
				"Recent results keep adding new information or changing state, even if the calls are numerous or similar-looking",
		},
	},
};

// The window the question sees: the last LOOP_WINDOW calls. Args and
// results are pre-truncated by the caller (summarize, LOOP_CHARS each).
export const LOOP_WINDOW = 24;
export const LOOP_CHARS = 300;

export function loopState(
	request: string,
	totalToolCalls: number,
	calls: ToolCallDigest[],
): Record<string, unknown> {
	return {
		purpose: "mid-turn progress check",
		operatorRequest: request.length > 600 ? `${request.slice(0, 600)}…` : request,
		totalToolCalls,
		recentCalls: calls.slice(-LOOP_WINDOW),
	};
}
