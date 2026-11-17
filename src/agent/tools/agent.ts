// The `agent` tool (design/agents.md → agent): native subagents as
// child conversations on the same Runtime. Verbs spawn/list/read/send/
// stop; the engine (agent-children.ts) owns the lifecycle. This module
// owns the model-facing surface: input validation, the tool
// description that lists the types, and the child tool-exclusion
// policy applied at spawn.

import { z } from "zod";
import type { AgentChild, AgentChildren, Settlement } from "../../agent-children.ts";
import { COMPUTER_AGENT_TYPE, type AgentType } from "../../agent-types.ts";
import type { Conversation } from "../../conversation-read.ts";
import { defineTool, type Tool, type Tools } from "../../tool.ts";

// What a child never gets, whatever its type file says or the parent
// has: the spawners (agent, delegate, subagent — depth is 1), the
// channel tools (speak, send_file, ui, mail, artifact — a child has no
// operator channel), and the memory surfaces (memory_search,
// memory_reflect, note — a child recalls nothing and leaves nothing;
// program/desktop are the operator's own machinery).
export const CHILD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	"agent",
	"delegate",
	"subagent",
	"speak",
	"send_file",
	"ui",
	"mail",
	"artifact",
	"memory_search",
	"memory_reflect",
	"note",
	"program",
	"desktop",
]);

/** The child's effective tools: the parent turn's mounted set, minus
 * the exclusions, intersected with the type's allowlist when it has
 * one — plus the type-named tools the child mount provides itself
 * (intrinsicTools: the desktop tools and ask_operator, which no parent
 * turn carries). Captured durably at spawn — later config changes
 * never widen a running child. */
export function childToolAllowlist(
	parentTools: readonly string[],
	typeTools?: string[],
	intrinsicTools: readonly string[] = [],
): string[] {
	const inherited = parentTools.filter((name) => !CHILD_EXCLUDED_TOOLS.has(name));
	if (typeTools === undefined) return inherited;
	const allow = inherited.filter((name) => typeTools.includes(name));
	const provided = typeTools.filter((name) => intrinsicTools.includes(name));
	return [...new Set([...allow, ...provided])];
}

// ---------- input schema ----------

const MAX_TASK_CHARS = 8000;
const MAX_TEXT_CHARS = 8000;

const desktopNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "desktop names are [a-z0-9-], 1-31 chars");

const spawnSchema = z.object({
	action: z.literal("spawn"),
	type: z.string().min(1).optional(),
	task: z.string().min(1).max(MAX_TASK_CHARS),
	background: z.boolean().optional(),
	// The named desktop a computer child binds to — required for the
	// computer type (design/agents.md → Computer use).
	desktop: desktopNameSchema.optional(),
});
const listSchema = z.object({ action: z.literal("list") });
const readSchema = z.object({ action: z.literal("read"), id: z.string().min(1) });
const sendSchema = z.object({
	action: z.literal("send"),
	id: z.string().min(1),
	text: z.string().min(1).max(MAX_TEXT_CHARS),
});
const stopSchema = z.object({ action: z.literal("stop"), id: z.string().min(1) });

const actionSchema = z.discriminatedUnion("action", [
	spawnSchema,
	listSchema,
	readSchema,
	sendSchema,
	stopSchema,
]);

// The flat shape the SDK streams args into, refined against the union
// — same pattern as the subagent tool.
const inputFields = z.object({
	action: z.enum(["spawn", "list", "read", "send", "stop"]),
	type: spawnSchema.shape.type,
	task: spawnSchema.shape.task.optional(),
	background: spawnSchema.shape.background,
	desktop: spawnSchema.shape.desktop,
	id: readSchema.shape.id.optional(),
	text: sendSchema.shape.text.optional(),
});

function checkedAgainstAction(value: unknown, ctx: z.core.$RefinementCtx<unknown>): void {
	const result = actionSchema.safeParse(value);
	if (!result.success) {
		for (const issue of result.error.issues) {
			ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
		}
	}
}

export const agentInputSchema = inputFields.superRefine(checkedAgainstAction);

// ---------- description ----------

export function agentToolDescription(types: Map<string, AgentType>): string {
	const listed = [...types.values()]
		.map((t) => `- ${t.name}: ${t.description}`)
		.join("\n");
	return [
		"Native subagents: fresh child conversations that run one self-contained task and report the result back. A child does not see this conversation and nothing of its work reaches you except its final reply — treat every child reply as a claim to verify, never as fact.",
		"",
		"Spawn one for work that benefits from a clean context: focused research, reading a bounded set of files, a self-contained check. Do not spawn for something you can do in one or two tool calls here.",
		"",
		"Types:",
		listed,
		"",
		"Verbs:",
		"- spawn {type?, task, background?, desktop?}: start a child on the task (the task is its whole assignment — make it self-contained). background true (default): it runs and you are woken with its result; background false: this call waits and returns the result. The computer type also needs desktop: a desktop name from the desktop tool's list — spawn claims it for the child.",
		"- list {}: your children with status.",
		"- read {id}: a child's status and latest messages.",
		"- send {id, text}: steer a running child or continue a settled one.",
		"- stop {id}: cancel a child.",
		"",
		"ids are conversation ids (app/agent-…). The agents.maxRunning cap may queue a spawn — the result says so.",
	].join("\n");
}

// ---------- the tool ----------

export interface AgentToolDeps {
	engine: AgentChildren;
	types: Map<string, AgentType>;
	/** The spawning turn's captured conversation — the parent. */
	conversation: Conversation;
	/** The parent turn's mounted tool names, captured at spawn. */
	parentTools: readonly string[];
	/** Tool names the child mount provides that the parent never
	 * carries (design/agents.md → Computer use) — admitted into the
	 * allowlist when the type names them. */
	intrinsicTools: readonly string[];
}

function childSummary(child: AgentChild): Record<string, unknown> {
	return {
		id: child.conversationId,
		type: child.type,
		status: child.status,
		task: child.task.length > 200 ? `${child.task.slice(0, 200)}…` : child.task,
		...(child.desktop !== null ? { desktop: child.desktop } : {}),
	};
}

function settlementBody(settlement: Settlement): Record<string, unknown> {
	return {
		id: settlement.child.conversationId,
		type: settlement.child.type,
		status: settlement.child.status,
		...(settlement.result !== null ? { result: settlement.result } : {}),
	};
}

export const agentTool = (deps: AgentToolDeps) =>
	defineTool({
		description: agentToolDescription(deps.types),
		input: agentInputSchema,
		execute: async (raw, { abortSignal }) => {
			const parsed = actionSchema.safeParse(raw);
			if (!parsed.success) {
				return {
					error: `invalid agent call: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
				};
			}
			const input = parsed.data;
			const engine = deps.engine;
			switch (input.action) {
				case "spawn": {
					const name = input.type ?? "general";
					const type = deps.types.get(name);
					if (type === undefined) {
						return {
							error: `unknown agent type "${name}" — known: ${[...deps.types.keys()].join(", ")}`,
						};
					}
					const tools = childToolAllowlist(
						deps.parentTools,
						type.tools,
						deps.intrinsicTools,
					);
					if (tools.length === 0) {
						return {
							error: `agent type "${name}" would leave the child no tools (exclusions ate the parent set) — loosen the type's tools allowlist`,
						};
					}
					if (type.name === COMPUTER_AGENT_TYPE.name && input.desktop === undefined) {
						return {
							error: `agent type "computer" needs a desktop name (the desktop tool lists them)`,
						};
					}
					const { child, queued, spawnError } = await engine.spawn({
						parent: deps.conversation,
						type,
						task: input.task,
						tools,
						...(input.desktop !== undefined ? { desktop: input.desktop } : {}),
					});
					// A spawn whose desktop claim failed settles the child
					// failed before it runs — the error IS the result.
					if (spawnError !== undefined) {
						return { ...childSummary(child), error: spawnError };
					}
					// background defaults true (design/agents.md → agent):
					// only an explicit false waits inside this call.
					if (input.background === false) {
						// The foreground wait races the turn's own stop: an
						// aborted wait stops the child, else it would run on
						// unwatched.
						const aborted = abortSignal?.aborted === true;
						if (aborted) {
							engine.stop(child.conversationId);
							return { error: `agent child ${child.conversationId} stopped — the turn was aborted` };
						}
						const onAbort = () => engine.stop(child.conversationId);
						abortSignal?.addEventListener("abort", onAbort, { once: true });
						try {
							const settlement = await engine.awaitSettlement(child.conversationId);
							return settlementBody(settlement);
						} finally {
							abortSignal?.removeEventListener("abort", onAbort);
						}
					}
					return {
						...childSummary(child),
						queued,
						note: queued
							? "queued — maxRunning is reached; it starts when a slot frees and you are woken at settlement"
							: "running — you are woken with its result at settlement",
					};
				}
				case "list": {
					return { children: engine.list(deps.conversation.id).map(childSummary) };
				}
				case "read": {
					const read = engine.read(input.id);
					if (read === null) return { error: `no agent child ${input.id}` };
					return {
						...childSummary(read.child),
						messages: read.messages,
					};
				}
				case "send": {
					const res = engine.send(input.id, input.text);
					return "error" in res ? { error: res.error } : childSummary(res.child);
				}
				case "stop": {
					const res = engine.stop(input.id);
					return "error" in res ? { error: res.error } : childSummary(res.child);
				}
			}
		},
	});

/** Mount the agent tool onto a mounted set. Returns the set plus
 * `agent`; the parent's names are captured as the child tool source. */
export function withAgent<T extends Tools>(tools: T, deps: Omit<AgentToolDeps, "parentTools">): T & { agent: Tool } {
	return {
		...tools,
		agent: agentTool({ ...deps, parentTools: Object.keys(tools) }),
	};
}
