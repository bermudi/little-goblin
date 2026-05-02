/**
 * `spawn_subagent` and `revive_subagent` tool definitions for pi's custom tool API.
 *
 * Lets goblin (or a subagent) delegate work to a subagent. The tools
 * block until the subagent completes and return its final response.
 *
 * The tools close over a `SubagentRunner` instance injected at wiring time
 * (phase 9). Subagents receive these tools too, enabling recursive spawning
 * up to the depth cap (3).
 */

import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ActiveScope } from "../memory/mod.ts";
import type { SubagentRunner } from "./mod.ts";
import { listNamedAgents } from "./paths.ts";

/** Default timeout for subagent execution (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Create a promise that rejects after `ms` milliseconds, cancelling the
 * subagent and returning a timeout error to the LLM.
 */
function timeoutReject(
  ms: number,
  subagentId: string,
  runner: SubagentRunner,
): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(async () => {
      try {
        await runner.cancel(subagentId);
      } catch {
        // Already completed/errored — ignore.
      }
      reject(new Error(`Subagent ${subagentId} timed out after ${ms}ms`));
    }, ms);
  });
}

const spawnSubagentSchema = Type.Object({
  prompt: Type.String({
    description: "The task prompt for the subagent.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Named agent to spawn (e.g. 'researcher'). Loads AGENTS.md and isolated skills from ~/goblin/agents/<name>/. Omit for a generic subagent that inherits parent skills.",
    }),
  ),
});

type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;

const BASE_DESCRIPTION = `Spawn a subagent to perform a focused task. The subagent runs to completion and its final response is returned.

Subagents are sandboxed: they have no access to Telegram and run with standard tools (read, bash, edit, write, memory). They can spawn their own subagents, up to depth 3.

Use named agents for specialist work. Use generic subagents (no name) for ad-hoc tasks that benefit from the parent's project context.`;

/** Build dynamic description listing available named agents. */
function buildDescription(home: string): string {
  const agents = listNamedAgents(home);
  const agentsList = agents.length > 0 ? `Available named agents: ${agents.join(", ")}.` : "No named agents configured.";
  return `${BASE_DESCRIPTION}\n\n${agentsList}`;
}

const PROMPT_SNIPPET = "spawn_subagent: delegate work to a subagent and get results.";

const PROMPT_GUIDELINES = [
  "Prefer spawning a subagent for self-contained tasks that don't need direct user interaction.",
  "For specialist work, use a named agent (e.g. spawn_subagent({name: 'researcher', prompt: '...'})).",
  "For ad-hoc tasks, omit the name to spawn a generic subagent that inherits your project context.",
];

/**
 * Create the `spawn_subagent` tool bound to a `SubagentRunner` instance.
 *
 * `depth` is the spawner's depth (goblin=0, subagent=1+). The tool passes
 * it through so the runner enforces the cap.
 */
export function createSpawnSubagentTool(
  runner: SubagentRunner,
  depth: number,
  sessionId: string,
  onStatusUpdate?: (message: string) => void,
  timeoutMs?: number,
  activeScope?: ActiveScope,
): ToolDefinition {
  return defineTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: buildDescription(runner.goblinHome),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: spawnSubagentSchema,
    async execute(
      _toolCallId: string,
      params: SpawnSubagentInput,
    ) {
      const handle = await runner.spawn({
        prompt: params.prompt,
        activeScope,
        name: params.name,
        depth,
        spawnedBy: sessionId,
        onStatusUpdate,
        timeoutMs,
      });

      // Block until the subagent finishes or the timeout fires.
      // Errors propagate as tool errors that the LLM can read and decide
      // how to handle.
      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await Promise.race([
        handle.result,
        timeoutReject(effectiveTimeout, handle.id, runner),
      ]);

      return {
        content: [{ type: "text" as const, text: result }],
        details: { subagentId: handle.id },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// revive_subagent tool
// ---------------------------------------------------------------------------

const reviveSubagentSchema = Type.Object({
  id: Type.String({
    description: "The ID of a previously completed, cancelled, or errored subagent to revive.",
  }),
  prompt: Type.String({
    description: "The follow-up prompt for the revived subagent.",
  }),
});

type ReviveSubagentInput = Static<typeof reviveSubagentSchema>;

const REVIVE_DESCRIPTION = `Resume a previously completed, cancelled, or errored subagent with a new prompt. The subagent retains its conversation history and runs to completion.

Use this when you need to follow up on work a subagent already did — e.g. asking for more detail, a different approach, or to retry after an error.`;

const REVIVE_PROMPT_SNIPPET = "revive_subagent: resume a subagent with a follow-up prompt.";

const REVIVE_PROMPT_GUIDELINES = [
  "Use revive_subagent when you want to continue a conversation with a subagent that already finished.",
  "You can also revive errored or cancelled subagents to retry or continue their work.",
  "The subagent's conversation history is preserved, so you can reference earlier context.",
];

/**
 * Create the `revive_subagent` tool bound to a `SubagentRunner` instance.
 */
export function createReviveSubagentTool(
  runner: SubagentRunner,
  onStatusUpdate?: (message: string) => void,
  timeoutMs?: number,
): ToolDefinition {
  return defineTool({
    name: "revive_subagent",
    label: "Revive Subagent",
    description: REVIVE_DESCRIPTION,
    promptSnippet: REVIVE_PROMPT_SNIPPET,
    promptGuidelines: REVIVE_PROMPT_GUIDELINES,
    parameters: reviveSubagentSchema,
    async execute(
      _toolCallId: string,
      params: ReviveSubagentInput,
    ) {
      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await Promise.race([
        runner.revive(params.id, params.prompt, onStatusUpdate),
        timeoutReject(effectiveTimeout, params.id, runner),
      ]);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { subagentId: params.id },
      };
    },
  });
}
