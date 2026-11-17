// ask_operator (design/agents.md → agent): an agent-type child's way
// to pause for the operator. The call records a pending question on
// the child's registry row; when the turn ends the engine settles the
// child needs-input and releases its desktop leases, and the parent's
// wake carries the question. The operator's answer continues the same
// child through the agent tool's send verb.

import { z } from "zod";
import { defineTool } from "../../tool.ts";

const MAX_QUESTION_CHARS = 8000;

const inputSchema = z.object({
	question: z.string().min(1).max(MAX_QUESTION_CHARS),
});

export interface AskOperatorToolDeps {
	/** Bound to the child conversation — records the pending question. */
	recordAsk(question: string): { ok: true } | { error: string };
}

export const ASK_OPERATOR_TOOL_NAME = "ask_operator";

export function askOperatorTool(deps: AskOperatorToolDeps) {
	return defineTool({
		description:
			"Pause this task and ask the operator a concrete question. Use when blocked, permission is required, or the operator must choose. The question wakes the requesting conversation; the answer continues this same task. Make this your only tool call, then end your turn.",
		input: inputSchema,
		execute: (input) => {
			const res = deps.recordAsk(input.question);
			if ("error" in res) return { error: res.error };
			return {
				recorded: true,
				note: "question recorded — end your turn now; the operator's answer continues this task",
			};
		},
	});
}
