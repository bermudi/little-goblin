import { z } from "zod";
import { defineTool } from "../../tool.ts";
import { log } from "../../log.ts";
import type { PrSnapshot, Watches, WatchTarget } from "../../watches.ts";
import { threadCursor } from "../../watch-observer.ts";
import type { T3ShowResult } from "../../t3.ts";

const schema = z.object({
	action: z.enum(["add", "list", "cancel"]),
	thread: z.string().min(1).optional(),
	pr: z.object({ repository: z.string().min(1), number: z.number().int().positive() }).strict().optional(),
	at: z.string().datetime({ offset: true }).optional(),
	reason: z.string().min(1).max(500).optional(),
	id: z.number().int().positive().optional(),
}).strict().superRefine((input, ctx) => {
	if (input.action === "add") {
		const count = Number(input.thread !== undefined) + Number(input.pr !== undefined) + Number(input.at !== undefined);
		if (count !== 1) ctx.addIssue({ code: "custom", message: "add needs exactly one target: thread, pr, or at" });
		if (input.reason === undefined) ctx.addIssue({ code: "custom", path: ["reason"], message: "add needs a reason" });
	} else if (input.action === "cancel" && input.id === undefined) {
		ctx.addIssue({ code: "custom", path: ["id"], message: "cancel needs an id" });
	}
});

export interface WatchToolDeps {
	watches: Watches;
	conversationId: string;
	showThread(thread: string, messages: number): Promise<T3ShowResult | null>;
	readPr(repository: string, number: number): Promise<PrSnapshot>;
	now(): Date;
}

export function watchTool(deps: WatchToolDeps) {
	return defineTool({
		description: "Wake this conversation once when something outside changes: a T3 Code thread (when its current run ends, it waits for input, or it is gone), a GitHub PR (when it merges or closes, or its checks finish with a different result), or a time. Each watch fires once, then ends; add another to keep following. The wake arrives as a [watch #id fired] message with your reason and what changed. Read the details yourself (t3 thread show, gh pr view). Actions — add {thread | pr {repository, number} | at, reason}; list {}; cancel {id}.",
		input: schema,
		execute: async (input) => {
			const parsed = schema.parse(input);
			if (parsed.action === "list") return { watches: deps.watches.forConversation(deps.conversationId) };
			if (parsed.action === "cancel") {
				const cancelled = deps.watches.cancel(parsed.id!, deps.conversationId);
				return cancelled ? { cancelled: parsed.id } : { error: "active watch not found in this conversation" };
			}
			let target: WatchTarget;
			let baseline: unknown;
			try {
				if (parsed.thread !== undefined) {
					const show = await deps.showThread(parsed.thread, 1);
					if (show === null) return { error: `T3 thread ${parsed.thread} is gone` };
					target = { kind: "thread", thread: parsed.thread };
					baseline = threadCursor(show);
				} else if (parsed.pr !== undefined) {
					target = { kind: "pr", ...parsed.pr };
					baseline = await deps.readPr(parsed.pr.repository, parsed.pr.number);
				} else {
					const at = parsed.at!;
					const ms = Date.parse(at);
					if (ms <= deps.now().getTime()) return { error: "watch time must be in the future" };
					if (ms > deps.now().getTime() + 90 * 24 * 60 * 60 * 1000) return { error: "watch time must be within 90 days" };
					target = { kind: "time", at: new Date(ms).toISOString() };
					baseline = { at: target.at };
				}
			} catch (err) {
				log.warn("watch add baseline unavailable", err, { conversation: deps.conversationId });
				return { error: err instanceof Error ? err.message : String(err) };
			}
			const watch = deps.watches.add({
				conversationId: deps.conversationId,
				target,
				reason: parsed.reason!,
				baseline,
			});
			return { id: watch.id, target: watch.target, baseline: watch.baseline };
		},
	});
}
