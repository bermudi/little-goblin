import { z } from "zod";
import { defineTool } from "../../tool.ts";
import type { Asks } from "../../asks.ts";

const schema = z.object({
	action: z.enum(["open", "list", "close"]),
	question: z.string().optional(),
	options: z.array(z.string()).optional(),
	id: z.number().int().positive().optional(),
}).strict().superRefine((input, ctx) => {
	if (input.action === "open" && input.question === undefined) {
		ctx.addIssue({ code: "custom", path: ["question"], message: "open needs a question" });
	}
	if (input.action === "close" && input.id === undefined) {
		ctx.addIssue({ code: "custom", path: ["id"], message: "close needs an id" });
	}
});

export interface AskToolDeps {
	asks: Pick<Asks, "open" | "listOpen" | "close">;
	conversationId: string;
}

export function askTool(deps: AskToolDeps) {
	return defineTool({
		description: `Ask the operator a question that waits for an answer. The app shows it as a card in this chat, with up to four buttons if you give options, and marks the chat in the chat list as needing the operator until the question is closed. A button tap sends "[ask] <question> → <label>" as the operator's message and closes the question; the operator can also close it with "No answer needed". action "open" asks; "list" shows the open questions of this chat (in the Rolling chat, of every roll); "close" closes one by id — close a question once the operator has answered it in their own words. Only the app shows questions.`,
		input: schema,
		execute: (input) => {
			const parsed = schema.parse(input);
			if (parsed.action === "list") {
				return { questions: deps.asks.listOpen(deps.conversationId) };
			}
			if (parsed.action === "close") {
				const result = deps.asks.close(parsed.id!, "goblin", deps.conversationId);
				if (result === "closed") return { closed: true };
				if (result === "already") return { closed: false, note: "already closed" };
				return { error: result === "missing" ? "question not found" : "question is outside this chat" };
			}
			const result = deps.asks.open({
				conversationId: deps.conversationId,
				question: parsed.question!,
				...(parsed.options !== undefined ? { options: parsed.options } : {}),
			});
			return "error" in result ? result : { id: result.id };
		},
	});
}
