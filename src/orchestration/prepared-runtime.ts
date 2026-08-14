import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { DelegatedWorkHost } from "../delegated-work/mod.ts";
import {
  buildMainRuntimeCapabilityManifest,
  freezePreparedSurfaceRuntimePlan,
  type PreparedSurfaceRuntimePlan,
} from "../agent/runtime-plan.ts";
import { resolveModel } from "../agent/models.ts";
import { buildGoblinSystemPrompt } from "../agent/system-prompt.ts";
import { cloneSkillPolicy, resolveSkillSet, skillPolicyFingerprint } from "../agent/skills/mod.ts";
import { captureRuntimeMemoryContext, type MemoryStore } from "../memory/mod.ts";
import { environmentCwd, environmentsEqual, projectRootOf } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import { parseSurfaceId, surfaceId, type Surface, type SurfaceId } from "../surface.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { SurfaceRuntimeAuthority } from "./surface-runtime-authority.ts";
import type { RuntimeCreation, ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import type { SurfaceRuntimeSettingsSnapshot, SurfaceSettings } from "./conversation-lifecycle.ts";

export interface PreparedRuntimeAssemblerOptions {
  readonly cfg: Config;
  readonly surfaceSettings: SurfaceSettings;
  readonly surfaceRuntimeAuthority: SurfaceRuntimeAuthority;
  readonly runtimeHost: ConversationRuntimeHost;
  readonly memoryStore: MemoryStore;
  readonly getTopicName: (chatId: number, topicId: number) => Promise<string | null>;
  readonly createSurfaceTools: (surface: Surface) => ToolDefinition[];
  readonly subagentRunner: SubagentRunner;
  readonly scheduleStore?: ScheduleStore;
  readonly externalAgentRunner?: ExternalAgentRunner;
  readonly mcpRunner?: McpRunner;
}

/**
 * Prepares every authoritative input for one Surface runtime generation before
 * AgentRunner construction. The plan is ephemeral; callers commit it only by
 * registering the runner created from it.
 */
export class PreparedRuntimeAssembler {
  constructor(private readonly options: PreparedRuntimeAssemblerOptions) {}

  async prepare(
    conversation: ConversationState,
    surface: Surface,
    creation: RuntimeCreation,
    snapshot: SurfaceRuntimeSettingsSnapshot,
  ): Promise<PreparedSurfaceRuntimePlan> {
    const expectedSurfaceId = surfaceId(surface);
    if (creation.surfaceId !== expectedSurfaceId || creation.settingsFingerprint !== snapshot.fingerprint) {
      throw new Error(`runtime candidate identity mismatch for conversation ${conversation.id}`);
    }
    // Binding authority may replay a pending lifecycle transition. Consult it
    // before rejecting the caller's earlier settings snapshot so recovery can
    // complete and stale Conversation authority can be fenced correctly.
    await this.checkpoint(conversation, surface, creation, snapshot, "before skill resolution");
    if (!environmentsEqual(conversation.executionEnvironment, snapshot.executionEnvironment)) {
      throw new Error(`environment mismatch while preparing runtime for conversation ${conversation.id}`);
    }
    const skillPolicy = cloneSkillPolicy(snapshot.skillPolicy);
    const resolvedSkills = await resolveSkillSet(
      conversation.executionEnvironment,
      skillPolicy,
      this.options.cfg.goblinHome,
      { captureSnapshots: true },
    );
    await this.checkpoint(conversation, surface, creation, snapshot, "after skill resolution");

    if (this.options.runtimeHost.hasRuntime(conversation.id)) {
      await this.options.runtimeHost.disposeRuntime(conversation.id, { preserveInFlight: creation.promise });
    }
    await this.options.runtimeHost.awaitSettled(conversation.id);
    await this.checkpoint(conversation, surface, creation, snapshot, "after prior runtime cleanup");

    const memoryContext = await captureRuntimeMemoryContext({
      surface,
      caller: { kind: "main" },
      store: this.options.memoryStore,
      getTopicName: this.options.getTopicName,
    });
    await this.checkpoint(conversation, surface, creation, snapshot, "after memory capture");

    const systemPrompt = await buildGoblinSystemPrompt({
      home: this.options.cfg.goblinHome,
      executionEnvironment: conversation.executionEnvironment,
    });
    await this.checkpoint(conversation, surface, creation, snapshot, "after prompt capture");

    const modelName = snapshot.modelName ?? this.options.cfg.modelName;
    const resolvedModel = resolveModel({ ...this.options.cfg, modelName });
    const thinkingLevel = snapshot.thinkingLevel ?? resolvedModel.thinkingLevel;
    const runtimeId = DelegatedWorkHost.newRuntimeId();
    const capabilityManifest = this.buildCapabilityManifest(surface, conversation);
    const prompt = memoryContext.frozenSummary === null
      ? systemPrompt.prompt
      : `${systemPrompt.prompt}\n\n${memoryContext.frozenSummary}`;

    this.assertSynchronousCurrent(conversation, creation, snapshot, "before runner construction");

    return freezePreparedSurfaceRuntimePlan({
      conversationId: conversation.id,
      runtimeId,
      surface,
      surfaceId: expectedSurfaceId as SurfaceId,
      executionEnvironment: conversation.executionEnvironment,
      cwd: environmentCwd(conversation.executionEnvironment, this.options.cfg.goblinHome),
      modelName,
      resolvedModel,
      thinkingLevel,
      systemPrompt,
      prompt,
      memoryContext,
      skillPolicy,
      settingsFingerprint: snapshot.fingerprint,
      policyFingerprint: skillPolicyFingerprint(skillPolicy),
      resolvedSkills,
      capabilityManifest,
    });
  }

  private async checkpoint(
    conversation: ConversationState,
    surface: Surface,
    creation: RuntimeCreation,
    snapshot: SurfaceRuntimeSettingsSnapshot,
    stage: string,
  ): Promise<void> {
    if (!this.options.runtimeHost.isCurrentCreation(conversation.id, creation.promise)) {
      throw new Error(`stale runtime creation for conversation ${conversation.id}: invalidated ${stage}`);
    }
    try {
      await this.options.surfaceRuntimeAuthority.assertCurrentBinding(surface, conversation.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`stale runtime creation for conversation ${conversation.id} ${stage}: ${message}`);
    }
    this.assertSynchronousCurrent(conversation, creation, snapshot, stage);
  }

  private assertSynchronousCurrent(
    conversation: ConversationState,
    creation: RuntimeCreation,
    snapshot: SurfaceRuntimeSettingsSnapshot,
    stage: string,
  ): void {
    if (!this.options.runtimeHost.isCurrentCreation(conversation.id, creation.promise)) {
      throw new Error(`stale runtime creation for conversation ${conversation.id}: invalidated ${stage}`);
    }
    const current = this.options.surfaceSettings.getRuntimeSettings(creationSurface(creation));
    if (current.fingerprint !== snapshot.fingerprint) {
      throw new Error(`stale runtime creation for conversation ${conversation.id}: Surface settings changed ${stage}`);
    }
  }

  private buildCapabilityManifest(
    surface: Surface,
    conversation: ConversationState,
  ): ReturnType<typeof buildMainRuntimeCapabilityManifest> {
    const externalAgentBackends =
      this.options.externalAgentRunner !== undefined &&
        projectRootOf(conversation.executionEnvironment) !== undefined
        ? [...(this.options.cfg.externalAgents?.backends ?? [])]
        : [];
    return buildMainRuntimeCapabilityManifest({
      surfaceTools: this.options.createSurfaceTools(surface),
      hasScheduleStore: this.options.scheduleStore !== undefined,
      hasSubagentRunner: true,
      externalAgentBackends,
      hasMcp: this.options.mcpRunner !== undefined && this.options.cfg.mcp !== undefined,
    });
  }
}

function creationSurface(creation: RuntimeCreation): Surface {
  // RuntimeCreation stores canonical Surface identity specifically so every
  // stale check reconstructs authority from that identity rather than a caller
  // convenience object.
  return parseSurfaceId(creation.surfaceId);
}
