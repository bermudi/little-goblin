// The mail tool — the operator-gated send (DESIGN.md, "Email"). Send
// never sends: it hands the draft to the approval gate, which queues
// the outbox row and posts it with Send/Cancel buttons, returning
// "awaiting operator approval". The tool holds only the gate's request
// closure: no auth store, no send credential, no config, no Telegram —
// the composition root owns those, so no tool path can mint a send
// token however the model phrases it.
//
// Reads left this tool for the goblin-mail wrapper + gws skill (the
// sanctioned read path: gws reads, fenced and injection-checked): the
// model's "read me that mail" runs `$GOBLIN_HOME/goblin-mail` through
// bash, never this tool. Attachments ride the same door (`gws` fetch
// to a workspace file).

import { tool } from "ai";
import { z } from "zod";

const addressSchema = z.email().max(320);

/** What a send asks the gate for — the draft content. The address is
 *  pre-bound per conversation at the composition root. */
export interface MailDraftInput {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	replyToId?: string;
}

export interface MailToolDeps {
	/** Hand a send to the approval gate: it queues the outbox row,
	 *  posts the draft with Send/Cancel into this conversation
	 *  (pre-bound at the composition root — the model never sees chat
	 *  ids), binds the buttons' message id, and resolves the
	 *  model-facing verdict. */
	requestDraft(input: MailDraftInput): Promise<{ queued: number; status: string } | { error: string }>;
}

const sendSchema = z.object({
	action: z.literal("send"),
	to: z.array(addressSchema).min(1).max(10),
	cc: z.array(addressSchema).max(10).optional(),
	subject: z.string().max(500).optional(),
	body: z.string().min(1).max(200_000),
	replyToId: z.string().min(1).max(256).optional(),
});

// Tool providers expect an object at the root; the single-action tool
// keeps the flat wire shape the old search/read/send union had (action
// first) so the provider's argument generation never moves.
export const mailInputSchema = z.object({
	action: z.literal("send"),
	to: sendSchema.shape.to.optional(),
	cc: sendSchema.shape.cc,
	subject: sendSchema.shape.subject,
	body: sendSchema.shape.body.optional(),
	replyToId: sendSchema.shape.replyToId,
}).superRefine((value, ctx) => {
	const result = sendSchema.safeParse(value);
	if (!result.success) for (const issue of result.error.issues) {
		ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
	}
});

export const mailTool = (deps: MailToolDeps) =>
	tool({
		description:
			"Draft a mail for the operator to send. Send never sends directly: it queues a draft the operator approves with a Send button in Telegram — the result tells you it is awaiting approval, and you wait for the operator instead of announcing a sent mail. To read mail, use bash with the goblin-mail wrapper ($GOBLIN_HOME/goblin-mail search|read — see the gws skill): its reads are injection-checked and fenced.",
		inputSchema: mailInputSchema,
		execute: async (raw) => {
			const input = sendSchema.parse(raw);
			// The gate does the rest — queue, post the draft with its
			// buttons, bind, and cancel-on-post-failure. The tool
			// never touches Telegram.
			return deps.requestDraft({
				to: input.to,
				...(input.cc !== undefined ? { cc: input.cc } : {}),
				subject: input.subject ?? "",
				body: input.body,
				...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
			});
		},
	});
