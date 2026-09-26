// The program tool — standing orders (DESIGN.md, "Programs"). A
// program is standing authority for one concern: a charter plus the
// triggers that wake it. Management is state mutation: zod-validated
// actions against the programs store, every action logged. The
// creating conversation is bound by the runtime (the model never
// handles chat ids); replies to a fired program land in that same
// chat/topic.

import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { nextFire, type Program, type ProgramsStore } from "../../programs.ts";

function programView(program: Program): Record<string, unknown> {
	return {
		id: program.id,
		name: program.name,
		charter: program.charter,
		cron: program.cron,
		enabled: program.enabled,
		last_run: program.lastRun,
		next_run: program.nextRun,
	};
}

export interface ProgramToolDeps {
	programs: ProgramsStore;
	/** The conversation this tool call runs in — pinned onto new programs. */
	chatId: number;
	threadId: number | null;
}

export const programTool = (deps: ProgramToolDeps) =>
	tool({
		description:
			"Manage programs — a program is standing authority for one concern. Its charter says what it owns: scope, what needs the operator's OK, when to escalate, what not to do, and the steps — write that, not a one-line instruction. A cron is 5 fields (minute hour day month weekday) in server local time; translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. Creating a program or widening its authority needs the operator's explicit ask — you may propose one, never grant yourself one. Rewording, rescheduling, or toggling within the charter's intent needs no go-ahead.",
		inputSchema: z.discriminatedUnion("action", [
			z.object({ action: z.literal("list") }),
			z.object({
				action: z.literal("create"),
				name: z.string().min(1).max(100),
				charter: z.string().min(1),
				cron: z.string().min(5),
			}),
			z.object({
				action: z.literal("update"),
				id: z.number().int().positive(),
				name: z.string().min(1).max(100).optional(),
				charter: z.string().min(1).optional(),
				cron: z.string().min(5).optional(),
			}),
			z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
			z.object({ action: z.literal("toggle"), id: z.number().int().positive() }),
		]),
		execute: async (input) => {
			switch (input.action) {
				case "list":
					return { programs: deps.programs.list().map(programView) };
				case "create": {
					// Validate before the row exists — a bad cron is a tool
					// error, not a stored surprise.
					try {
						nextFire(input.cron, new Date());
					} catch (err) {
						return { error: (err as Error).message };
					}
					const program = deps.programs.create(
						{
							name: input.name,
							charter: input.charter,
							cron: input.cron,
							address: { chatId: deps.chatId, threadId: deps.threadId },
						},
					);
					log.info("program created", {
						program: program.id,
						name: program.name,
						cron: program.cron,
						conversation: `${deps.chatId}/${deps.threadId ?? "-"}`,
					});
					return { program: programView(program) };
				}
				case "update": {
					if (input.cron !== undefined) {
						try {
							nextFire(input.cron, new Date());
						} catch (err) {
							return { error: (err as Error).message };
						}
					}
					// exactOptionalPropertyTypes: never pass an explicit undefined.
					const patch: { name?: string; charter?: string; cron?: string } = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.charter !== undefined) patch.charter = input.charter;
					if (input.cron !== undefined) patch.cron = input.cron;
					const program = deps.programs.update(input.id, patch);
					if (program === null) return { error: `no program ${input.id}` };
					log.info("program updated", { program: program.id, name: program.name });
					return { program: programView(program) };
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
			}
		},
	});
