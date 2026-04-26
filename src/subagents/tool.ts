/**
 * `spawn_subagent` tool definition for pi's custom tool API.
 *
 * Lets goblin (or a subagent) delegate work to a subagent. The tool
 * blocks until the subagent completes and returns its final response.
 *
 * The tool closes over a `SubagentRunner` instance injected at wiring time
 * (phase 9). Subagents receive this tool too, enabling recursive spawning
 * up to the depth cap (3).
 */

import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { SubagentRunner } from "./mod.ts";

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

const DESCRIPTION = `Spawn a subagent to perform a focused task. The subagent runs to completion and its final response is returned.

Subagents are sandboxed: they have no access to Telegram and run with standard tools (read, bash, edit, write, grep, find, ls). They can spawn their own subagents, up to depth 3.

Use named agents for specialist work (e.g. 'researcher' for deep investigation). Use generic subagents (no name) for ad-hoc tasks that benefit from the parent's project context.`;

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
): ToolDefinition {
  return defineTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: spawnSubagentSchema,
    async execute(
      _toolCallId: string,
      params: SpawnSubagentInput,
    ) {
      const handle = await runner.spawn({
        prompt: params.prompt,
        name: params.name,
        depth,
        spawnedBy: sessionId,
        onStatusUpdate,
      });

      // Block until the subagent finishes. Errors propagate as tool errors
      // that the LLM can read and decide how to handle.
      const result = await handle.result;

      return {
        content: [{ type: "text" as const, text: result }],
        details: { subagentId: handle.id },
      };
    },
  });
}
