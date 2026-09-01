import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { AgentRunner } from "../agent/mod.ts";
import { MemoryStore, EmbeddingProvider, DreamingPipeline } from "../memory/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { DurableCompletionWake, PendingCompletionClaim } from "../delegated-work/mod.ts";
import type { ConversationState } from "../sessions/types.ts";
import type { Surface } from "../surface.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import {
  createConversationLifecycle,
  FileSurfaceSettings,
  type ConversationLifecycle,
} from "./conversation-lifecycle.ts";
import { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import { TurnDispatcher, type TurnSink } from "./dispatcher.ts";

/** Dependencies needed to assemble the Conversation runtime kernel. */
export interface ConversationOrchestrationOptions {
  readonly cfg: Config;
  readonly subagentRunner: SubagentRunner;
  readonly memoryStore: MemoryStore;
  readonly createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly dreamingPipeline?: DreamingPipeline;
  readonly createMessageBuffer: (surface: Surface, conversation?: ConversationState) => TurnSink;
  readonly createBetaTools: (surface: Surface) => ToolDefinition[];
  readonly scheduleStore?: ScheduleStore;
  readonly externalAgentRunner?: ExternalAgentRunner;
  readonly mcpRunner?: McpRunner;
}

/** The three long-lived orchestration objects and their ownership boundary. */
export interface ConversationOrchestration {
  readonly runtimeHost: ConversationRuntimeHost;
  readonly lifecycle: ConversationLifecycle;
  readonly dispatcher: TurnDispatcher;
  readonly pendingClaim: PendingCompletionClaim;
}

/**
 * Assemble the runtime kernel in owner order:
 *
 *   ConversationRuntimeHost → ConversationLifecycle → TurnDispatcher
 *
 * The host owns ephemeral runtime state. Lifecycle owns Binding authority. The
 * dispatcher creates and schedules work using both, but neither Telegram nor
 * the composition root needs a back-reference or a post-construction setter.
 */
export function createConversationOrchestration(
  options: ConversationOrchestrationOptions,
): ConversationOrchestration {
  // SubagentRunner is constructed before this kernel and carries the single
  // DelegatedWorkHost. ConversationRuntimeHost and TurnDispatcher both derive
  // from that one instance, so the three can never hold different hosts: a
  // mismatch is unrepresentable rather than asserted at runtime.
  const delegatedWorkHost = options.subagentRunner.delegatedWorkHost;
  const surfaceSettings = new FileSurfaceSettings(options.cfg.goblinHome);
  const runtimeHost = new ConversationRuntimeHost({
    delegatedWorkHost,
    externalAgentRunner: options.externalAgentRunner,
  });
  const lifecycle = createConversationLifecycle(
    options.cfg.goblinHome,
    runtimeHost,
    surfaceSettings,
  );
  const dispatcher = new TurnDispatcher({
    cfg: options.cfg,
    surfaceSettings,
    subagentRunner: options.subagentRunner,
    memoryStore: options.memoryStore,
    runtimeHost,
    createAgentRunner: options.createAgentRunner,
    createMessageBuffer: options.createMessageBuffer,
    createBetaTools: options.createBetaTools,
    scheduleStore: options.scheduleStore,
    externalAgentRunner: options.externalAgentRunner,
    mcpRunner: options.mcpRunner,
    embeddingProvider: options.embeddingProvider,
    dreamingPipeline: options.dreamingPipeline,
    surfaceRuntimeAuthority: lifecycle,
  });

  // Decision-0036 completion wake: durable delegated completions ride the
  // surface-bound system-turn rail (resolveCurrent + scheduled turns). The
  // runner was built before this kernel, so the wake is wired here, once,
  // from the same single delegated-work host the kernel already derived.
  const completionWake = new DurableCompletionWake(
    {
      resolveCurrent: (surface) => lifecycle.resolveCurrent(surface),
      enqueueScheduledTurn: (conversation, surface, content) =>
        dispatcher.enqueueScheduledTurn(conversation, surface, content),
    },
    delegatedWorkHost,
  );
  options.subagentRunner.setCompletionWake(completionWake);
  // Decision-0036 pending claim: completions the wake left pending claim on
  // an authorized ordinary interaction, an authorized guest summon, or the
  // startup re-arm — through the same wake and the same host.
  const pendingClaim = new PendingCompletionClaim(completionWake, delegatedWorkHost);

  return { runtimeHost, lifecycle, dispatcher, pendingClaim };
}
