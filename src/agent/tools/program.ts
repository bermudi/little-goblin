import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { hookTokenHash, hookUrl, newHookToken } from "../../program-hook.ts";
import { PROPOSAL_CHARTER_MAX, type ProgramProposal } from "../../program-proposals.ts";
import { nextFire, ProgramRuleError, type Program, type ProgramsStore } from "../../programs.ts";

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
	sendPrivate(text: string): Promise<void>;
	/** Posts a staged proposal for the operator's decision — throws when the
	 *  approval could not be delivered. The proposal stays pending either way. */
	requestApproval(proposal: ProgramProposal): Promise<void>;
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

export const programTool = (deps: ProgramToolDeps) =>
	tool({
		description:
			"Manage programs — a program is standing authority for one concern. Its charter says what it owns: scope, what needs the operator's OK, when to escalate, what not to do, and the steps — write that, not a one-line instruction. A cron is 5 fields (minute hour day month weekday) in server local time; translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. Optional maxLatenessMinutes limits how late a scheduled fire may run; omitted means unlimited (fire once on wake). On update, null clears the limit. A late catch-up coalesces missed occurrences into at most one fire based on the latest missed occurrence. The 'hook' action gives a program a secret URL that external services POST to wake it — the URL is sent to the operator privately and never appears to you. A mail filter (Gmail query syntax, e.g. from:bank is:important) wakes the program when new matching mail arrives. Grant-shaped changes are proposals, never self-grants: 'create', any charter text change, adding a trigger kind (a cron where none existed, a new or changed mail filter, a hook on a program that lacks one) all stage a pending proposal the operator approves on the originating approval surface — the request activates only on their decision. Rescheduling an existing cron, renaming, lateness edits, toggling, deleting, removing a trigger and rotating an existing hook apply directly. 'review' re-posts a pending proposal's approval after a delivery failure.",
		inputSchema: programInputSchema,
		execute: async (raw) => {
			const input = actionSchema.parse(raw);
			const address =
				"target" in deps
					? { target: deps.target }
					: { chatId: deps.chatId, threadId: deps.threadId };
			switch (input.action) {
				case "list":
					return {
						programs: deps.programs.list().map(programView),
						proposals: deps.programs.proposals.pending().map(proposalView),
					};
				case "create": {
					if (input.cron !== undefined) {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					try {
						const proposal = deps.programs.proposals.proposeCreate(
							{
								name: input.name,
								charter: input.charter,
								cron: input.cron ?? null,
								maxLatenessMinutes: input.maxLatenessMinutes ?? null,
								hook: input.hook === true,
								mailFilter: input.mailFilter ?? null,
							},
							address,
						);
						return await deliverApproval(deps, proposal);
					} catch (err) {
						if (isProgramRuleError(err)) {
							return { error: err.message };
						}
						throw err;
					}
				}
				case "update": {
					if (typeof input.cron === "string") {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
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
					try {
						if (requiresApproval(current, patch)) {
							// Any grant-shaped component stages the whole requested
							// patch — no partial application while it is pending.
							const proposal = deps.programs.proposals.proposeUpdate(input.id, patch, address);
							return await deliverApproval(deps, proposal);
						}
						const program = deps.programs.update(input.id, patch);
						if (program === null) return { error: `no program ${input.id}` };
						log.info("program updated", {
							program: program.id,
							name: program.name,
							maxLatenessMinutes: program.maxLatenessMinutes,
						});
						return { program: programView(program) };
					} catch (err) {
						if (isProgramRuleError(err)) {
							return { error: err.message };
						}
						throw err;
					}
				}
				case "delete": {
					const ok = deps.programs.remove(input.id);
					log.info("program deleted", { program: input.id, existed: ok });
					return ok ? { deleted: input.id } : { error: `no program ${input.id}` };
				}
				case "toggle": {
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
					const program = deps.programs.update(input.id, { enabled: !current.enabled })!;
					log.info("program toggled", { program: program.id, enabled: program.enabled });
					return { program: programView(program) };
				}
				case "hook": {
					const current = deps.programs.get(input.id);
					if (current === null) return { error: `no program ${input.id}` };
					if (input.op === "disable") {
						try {
							deps.programs.setHook(input.id, null);
						} catch (err) {
							if (isProgramRuleError(err)) {
								return { error: err.message };
							}
							throw err;
						}
						log.info("program hook disabled", { program: input.id, name: current.name });
						return { program: programView(deps.programs.get(input.id)!) };
					}
					if (current.hookHash === null) {
						// A new trigger kind stages like any widened authority —
						// the credential exists only once approved.
						try {
							const proposal = deps.programs.proposals.proposeUpdate(
								input.id,
								{ hook: true },
								address,
							);
							return await deliverApproval(deps, proposal);
						} catch (err) {
							if (isProgramRuleError(err)) {
								return { error: err.message };
							}
							throw err;
						}
					}
					const minted = mintHook(deps);
					if ("error" in minted) return { error: minted.error };
					deps.programs.setHook(input.id, hookTokenHash(minted.token));
					const err = await sendHookUrl(deps, current, minted.url);
					if (err !== null) {
						return {
							error: `hook rotated but the URL delivery failed: ${err} — run hook/rotate to resend`,
						};
					}
					log.info("program hook rotated", { program: input.id, name: current.name });
					return { hook: "rotated", url_sent: true };
				}
				case "review": {
					const proposal = deps.programs.proposals.get(input.id);
					if (proposal === null) return { error: `no proposal ${input.id}` };
					if (proposal.state !== "pending") {
						return {
							proposal: proposalView(proposal),
							status: `already ${proposal.state}`,
						};
					}
					return await deliverApproval(deps, proposal);
				}
			}
		},
	});

// The grant boundary: a different charter text always stages (the
// model never classifies its own authority widening), and so do a new
// trigger kind — a cron where none existed — and a new or changed
// non-null mail filter. Everything else stays inside granted
// authority: rescheduling an existing cron, name or lateness edits,
// clearing a filter or a cron, toggling.
function requiresApproval(
	current: Program,
	patch: {
		name?: string;
		charter?: string;
		cron?: string | null;
		maxLatenessMinutes?: number | null;
		mailFilter?: string | null;
	},
): boolean {
	if (patch.charter !== undefined && patch.charter !== current.charter) return true;
	if (
		patch.mailFilter !== undefined &&
		patch.mailFilter !== null &&
		patch.mailFilter !== current.mailFilter
	)
		return true;
	if (patch.cron !== undefined && patch.cron !== null && current.cron === null) return true;
	return false;
}

// Stage first, notify second: a failed post returns the pending
// proposal with review guidance — the row is durable, never lost.
async function deliverApproval(
	deps: ProgramToolDeps,
	proposal: ProgramProposal,
): Promise<Record<string, unknown>> {
	try {
		await deps.requestApproval(proposal);
	} catch (err) {
		log.error("program approval post failed — proposal stays pending", err, {
			proposal: proposal.id,
		});
		return {
			proposal: proposalView(proposal),
			error: `proposal #${proposal.id} is staged but its approval message could not be posted — nothing is active. Run program/review with id ${proposal.id} to re-send it.`,
		};
	}
	return {
		proposal: proposalView(proposal),
		status: "pending operator approval — nothing is active until they approve it",
	};
}

function isProgramRuleError(err: unknown): err is ProgramRuleError {
	return err instanceof ProgramRuleError;
}

function mintHook(deps: ProgramToolDeps): { token: string; url: string } | { error: string } {
	const base = deps.publicUrl();
	if (base === undefined) {
		return { error: "publicUrl is not set — set it in the mini app first" };
	}
	const token = newHookToken();
	return { token, url: hookUrl(base, token) };
}

async function sendHookUrl(
	deps: ProgramToolDeps,
	program: Program,
	url: string,
): Promise<string | null> {
	try {
		await deps.sendPrivate(
			`Webhook for program ${program.name}: ${url}\nKeep it secret; rotate via goblin if it leaks.`,
		);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
