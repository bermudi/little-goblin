import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
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

export interface ProgramToolDeps {
	programs: ProgramsStore;
	/** The conversation this tool call runs in — pinned onto new
	 *  programs. Absent on app turns, where `project` carries the
	 *  responsibility destination instead. */
	chatId?: number;
	threadId?: number | null;
	/** The app/project arm — a create may bind a program to a
	 *  responsibility in this project (validated to belong to it).
	 *  Absent = creates pin the Telegram address as before. */
	project?: {
		projectId: string;
		resps: { get(id: string): { projectId: string } | null };
	};
	publicUrl(): string | undefined;
	sendPrivate(text: string): Promise<void>;
}

function newHookToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

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

export function hookTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

const listSchema = z.object({ action: z.literal("list") });
const createSchema = z.object({
	action: z.literal("create"),
	name: z.string().min(1).max(100),
	charter: z.string().min(1),
	cron: z.string().min(5).optional(),
	maxLatenessMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	hook: z.boolean().optional(),
	mailFilter: z.string().min(1).max(500).optional(),
	/** Project turns only: bind the program to a responsibility's
	 *  coordination lane instead of a Telegram address. */
	responsibilityId: z.string().min(1).optional(),
});
const updateSchema = z.object({
	action: z.literal("update"),
	id: z.number().int().positive(),
	name: z.string().min(1).max(100).optional(),
	charter: z.string().min(1).optional(),
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
const actionSchema = z.discriminatedUnion("action", [
	listSchema,
	createSchema,
	updateSchema,
	deleteSchema,
	toggleSchema,
	hookSchema,
]);

export const programInputSchema = z
	.object({
		action: z.enum(["list", "create", "update", "delete", "toggle", "hook"]),
		name: createSchema.shape.name.optional(),
		charter: createSchema.shape.charter.optional(),
		cron: updateSchema.shape.cron,
		maxLatenessMinutes: updateSchema.shape.maxLatenessMinutes,
		hook: createSchema.shape.hook,
		mailFilter: updateSchema.shape.mailFilter,
		responsibilityId: createSchema.shape.responsibilityId,
		id: updateSchema.shape.id.optional(),
		op: hookSchema.shape.op.optional(),
	})
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
			"Manage programs — a program is standing authority for one concern. Its charter says what it owns: scope, what needs the operator's OK, when to escalate, what not to do, and the steps — write that, not a one-line instruction. A cron is 5 fields (minute hour day month weekday) in server local time; translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. Optional maxLatenessMinutes limits how late a scheduled fire may run; omitted means unlimited (fire once on wake). On update, null clears the limit. A late catch-up coalesces missed occurrences into at most one fire based on the latest missed occurrence. The 'hook' action gives a program a secret URL that external services POST to wake it — the URL is sent to the operator privately and never appears to you. A mail filter (Gmail query syntax, e.g. from:bank is:important) wakes the program when new matching mail arrives. Creating a program or widening its authority needs the operator's explicit ask — you may propose one, never grant yourself one. Rewording, rescheduling, or toggling within the charter's intent needs no go-ahead.",
		inputSchema: programInputSchema,
		execute: async (raw) => {
			const input = actionSchema.parse(raw);
			switch (input.action) {
				case "list":
					return { programs: deps.programs.list().map(programView) };
				case "create": {
					if (input.cron !== undefined) {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					// Destination union at the tool surface: a
					// responsibility_id binds the project's coordination
					// lane — validated to belong to this project. The
					// hook URL rides the operator DM, which doesn't exist
					// on app turns — refuse minting there.
					const destination =
						input.responsibilityId !== undefined
							? (() => {
									if (deps.project === undefined) {
										return { error: "responsibility destinations exist only on project turns" };
									}
									const resp = deps.project.resps.get(input.responsibilityId);
									if (resp === null || resp.projectId !== deps.project.projectId) {
										return { error: "no such responsibility in this project" };
									}
									return { responsibilityId: input.responsibilityId };
								})()
							: deps.chatId !== undefined
								? { address: { chatId: deps.chatId, threadId: deps.threadId ?? null } }
								: { error: "no destination — Telegram pin and project arm are both absent" };
					if ("error" in destination) return { error: destination.error };
					if (input.hook === true && "responsibilityId" in destination) {
						return { error: "hook URLs deliver to the operator DM — not available on project turns" };
					}
					const minted = input.hook === true ? mintHook(deps) : null;
					if (minted !== null && "error" in minted) return { error: minted.error };
					try {
						const program = deps.programs.create({
							name: input.name,
							charter: input.charter,
							...(input.cron !== undefined ? { cron: input.cron } : {}),
							...(input.maxLatenessMinutes !== undefined
								? { maxLatenessMinutes: input.maxLatenessMinutes }
								: {}),
							...(minted !== null ? { hookHash: hookTokenHash(minted.token) } : {}),
							...(input.mailFilter !== undefined ? { mailFilter: input.mailFilter } : {}),
							...destination,
						});
						log.info("program created", {
							program: program.id,
							name: program.name,
							cron: program.cron,
							maxLatenessMinutes: program.maxLatenessMinutes,
							hook: program.hookHash !== null,
							mail: program.mailFilter !== null,
							destination:
								"responsibilityId" in destination
									? `responsibility:${destination.responsibilityId}`
									: `${deps.chatId}/${deps.threadId ?? "-"}`,
						});
						if (minted !== null) {
							const err = await sendHookUrl(deps, program, minted.url);
							if (err !== null) {
								return {
									program: programView(program),
									error: `hook is set but the URL delivery failed: ${err} — run hook/rotate to resend`,
								};
							}
							return { program: programView(program), hook: "enabled", url_sent: true };
						}
						return { program: programView(program) };
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
					const minted = mintHook(deps);
					if ("error" in minted) return { error: minted.error };
					deps.programs.setHook(input.id, hookTokenHash(minted.token));
					const op = input.op === "rotate" ? "rotated" : "enabled";
					const err = await sendHookUrl(deps, current, minted.url);
					if (err !== null) {
						return {
							error: `hook ${op} but the URL delivery failed: ${err} — run hook/rotate to resend`,
						};
					}
					log.info(`program hook ${op}`, { program: input.id, name: current.name });
					return { hook: op, url_sent: true };
				}
			}
		},
	});

function isProgramRuleError(err: unknown): err is ProgramRuleError {
	return err instanceof ProgramRuleError;
}

function mintHook(deps: ProgramToolDeps): { token: string; url: string } | { error: string } {
	const base = deps.publicUrl();
	if (base === undefined) {
		return { error: "publicUrl is not set — set it in the mini app first" };
	}
	const token = newHookToken();
	return { token, url: `${base.replace(/\/+$/, "")}/hook/${token}` };
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
