// The schedule tool — standing jobs on a cron (DESIGN.md, "Scheduled
// work"). Management is state mutation: zod-validated actions against
// the jobs store, every action logged. The creating conversation is
// bound by the runtime (the model never handles chat ids); replies to
// a fired job land in that same chat/topic.

import { tool } from "ai";
import { z } from "zod";
import { log } from "../../log.ts";
import { nextFire, type Job, type JobsStore } from "../../jobs.ts";

function jobView(job: Job): Record<string, unknown> {
	return {
		id: job.id,
		name: job.name,
		cron: job.cron,
		prompt: job.prompt,
		chat_id: job.chatId,
		...(job.threadId !== null ? { thread_id: job.threadId } : {}),
		enabled: job.enabled,
		last_run: job.lastRun,
		next_run: job.nextRun,
	};
}

export interface ScheduleToolDeps {
	jobs: JobsStore;
	/** The conversation this tool call runs in — pinned onto new jobs. */
	chatId: number;
	threadId: number | null;
}

export const scheduleTool = (deps: ScheduleToolDeps) =>
	tool({
		description:
			"Manage standing scheduled jobs. A job is a natural-language prompt that fires as a normal turn in this chat on a 5-field cron (minute hour day month weekday, server local time). Translate the operator's wording into cron yourself (e.g. \"weekdays 8:30\" → \"30 8 * * 1-5\") and confirm the cron with them if ambiguous. Creating a job needs their explicit ask.",
		inputSchema: z.discriminatedUnion("action", [
			z.object({ action: z.literal("list") }),
			z.object({
				action: z.literal("create"),
				name: z.string().min(1).max(100),
				cron: z.string().min(5),
				prompt: z.string().min(1),
			}),
			z.object({
				action: z.literal("update"),
				id: z.number().int().positive(),
				name: z.string().min(1).max(100).optional(),
				cron: z.string().min(5).optional(),
				prompt: z.string().min(1).optional(),
			}),
			z.object({ action: z.literal("delete"), id: z.number().int().positive() }),
			z.object({ action: z.literal("toggle"), id: z.number().int().positive() }),
		]),
		execute: async (input) => {
			switch (input.action) {
				case "list":
					return { jobs: deps.jobs.list().map(jobView) };
				case "create": {
					// Validate before the row exists — a bad cron is a tool
					// error, not a stored surprise.
					try {
						nextFire(input.cron, new Date());
					} catch (err) {
						return { error: (err as Error).message };
					}
					const job = deps.jobs.create(
						{
							name: input.name,
							cron: input.cron,
							prompt: input.prompt,
							address: { chatId: deps.chatId, threadId: deps.threadId },
						},
					);
					log.info("job created", {
						job: job.id,
						name: job.name,
						cron: job.cron,
						conversation: `${deps.chatId}/${deps.threadId ?? "-"}`,
					});
					return { job: jobView(job) };
				}
				case "update": {
					// exactOptionalPropertyTypes: never pass an explicit undefined.
					const patch: { name?: string; cron?: string; prompt?: string } = {};
					if (input.name !== undefined) patch.name = input.name;
					if (input.cron !== undefined) patch.cron = input.cron;
					if (input.prompt !== undefined) patch.prompt = input.prompt;
					try {
						const job = deps.jobs.update(input.id, patch);
						if (job === null) return { error: `no job ${input.id}` };
						log.info("job updated", { job: job.id, name: job.name });
						return { job: jobView(job) };
					} catch (err) {
						return { error: (err as Error).message };
					}
				}
				case "delete": {
					const ok = deps.jobs.remove(input.id);
					log.info("job deleted", { job: input.id, existed: ok });
					return ok ? { deleted: input.id } : { error: `no job ${input.id}` };
				}
				case "toggle": {
					const current = deps.jobs.get(input.id);
					if (current === null) return { error: `no job ${input.id}` };
					const job = deps.jobs.update(input.id, { enabled: !current.enabled })!;
					log.info("job toggled", { job: job.id, enabled: job.enabled });
					return { job: jobView(job) };
				}
			}
		},
	});
