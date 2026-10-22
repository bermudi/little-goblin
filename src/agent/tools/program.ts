import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import type { ProgramProposal } from "../../program-proposals.ts";
import { PROPOSAL_CHARTER_MAX } from "../../program-proposals.ts";
import { startProgramOps, type ProgramOpResult, type ProgramStaged } from "../../program-ops.ts";
import type { Program, ProgramsStore } from "../../programs.ts";

function programView(program: Program): Record<string, unknown> {
	return {
		id: program.id,
		name: program.name,
		charter: program.charter,
		cron: program.cron,
		max_lateness_minutes: program.maxLatenessMinutes,
		has_hook: program.hookHash !== null,
		mail_filter: program.mailFilter,
		enabled: program.enabled,
		last_run: program.lastRun,
		next_run: program.nextRun,
	};
}

function proposalView(proposal: ProgramProposal): Record<string, unknown> {
	return {
		id: proposal.id,
		kind: proposal.kind,
		...(proposal.targetId !== null ? { program: proposal.targetId } : {}),
		state: proposal.state,
		request: proposal.draft ?? proposal.patch,
		created_at: proposal.createdAt,
		...(proposal.activatedId !== null ? { activated_program: proposal.activatedId } : {}),
	};
}

export type ProgramToolDeps = {
	programs: ProgramsStore;
	publicUrl(): string | undefined;
	/** Absent when Telegram is disabled: hook grants still stage through
	 * the shared approval owner, but rotating an existing credential cannot
	 * mutate state before finding out the private lane is gone. */
	sendPrivate?(text: string): Promise<void>;
	/** Posts a staged proposal for the operator's decision — throws when the
	 *  approval could not be delivered. The staging turn's abort signal
	 *  fences the posting chunk by chunk; the proposal stays pending either
	 *  way. */
	requestApproval(proposal: ProgramProposal, signal?: AbortSignal): Promise<void>;
} & ({ target: string } | { chatId: number; threadId: number | null });

export function makePrivateSender(
	send: (chatId: number, text: string) => Promise<unknown>,
	operatorIds: () => number[],
): (text: string) => Promise<void> {
	return async (text) => {
		let delivered = 0;
		for (const id of operatorIds()) {
			try {
				await send(id, text);
				delivered++;
				log.info("private delivery", { user: id });
			} catch (err) {
				log.warn("private delivery failed", err, {
					user: id,
				});
			}
		}
		if (delivered === 0) {
			throw new Error(
				"couldn't DM the operator — they may need to open a private chat with the bot first",
			);
		}
	};
}

const listSchema = z.object({ action: z.literal("list") });
const createSchema = z.object({
	action: z.literal("create"),
	name: z.string().min(1).max(100),
	charter: z.string().min(1).max(PROPOSAL_CHARTER_MAX),
	cron: z.string().min(5).optional(),
	maxLatenessMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	hook: z.boolean().optional(),
	mailFilter: z.string().min(1).max(500).optional(),
});
const updateSchema = z.object({
	action: z.literal("update"),
	id: z.number().int().positive(),
	name: z.string().min(1).max(100).optional(),
	charter: z.string().min(1).max(PROPOSAL_CHARTER_MAX).optional(),
	cron: z.string().min(5).nullable().optional(),
	maxLatenessMinutes: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.nullable()
		.optional(),
	mailFilter: z.string().min(1).max(500).nullable().optional(),
});
const deleteSchema = z.object({ action: z.literal("delete"), id: z.number().int().positive() });
const toggleSchema = z.object({ action: z.literal("toggle"), id: z.number().int().positive() });
const hookSchema = z.object({
	action: z.literal("hook"),
	id: z.number().int().positive(),
	op: z.enum(["enable", "rotate", "disable"]),
});
const reviewSchema = z.object({ action: z.literal("review"), id: z.number().int().positive() });
const actionSchema = z.discriminatedUnion("action", [
	listSchema,
	createSchema,
	updateSchema,
	deleteSchema,
	toggleSchema,
	hookSchema,
	reviewSchema,
]);

export const programInputSchema = z
	.object({
		action: z.enum(["list", "create", "update", "delete", "toggle", "hook", "review"]),
		name: createSchema.shape.name.optional(),
		charter: createSchema.shape.charter.optional(),
		cron: updateSchema.shape.cron,
		maxLatenessMinutes: updateSchema.shape.maxLatenessMinutes,
		hook: createSchema.shape.hook,
		mailFilter: updateSchema.shape.mailFilter,
		id: updateSchema.shape.id.optional(),
		op: hookSchema.shape.op.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

export const programTool = (deps: ProgramToolDeps) => {
	const ops = startProgramOps({
		programs: deps.programs,
		publicUrl: deps.publicUrl,
		requestApproval: deps.requestApproval,
	});
	return tool({
		description:
			"Manage programs — a program is standing authority for one concern. Its charter says what it owns: scope, what needs the operator's OK, when to escalate, what not to do, and the steps — write that, not a one-line instruction. A cron is 5 fields (minute hour day month weekday) in server local time; translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. Optional maxLatenessMinutes limits how late a scheduled fire may run; omitted means unlimited (fire once on wake). On update, null clears the limit. A late catch-up coalesces missed occurrences into at most one fire based on the latest missed occurrence. The 'hook' action gives a program a secret URL that external services POST to wake it — the URL is sent to the operator privately and never appears to you. A mail filter (Gmail query syntax, e.g. from:bank is:important) wakes the program when new matching mail arrives. Grant-shaped changes are proposals, never self-grants: 'create', any charter text change, adding a trigger kind (a cron where none existed, a new or changed mail filter, a hook on a program that lacks one) all stage a pending proposal the operator approves on the originating approval surface — the request activates only on their decision. Rescheduling an existing cron, renaming, lateness edits, toggling, deleting, removing a trigger and rotating an existing hook apply directly. 'review' re-posts a pending proposal's approval after a delivery failure.",
		inputSchema: programInputSchema,
		execute: async (raw, options) => {
			const input = actionSchema.parse(raw);
			const address =
				"target" in deps
					? { target: deps.target }
					: { chatId: deps.chatId, threadId: deps.threadId };
			// The staging turn's stop signal fences the approval posting —
			// carried through every staging op below.
			const signal = options?.abortSignal;
			switch (input.action) {
				case "list":
					return {
						programs: deps.programs.list().map(programView),
						proposals: deps.programs.proposals.pending().map(proposalView),
					};
				case "create":
					return opResult(
						await ops.create(
							{
								name: input.name,
								charter: input.charter,
								cron: input.cron ?? null,
								maxLatenessMinutes: input.maxLatenessMinutes ?? null,
								hook: input.hook === true,
								mailFilter: input.mailFilter ?? null,
							},
							address,
							signal,
						),
					);
				case "update": {
					const patch: {
						name?: string;
						charter?: string;
						cron?: string | null;
						maxLatenessMinutes?: number | null;
						mailFilter?: string | null;
					} = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.charter !== undefined) patch.charter = input.charter;
					if (input.cron !== undefined) patch.cron = input.cron;
					if (input.maxLatenessMinutes !== undefined)
						patch.maxLatenessMinutes = input.maxLatenessMinutes;
					if (input.mailFilter !== undefined) patch.mailFilter = input.mailFilter;
					return opResult(await ops.update(input.id, patch, address, signal));
				}
				case "delete":
					return opResult(ops.remove(input.id));
				case "toggle":
					return opResult(ops.toggle(input.id));
				case "hook": {
					const before = deps.programs.get(input.id);
					if (
						before !== null &&
						before.hookHash !== null &&
						input.op !== "disable" &&
						deps.sendPrivate === undefined
					) {
						return {
							error:
								"telegram channel is disabled — rotate or reveal the hook from Programs in the app instead",
						};
					}
					const result = await ops.hook(input.id, input.op, address, signal);
					if (result.kind !== "rotated") return opResult(result);
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
					const err = await sendHookUrl(deps, current, result.url);
					if (err !== null) {
						return {
							error: `hook rotated but the URL delivery failed: ${err} — run hook/rotate to resend`,
						};
					}
					return { hook: "rotated", url_sent: true };
				}
				case "review":
					return reviewResult(await ops.review(input.id, signal));
			}
		},
	});
};

function opResult(result: ProgramOpResult): Record<string, unknown> {
	switch (result.kind) {
		case "program":
			return { program: programView(result.program) };
		case "deleted":
			return { deleted: result.id };
		case "proposal":
			return stagedResult(result);
		case "error":
			return { error: result.message };
		case "rotated":
			throw new Error("hook rotation reached a public tool result");
	}
}

function reviewResult(result: ProgramOpResult): Record<string, unknown> {
	if (result.kind === "proposal" && result.proposal.state !== "pending") {
		return {
			proposal: proposalView(result.proposal),
			status: `already ${result.proposal.state}`,
		};
	}
	return opResult(result);
}

function stagedResult(result: ProgramStaged): Record<string, unknown> {
	if (!result.posted) return { proposal: proposalView(result.proposal), error: result.error };
	return {
		proposal: proposalView(result.proposal),
		status: "pending operator approval — nothing is active until they approve it",
	};
}

async function sendHookUrl(
	deps: ProgramToolDeps,
	program: Program,
	url: string,
): Promise<string | null> {
	try {
		if (deps.sendPrivate === undefined) return "telegram channel is disabled";
		await deps.sendPrivate(
			`Webhook for program ${program.name}: ${url}\nKeep it secret; rotate via goblin if it leaks.`,
		);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
