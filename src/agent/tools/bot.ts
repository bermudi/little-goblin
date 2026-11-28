import { z } from "zod";
import type { ConfigRef } from "../../config.ts";
import { ConfigValidationError, parseConfig } from "../../config.ts";
import { thinkingLevels } from "../../config-schema.ts";
import type { BotProposals } from "../../bot-proposals.ts";
import { defineTool } from "../../tool.ts";

const inputSchema = z.strictObject({
	action: z.literal("propose"),
	name: z.string().trim().min(1).max(200),
	instructions: z.string().trim().min(1).max(20_000),
	model: z.string().min(1).optional(),
	thinking: z.enum(thinkingLevels).optional(),
});

export type BotToolDeps = {
	proposals: BotProposals;
	conversationId: string;
	configRef: ConfigRef;
};

export const botTool = (deps: BotToolDeps) =>
	defineTool({
		description:
			"Propose a bot when the operator asks for one. A bot is for lasting work with one job. The operator must approve it before it exists. Read the bots skill first.",
		input: inputSchema,
		execute: (raw, context) => {
			context.abortSignal?.throwIfAborted();
			const parsed = inputSchema.safeParse(raw);
			if (!parsed.success) return { error: `invalid arguments — ${parsed.error.issues[0]?.message ?? "bad input"}` };
			const input = parsed.data;
			let model: string | null = null;
			if (input.model !== undefined) {
				try {
					model = parseConfig({ ...deps.configRef.current, model: input.model }).model;
				} catch (error) {
					if (error instanceof ConfigValidationError) return { error: error.message };
					throw error;
				}
			}
			const proposal = deps.proposals.propose({
				conversationId: deps.conversationId,
				name: input.name,
				instructions: input.instructions,
				model,
				thinking: input.thinking ?? null,
			});
			if (proposal === null) return { error: "Only Little Goblin can propose a bot from an active app chat." };
			return { message: `Proposal #${proposal.id} is waiting for the operator. The bot exists only after they approve it.` };
		},
	});
