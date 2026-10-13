// The subagent tool (design/subagents.md): Goblin's handle on the
// managed run queue — start returns a durable #id immediately and the
// result arrives later as a wake, so the conversation never waits or
// polls. Run-originated text (task, result, question, error) is
// untrusted data and every path that returns it fences it through the
// frozen subagentNotice wrapper. Ownership is the origin conversation
// id bound at construction — status/send/stop can never see another
// conversation's run, and holder ids are never taken from the model.

import { tool } from "ai";
import { z } from "zod";
import {
	MAX_INPUT_FILES,
	MAX_MESSAGE_CHARS,
	MAX_TASK_CHARS,
	type SubagentRun,
} from "../../subagent-runs.ts";
import { subagentNotice, SUBAGENT_TOOL_DESCRIPTION } from "../../subagent-prompts.ts";
import { SubagentError, type Subagents } from "../../subagents.ts";

// The same rule desktops.ts enforces — the tool refuses a bad name
// before it reaches the pool.
const desktopNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "desktop names are [a-z0-9-], 1-31 chars");

export interface SubagentToolDeps {
	/** The conversation this call runs in — the origin of every run it
	 *  can see or start. */
	conversation: string;
	workspace: string;
	subagents: Subagents;
	/** worker runs need a configured sandbox — absent, start(kind:
	 *  "worker") refuses with an operator-actionable error. */
	workerEnabled: boolean;
	computerEnabled: boolean;
}

const startSchema = z.object({
	action: z.literal("start"),
	kind: z.enum(["worker", "computer"]),
	task: z.string().min(1).max(MAX_TASK_CHARS),
	files: z.array(z.string().min(1)).max(MAX_INPUT_FILES).optional(),
	desktop: desktopNameSchema.optional(),
});
const listSchema = z.object({ action: z.literal("list") });
const statusSchema = z.object({
	action: z.literal("status"),
	id: z.number().int().positive(),
});
const sendSchema = z.object({
	action: z.literal("send"),
	id: z.number().int().positive(),
	message: z.string().min(1).max(MAX_MESSAGE_CHARS),
});
const stopSchema = z.object({
	action: z.literal("stop"),
	id: z.number().int().positive(),
});

const actionSchema = z.discriminatedUnion("action", [
	startSchema,
	listSchema,
	statusSchema,
	sendSchema,
	stopSchema,
]);

export const subagentInputSchema = z
	.object({
		action: z.enum(["start", "list", "status", "send", "stop"]),
		kind: startSchema.shape.kind.optional(),
		task: startSchema.shape.task.optional(),
		files: startSchema.shape.files,
		desktop: startSchema.shape.desktop,
		id: statusSchema.shape.id.optional(),
		message: sendSchema.shape.message.optional(),
	})
	.superRefine((value, ctx) => {
		const result = actionSchema.safeParse(value);
		if (!result.success)
			for (const issue of result.error.issues) {
				ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
			}
	});

// Trusted fields stay structural; everything the run produced rides
// inside the frozen <event> fence with the untrusted note.
function runSummary(row: SubagentRun) {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		desktop: row.desktop ?? undefined,
		files: row.files.length > 0 ? row.files : undefined,
		inbox: row.inbox.length > 0 ? row.inbox : undefined,
		final_screenshot: row.finalScreenshot ?? undefined,
		created_at: new Date(row.createdAt).toISOString(),
		finished_at: row.finishedAt === null ? undefined : new Date(row.finishedAt).toISOString(),
	};
}

function runBody(row: SubagentRun): string {
	const parts = [`task: ${row.task}`];
	if (row.question !== null) parts.push(`question: ${row.question}`);
	if (row.result !== null) parts.push(`result: ${row.result}`);
	if (row.error !== null) parts.push(`error: ${row.error}`);
	if (row.exportedFiles.length > 0)
		parts.push(`exported_files: ${JSON.stringify(row.exportedFiles)}`);
	if (row.exportErrors.length > 0) parts.push(`export_errors: ${JSON.stringify(row.exportErrors)}`);
	return parts.join("\n");
}

function fenced(row: SubagentRun): string {
	return subagentNotice(row.id, row.kind, row.status, runBody(row));
}

export const subagentTool = (deps: SubagentToolDeps) =>
	tool({
		description: SUBAGENT_TOOL_DESCRIPTION,
		inputSchema: subagentInputSchema,
		execute: async (raw, { toolCallId }) => {
			const parsed = actionSchema.safeParse(raw);
			if (!parsed.success) {
				return {
					error: `invalid subagent call: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
				};
			}
			const input = parsed.data;
			try {
				switch (input.action) {
					case "start": {
						if (input.kind === "worker" && !deps.workerEnabled) {
							return {
								error:
									"worker subagents need a configured sandbox — set the sandbox block in goblin.json5 (design/sandbox.md) or ask the operator to",
							};
						}
						if (input.kind === "computer" && !deps.computerEnabled) {
							return {
								error:
									"computer subagents are not configured — set subagents.computer in goblin.json5 or ask the operator to",
							};
						}
						if (input.kind === "computer" && input.desktop === undefined) {
							return { error: "computer runs need a desktop name (the desktop tool lists them)" };
						}
						// The toolCallId is the idempotence key: a retried call
						// returns the same row instead of starting a second run.
						const row = await deps.subagents.start(
							{
								kind: input.kind,
								conversationId: deps.conversation,
								workspace: deps.workspace,
								task: input.task,
								...(input.desktop !== undefined ? { desktop: input.desktop } : {}),
								...(input.files !== undefined ? { files: input.files } : {}),
							},
							`subagent-tool:${toolCallId}`,
						);
						return { ...runSummary(row), notice: fenced(row) };
					}
					case "list": {
						const rows = deps.subagents.list(deps.conversation);
						return {
							runs: rows.map(runSummary),
							...(rows.length > 0
								? { notices: rows.map(fenced) }
								: {}),
						};
					}
					case "status": {
						const row = deps.subagents.status(input.id, deps.conversation);
						if (row === null) {
							return { error: `no subagent run #${input.id} in this conversation` };
						}
						return { ...runSummary(row), notice: fenced(row) };
					}
					case "send": {
						const row = await deps.subagents.send(
							input.id,
							deps.conversation,
							input.message,
						);
						return { ...runSummary(row), notice: fenced(row) };
					}
					case "stop": {
						const row = await deps.subagents.stop(input.id, deps.conversation);
						return { ...runSummary(row), notice: fenced(row) };
					}
				}
			} catch (err) {
				if (err instanceof SubagentError) {
					return { error: err.message };
				}
				throw err;
			}
		},
	});
