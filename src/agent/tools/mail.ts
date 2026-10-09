// The send-only tool hands drafts to the approval gate; it holds no sender
// credential or Telegram context. Reads use goblin-mail + gws instead, so
// this boundary cannot be used to bypass the checked read path.

import { tool } from "ai";
import { z } from "zod";

const addressSchema = z.email().max(320);

// Reject line breaks before approval text is rendered or headers are encoded;
// keeping this boundary explicit prevents an encoder refactor from reopening
// header injection.
const subjectSchema = z
	.string()
	.max(500)
	.refine((s) => !/[\r\n]/.test(s), { message: "subject must not contain line breaks" });

export interface MailDraftInput {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	replyToId?: string;
}

export interface MailToolDeps {
	/** Queue and present a draft in the pre-bound conversation, then return the
	 * model-facing verdict. */
	requestDraft(
		input: MailDraftInput,
	): Promise<{ queued: number; status: string } | { error: string }>;
}

const sendSchema = z.object({
	action: z.literal("send"),
	to: z.array(addressSchema).min(1).max(10),
	cc: z.array(addressSchema).max(10).optional(),
	subject: subjectSchema.optional(),
	body: z.string().min(1).max(200_000),
	replyToId: z.string().min(1).max(256).optional(),
});

// Keep the action at the root: some providers fail to generate arguments for
// a nested discriminated union.
export const mailInputSchema = z
	.object({
		action: z.literal("send"),
		to: sendSchema.shape.to.optional(),
		cc: sendSchema.shape.cc,
		subject: sendSchema.shape.subject,
		body: sendSchema.shape.body.optional(),
		replyToId: sendSchema.shape.replyToId,
	})
	.superRefine((value, ctx) => {
		const result = sendSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
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
			return deps.requestDraft({
				to: input.to,
				...(input.cc !== undefined ? { cc: input.cc } : {}),
				subject: input.subject ?? "",
				body: input.body,
				...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
			});
		},
	});
