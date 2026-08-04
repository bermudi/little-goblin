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
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CapturedMemoryContext } from "../memory/mod.ts";
import type { DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import type { GenericSubagentInheritance, SubagentRunner } from "./mod.ts";
import { listNamedAgents } from "./paths.ts";

/** Default timeout for subagent execution (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function requireGenericInheritance(
  inheritance: GenericSubagentInheritance | null,
): GenericSubagentInheritance {
  if (inheritance === null) {
    throw new Error("Generic subagent spawn requires inherited execution and skill authority");
  }
  return inheritance;
}

/**
 * Await a blocking subagent result with a timeout. The timer is cleared when
 * the result wins; a timeout starts best-effort cancellation without delaying
 * the timeout error returned to the model.
 */
async function awaitSubagentResult(
  result: Promise<string>,
  ms: number,
  subagentId: string,
  runner: SubagentRunner,
  ownerConversationId?: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Subagent ${subagentId} timed out after ${ms}ms`));
      void runner.cancel(subagentId, ownerConversationId).catch(() => {
        // Already completed/errored — ignore.
      });
    }, ms);
  });
  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const spawnSubagentSchema = Type.Object({
  prompt: Type.String({
    description: "The task prompt for the subagent.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Named agent to spawn (e.g. 'researcher'). Loads AGENTS.md and isolated skills from ~/goblin/agents/<name>/. Omit to request a generic subagent when this runtime has inheritance authority.",
    }),
  ),
});

type SpawnSubagentInput = Static<typeof spawnSubagentSchema>;

const BASE_DESCRIPTION = `Spawn a subagent to perform a focused task. The subagent runs to completion and its final response is returned.

Subagents are sandboxed: they have no access to Telegram and run with standard tools (read, bash, edit, write, memory). They can spawn their own subagents, up to depth 3.`;

/** Build dynamic description listing available named agents and caller capability. */
function buildDescription(home: string, canSpawnGeneric: boolean): string {
  const agents = listNamedAgents(home);
  const agentsList = agents.length > 0 ? `Available named agents: ${agents.join(", ")}.` : "No named agents configured.";
  const generic = canSpawnGeneric
    ? "Use generic subagents (no name) for ad-hoc tasks; they inherit this runtime's execution environment and frozen skills."
    : "This named runtime has no generic inheritance manifest, so it can spawn named agents only.";
  return `${BASE_DESCRIPTION}\n\n${generic}\n\n${agentsList}`;
}

const PROMPT_SNIPPET = "spawn_subagent: delegate work to a subagent and get results.";

function promptGuidelines(canSpawnGeneric: boolean): string[] {
  const guidelines = [
    "Prefer spawning a subagent for self-contained tasks that don't need direct user interaction.",
    "For specialist work, use a named agent (e.g. spawn_subagent({name: 'researcher', prompt: '...'})).",
  ];
  if (canSpawnGeneric) {
    guidelines.push("For ad-hoc tasks, omit the name to spawn a generic subagent with your execution environment and skills.");
  }
  return guidelines;
}

/**
 * Create the `spawn_subagent` tool bound to a `SubagentRunner` instance.
 *
 * `depth` is the spawner's depth (goblin=0, subagent=1+). The tool passes
 * it through so the runner enforces the cap. `inheritance` is the spawner's
 * frozen execution environment and skill authority: generic spawns receive it
 * verbatim and named spawns ignore it. A named runtime passes `null`, so an
 * omitted `name` fails visibly instead of fabricating an empty manifest.
 */
export function createSpawnSubagentTool(
  runner: SubagentRunner,
  depth: number,
  sessionId: string,
  parentCapture: CapturedMemoryContext,
  inheritance: GenericSubagentInheritance | null,
  onStatusUpdate?: (message: string) => void,
  timeoutMs?: number,
  delegatedContext?: DelegatedRuntimeContext,
  parentSubagentId?: string,
): ToolDefinition {
  return defineTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description: buildDescription(runner.goblinHome, inheritance !== null),
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: promptGuidelines(inheritance !== null),
    parameters: spawnSubagentSchema,
    async execute(
      _toolCallId: string,
      params: SpawnSubagentInput,
    ) {
      const base = {
        prompt: params.prompt,
        authority: parentCapture.authority,
        depth,
        spawnedBy: delegatedContext !== undefined ? parentSubagentId : sessionId,
        delegatedContext,
        onStatusUpdate,
        timeoutMs,
      };
      const handle = params.name !== undefined
        ? await runner.spawn({ ...base, name: params.name })
        : await runner.spawn({ ...base, inheritance: requireGenericInheritance(inheritance) });

      // Block until the subagent finishes or the timeout fires.
      // Errors propagate as tool errors that the LLM can read and decide
      // how to handle.
      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await awaitSubagentResult(
        handle.result,
        effectiveTimeout,
        handle.id,
        runner,
        delegatedContext?.ownerConversationId,
      );
      runner.acknowledgeDelivery(handle.id);

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
 *
 * A revived generic subagent inherits the *reviving* runtime's frozen
 * execution environment and skills (`inheritance`), mirroring the
 * memory-authority rule. Named revivers pass `null`; generic revival then
 * fails visibly, while named revival continues to use its isolated catalog.
 */
export function createReviveSubagentTool(
  runner: SubagentRunner,
  parentCapture: CapturedMemoryContext,
  inheritance: GenericSubagentInheritance | null,
  onStatusUpdate?: (message: string) => void,
  timeoutMs?: number,
  delegatedContext?: DelegatedRuntimeContext,
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
      const result = await awaitSubagentResult(
        runner.revive(
          parentCapture,
          inheritance,
          params.id,
          params.prompt,
          onStatusUpdate,
          undefined,
          delegatedContext,
        ),
        effectiveTimeout,
        params.id,
        runner,
        delegatedContext?.ownerConversationId,
      );
      runner.acknowledgeDelivery(params.id);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { subagentId: params.id },
      };
    },
  });
}
