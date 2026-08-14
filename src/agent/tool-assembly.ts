/**
 * Surface tool-assembly seam.
 *
 * One narrow function turns the plan's capability manifest plus the required
 * runtime deps and runner-owned hook closures into the complete custom-tool
 * list for a Surface-backed `AgentRunner`. The manifest is the sole authority
 * for which tools exist: assembly never re-derives capability from config
 * flags or store/runner presence. If the manifest advertises a capability
 * whose required dep is absent, assembly throws — it never silently omits.
 *
 * Two capabilities are not tools but are mandatory manifest invariants:
 * `pi-file-tools` (backend built-ins, owned by `PiAgentBackend`) and
 * `prompt-file-notices` (runner event behavior). Their behavior is inherent to
 * a Surface runtime and always on, so a coherent manifest must always
 * advertise them; `assertCapabilityManifestCoherence` enforces that, and this
 * assembler produces no tools for them.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertCapabilityManifestCoherence,
  type MainRuntimeCapability,
  type MainRuntimeCapabilityManifest,
  type PreparedSurfaceRuntimePlan,
} from "./runtime-plan.ts";
import {
  createMemorySearchTool,
  createMemoryWriteTool,
  type CapturedMemoryContext,
  type MemoryStore,
} from "../memory/mod.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import { createScheduleTurnTool } from "../scheduler/tool.ts";
import type { SubagentRunner, GenericSubagentInheritance } from "../subagents/mod.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "../subagents/tool.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import { createExternalAgentTool } from "../external-agents/tool.ts";
import type { McpRunner } from "../mcp/mod.ts";
import { createMcpTools } from "../mcp/mod.ts";
import type { DelegatedRuntimeContext } from "../delegated-work/mod.ts";
import type { Surface } from "../surface.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { projectRootOf } from "../sessions/environment.ts";

/** Inputs to {@link assembleSurfaceCustomTools}. */
export interface SurfaceToolAssemblyInputs {
  /** Sole authority for which capabilities produce tools. */
  readonly manifest: MainRuntimeCapabilityManifest;
  /** Runner-owned captured memory context (Surface-backed). */
  readonly memoryContext: CapturedMemoryContext;
  /** Runner-owned memory + metrics stores backing the memory tools. */
  readonly memoryStore: MemoryStore;
  readonly metricsStore: MetricsStore;
  /**
   * Runner's cached, authority-fenced topic-name resolver. The memory-search
   * tool needs it to resolve scope descriptions without reconstructing the
   * cache or the authority fence.
   */
  readonly resolveTopicName: (chatId: number, topicId: number) => Promise<string | null>;
  /** Surface identity the scheduling tool binds against. */
  readonly surface: Surface;
  /** Conversation id threaded into subagent/external-agent closures. */
  readonly sessionId: string;
  /** Captured delegated-runtime authority for attached subagent runs. */
  readonly delegatedRuntimeContext: DelegatedRuntimeContext | null;
  /** Frozen generic-subagent inheritance (environment + resolved skills). */
  readonly genericSubagentInheritance: GenericSubagentInheritance | null;
  /** Execution environment; its project root gates the external-agent tool. */
  readonly executionEnvironment: ExecutionEnvironment;

  // Required-capability deps. Presence is checked against the manifest: an
  // advertised capability with a missing dep makes assembly throw.
  readonly scheduleStore: ScheduleStore | undefined;
  readonly subagentRunner: SubagentRunner | null;
  readonly externalAgentRunner: ExternalAgentRunner | null;
  readonly mcpRunner: McpRunner | null;

  // Runner-owned hook closures.
  /** Wraps every produced tool's `execute` with the authority fence. */
  readonly guardTool: (tool: ToolDefinition) => ToolDefinition;
  /** Current-binding check bound into the scheduling tool. */
  readonly isCurrent: () => boolean;
  /** Status-update forwarder bound into subagent/external-agent tools. */
  readonly sendStatusUpdate: (text: string) => void;
  /** Re-asserts authority across the genuinely async MCP-readiness boundary. */
  readonly awaitCurrent: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Assemble the complete custom-tool list for a Surface-backed runtime from the
 * capability manifest. The manifest is authoritative; advertised capabilities
 * whose deps are absent throw rather than being silently omitted, and the
 * manifest is coherence-checked first.
 */
export async function assembleSurfaceCustomTools(
  inputs: SurfaceToolAssemblyInputs,
): Promise<ToolDefinition[]> {
  assertCapabilityManifestCoherence(inputs.manifest);
  const tools: ToolDefinition[] = [];
  const has = (capability: MainRuntimeCapability): boolean =>
    inputs.manifest.capabilities.includes(capability);

  // surface-tools: pre-built Surface-delivered tools, appended as-is.
  if (has("surface-tools")) {
    tools.push(...inputs.manifest.surfaceTools);
  }

  // memory: search + write. The store is structurally always present on an
  // AgentRunner, so this capability has no absent-dep failure mode.
  if (has("memory")) {
    tools.push(
      createMemorySearchTool({
        store: inputs.memoryStore,
        context: inputs.memoryContext,
        getTopicName: (chatId, topicId) => inputs.resolveTopicName(chatId, topicId),
        metrics: inputs.metricsStore,
      }),
      createMemoryWriteTool({ store: inputs.memoryStore, context: inputs.memoryContext }),
    );
  }

  // scheduling
  if (has("scheduling")) {
    if (inputs.scheduleStore === undefined) {
      throw missingDep("scheduling", "scheduleStore");
    }
    tools.push(
      createScheduleTurnTool({
        store: inputs.scheduleStore,
        surface: inputs.surface,
        now: () => Date.now(),
        isCurrent: inputs.isCurrent,
      }),
    );
  }

  // subagents: spawn + revive
  if (has("subagents")) {
    if (inputs.subagentRunner === null) {
      throw missingDep("subagents", "subagentRunner");
    }
    const inheritance = inputs.genericSubagentInheritance;
    if (inheritance === null) {
      throw new Error("subagents capability advertised but generic inheritance is unavailable");
    }
    tools.push(
      createSpawnSubagentTool(
        inputs.subagentRunner,
        0,
        inputs.sessionId,
        inputs.memoryContext,
        inheritance,
        (msg) => inputs.sendStatusUpdate(msg),
        undefined,
        inputs.delegatedRuntimeContext ?? undefined,
        undefined,
      ),
    );
    tools.push(
      createReviveSubagentTool(
        inputs.subagentRunner,
        inputs.memoryContext,
        inheritance,
        (msg) => inputs.sendStatusUpdate(msg),
        undefined,
        inputs.delegatedRuntimeContext ?? undefined,
      ),
    );
  }

  // external-agent
  if (has("external-agent")) {
    if (inputs.externalAgentRunner === null) {
      throw missingDep("external-agent", "externalAgentRunner");
    }
    const projectDir = projectRootOf(inputs.executionEnvironment);
    if (projectDir === undefined) {
      throw new Error(
        "external-agent capability advertised but execution environment is not a project",
      );
    }
    const backends = inputs.manifest.externalAgentBackends;
    if (backends.length === 0) {
      throw new Error("external-agent capability advertised but no backends are configured");
    }
    tools.push(
      createExternalAgentTool({
        runner: inputs.externalAgentRunner,
        sessionId: inputs.sessionId,
        projectDir,
        enabledBackends: backends,
        onStatusUpdate: (msg) => inputs.sendStatusUpdate(msg),
      }),
    );
  }

  // mcp: the only genuinely async assembly step. Await gateway readiness and
  // re-assert authority across it before binding the tools.
  if (has("mcp")) {
    const mcpRunner = inputs.mcpRunner;
    if (mcpRunner === null) {
      throw missingDep("mcp", "mcpRunner");
    }
    await inputs.awaitCurrent(() => mcpRunner.ready);
    tools.push(...createMcpTools(mcpRunner));
  }

  return tools.map((tool) => inputs.guardTool(tool));
}

function missingDep(capability: string, name: string): Error {
  return new Error(
    `${capability} capability advertised by manifest but required dependency ${name} is absent`,
  );
}

// ---------------------------------------------------------------------------
// Tool source: encapsulates the capability dependency bundle behind one
// interface so the AgentRunner consumes an assembled result instead of carrying
// the capability runners and performing assembly itself.
// ---------------------------------------------------------------------------

/**
 * Runner-owned live state the tool source needs at assembly time. These are
 * things the `AgentRunner` owns for reasons beyond tool assembly (memory
 * stores, subagent-revival authority, and the per-runner authority/forwarding
 * hooks), so they are supplied when the runner asks for its tools rather than
 * captured by the source.
 */
export interface SurfaceToolAssemblyRuntimeInputs {
  readonly memoryStore: MemoryStore;
  readonly metricsStore: MetricsStore;
  /** Subagent-revival authority; also a public runner surface. */
  readonly delegatedRuntimeContext: DelegatedRuntimeContext | null;
  /** Generic-subagent inheritance; also a public runner surface. */
  readonly genericSubagentInheritance: GenericSubagentInheritance | null;
  /** Runner's cached, authority-fenced topic-name resolver. */
  readonly resolveTopicName: (chatId: number, topicId: number) => Promise<string | null>;
  /** Wraps every produced tool's `execute` with the authority fence. */
  readonly guardTool: (tool: ToolDefinition) => ToolDefinition;
  /** Current-binding check bound into the scheduling tool. */
  readonly isCurrent: () => boolean;
  /** Status-update forwarder bound into subagent/external-agent tools. */
  readonly sendStatusUpdate: (text: string) => void;
  /** Re-asserts authority across the genuinely async MCP-readiness boundary. */
  readonly awaitCurrent: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Capability runners a Surface runtime may expose as tools. The source holds
 * these so the runner does not; an advertised capability whose runner is absent
 * still fails loud inside {@link assembleSurfaceCustomTools}.
 */
export interface CapabilityToolDeps {
  readonly scheduleStore?: ScheduleStore;
  readonly subagentRunner?: SubagentRunner;
  readonly externalAgentRunner?: ExternalAgentRunner;
  readonly mcpRunner?: McpRunner;
}

/**
 * Produces the complete custom-tool list for a Surface runtime. The concrete
 * implementation encapsulates the capability dependency bundle plus the plan
 * identity; the runner supplies only its own live state via
 * {@link SurfaceToolAssemblyRuntimeInputs} and consumes the result.
 */
export interface SurfaceCustomToolsSource {
  assemble(inputs: SurfaceToolAssemblyRuntimeInputs): Promise<ToolDefinition[]>;
}

/**
 * {@link SurfaceCustomToolsSource} backed by a capability manifest. Captures the
 * plan (authority + identity) and the capability runners at construction; merges
 * the runner's live state at assembly time and delegates to
 * {@link assembleSurfaceCustomTools}.
 */
export class CapabilityManifestToolSource implements SurfaceCustomToolsSource {
  constructor(
    private readonly plan: PreparedSurfaceRuntimePlan,
    private readonly deps: CapabilityToolDeps,
  ) {}

  async assemble(inputs: SurfaceToolAssemblyRuntimeInputs): Promise<ToolDefinition[]> {
    return assembleSurfaceCustomTools({
      manifest: this.plan.capabilityManifest,
      memoryContext: this.plan.memoryContext,
      memoryStore: inputs.memoryStore,
      metricsStore: inputs.metricsStore,
      resolveTopicName: inputs.resolveTopicName,
      surface: this.plan.surface,
      sessionId: this.plan.conversationId,
      delegatedRuntimeContext: inputs.delegatedRuntimeContext,
      genericSubagentInheritance: inputs.genericSubagentInheritance,
      executionEnvironment: this.plan.executionEnvironment,
      scheduleStore: this.deps.scheduleStore,
      subagentRunner: this.deps.subagentRunner ?? null,
      externalAgentRunner: this.deps.externalAgentRunner ?? null,
      mcpRunner: this.deps.mcpRunner ?? null,
      guardTool: inputs.guardTool,
      isCurrent: inputs.isCurrent,
      sendStatusUpdate: inputs.sendStatusUpdate,
      awaitCurrent: inputs.awaitCurrent,
    });
  }
}
