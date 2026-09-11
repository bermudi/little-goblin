import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  delegatedSchema,
  handleDelegatedAction,
  type DelegatedExternalAgentToolOptions,
  type DelegatedInput,
  type LiveDelegatedRun,
} from "./tool-actions.ts";

export type { DelegatedExternalAgentToolOptions } from "./tool-actions.ts";

// ---------------------------------------------------------------------------
// Delegated-run tool surface (decision 0041 + 0044 + 0045 + 0049).
// Action semantics live in tool-actions.ts; this module is the model-facing
// definition and routing shell. New callers use createDelegatedExternalAgentTool.
// ---------------------------------------------------------------------------

export function createDelegatedExternalAgentTool(options: DelegatedExternalAgentToolOptions): ToolDefinition & { readonly liveRuns?: Map<string, LiveDelegatedRun> } {
  const schema = delegatedSchema();
  const live = new Map<string, LiveDelegatedRun>();
  const tool = defineTool({
    name: "external_agent",
    label: "External Agent",
    description: `Run or control an external agent with explicit launch selections. Supported backends: ${options.enabledBackends.join(", ") || "none enabled"}.

Actions:
- start: begin a run. Requires agent (claude|devin), task, workingDirectory.
- status: check a run by id.
- cancel: stop a run by id.
- message: send a message to an input_required run by id.
- list: list external runs from the delegated-run store.

Launch selections are structurally validated and captured with the delegated-run record. An omitted permissionProfile defaults to dangerous. The Devin model is operator-owned and never model-selectable.`,
    promptSnippet: "external_agent: run a task in a separate external agent (claude, devin) with explicit cwd and profile.",
    promptGuidelines: [
      "Use external_agent for self-contained work that can run in a separate process while you continue.",
      "Start with action: 'start' plus agent, task, workingDirectory, and permissionProfile.",
      "When a run reports input_required, use action: 'message' with the run id.",
      "Use action: 'cancel' to stop a run.",
      "Use action: 'list' to see runs from the delegated-run store.",
    ],
    parameters: schema,
    async execute(_toolCallId: string, params: DelegatedInput, signal?: AbortSignal) {
      const result = await handleDelegatedAction(options, live, params, signal);
      return {
        content: [{ type: "text" as const, text: result }],
        details: result,
      };
    },
  });
  return Object.assign(tool, { liveRuns: live });
}
