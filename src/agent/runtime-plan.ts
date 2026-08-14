import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { freezeCapturedMemoryContext, type CapturedMemoryContext } from "../memory/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { Surface, SurfaceId } from "../surface.ts";
import type { ConversationRuntimeId } from "../delegated-work/mod.ts";
import type { ResolvedModel } from "./models.ts";
import type { GoblinSystemPrompt } from "./system-prompt.ts";
import type { ResolvedSkillSet, SkillPolicy } from "./skills/mod.ts";
import type { ExternalAgentBackend } from "../external-agents/mod.ts";

/** Closed set of capabilities available to the current main-runtime implementation. */
export type MainRuntimeCapability =
  | "pi-file-tools"
  | "surface-tools"
  | "memory"
  | "scheduling"
  | "subagents"
  | "external-agent"
  | "mcp"
  | "prompt-file-notices";

/** Code-owned capability selection frozen for one Surface runtime generation. */
export interface MainRuntimeCapabilityManifest {
  readonly capabilities: readonly MainRuntimeCapability[];
  readonly surfaceTools: readonly ToolDefinition[];
  readonly externalAgentBackends: readonly ExternalAgentBackend[];
}

export interface PreparedSurfaceRuntimePlan {
  readonly conversationId: ConversationId;
  readonly runtimeId: ConversationRuntimeId;
  readonly surface: Surface;
  readonly surfaceId: SurfaceId;
  readonly executionEnvironment: ExecutionEnvironment;
  readonly cwd: string;
  readonly modelName: string;
  /** Contains the selected provider credential. Never persist or log this value. */
  readonly resolvedModel: ResolvedModel;
  readonly thinkingLevel: ThinkingLevel;
  readonly systemPrompt: GoblinSystemPrompt;
  /** Complete frozen system prompt, including the captured memory summary. */
  readonly prompt: string;
  readonly memoryContext: CapturedMemoryContext;
  readonly skillPolicy: SkillPolicy;
  readonly settingsFingerprint: string;
  readonly policyFingerprint: string;
  readonly resolvedSkills: ResolvedSkillSet;
  readonly capabilityManifest: MainRuntimeCapabilityManifest;
}

/**
 * Capabilities every Surface capability manifest must advertise. Their behavior
 * is inherent to a Surface runtime and is not gated on the manifest — backend
 * file tools (`pi-file-tools`) and prompt-file change notices
 * (`prompt-file-notices`) are always on — so a coherent manifest must always
 * list them. {@link assertCapabilityManifestCoherence} enforces this as an
 * invariant rather than a convention.
 */
export const MANDATORY_SURFACE_CAPABILITIES = [
  "pi-file-tools",
  "prompt-file-notices",
] as const satisfies readonly MainRuntimeCapability[];

/**
 * Assert that a Surface capability manifest is internally coherent before it is
 * trusted for tool assembly or frozen into a plan:
 * - every {@link MANDATORY_SURFACE_CAPABILITIES mandatory capability} is present;
 * - `surface-tools` is advertised iff at least one surface tool was captured;
 * - `external-agent` is advertised iff at least one backend was captured.
 *
 * The assembler trusts a manifest that passes this check, so call it whenever a
 * manifest is frozen into a plan or consumed for tool assembly.
 */
export function assertCapabilityManifestCoherence(
  manifest: MainRuntimeCapabilityManifest,
): void {
  const advertised = (capability: MainRuntimeCapability): boolean =>
    manifest.capabilities.includes(capability);
  for (const capability of MANDATORY_SURFACE_CAPABILITIES) {
    if (!advertised(capability)) {
      throw new Error(
        `capability manifest is missing mandatory capability "${capability}"`,
      );
    }
  }
  if (advertised("surface-tools") !== manifest.surfaceTools.length > 0) {
    throw new Error(
      'capability manifest is incoherent: "surface-tools" capability disagrees with the captured surfaceTools array',
    );
  }
  if (advertised("external-agent") !== manifest.externalAgentBackends.length > 0) {
    throw new Error(
      'capability manifest is incoherent: "external-agent" capability disagrees with the captured externalAgentBackends array',
    );
  }
}

/**
 * Inputs that decide which capabilities a Surface runtime advertises.
 *
 * Pure presence + data only: no stores, no config objects. Production and the
 * test fixture both call this so the manifest is the single authority for which
 * tools exist and is self-consistent with the deps that can assemble them.
 */
export interface CapabilityManifestInputs {
  /** Pre-built Surface-delivered tools (e.g. Telegram beta tools). */
  readonly surfaceTools: readonly ToolDefinition[];
  /** Shared schedule store present ⇒ the `scheduling` capability. */
  readonly hasScheduleStore: boolean;
  /** Shared subagent runner present ⇒ the `subagents` capability. */
  readonly hasSubagentRunner: boolean;
  /**
   * External-agent backends the runtime may expose. Non-empty only when an
   * external-agent runner is present AND the conversation runs in a project
   * execution environment; that gates the `external-agent` capability.
   */
  readonly externalAgentBackends: readonly ExternalAgentBackend[];
  /** MCP runner present AND MCP config enabled ⇒ the `mcp` capability. */
  readonly hasMcp: boolean;
}

/**
 * Build the closed capability manifest from presence flags and pre-built data.
 * `pi-file-tools`, `memory`, and `prompt-file-notices` are always advertised
 * (every Surface runtime owns a backend, a memory store, and the notice
 * behavior); the rest are dep-gated. The capability order is stable so production
 * logging and tests are deterministic.
 */
export function buildMainRuntimeCapabilityManifest(
  inputs: CapabilityManifestInputs,
): MainRuntimeCapabilityManifest {
  const capabilities: MainRuntimeCapability[] = [
    "pi-file-tools",
    "memory",
  ];
  if (inputs.hasSubagentRunner) capabilities.push("subagents");
  capabilities.push("prompt-file-notices");
  if (inputs.surfaceTools.length > 0) capabilities.push("surface-tools");
  if (inputs.hasScheduleStore) capabilities.push("scheduling");
  if (inputs.externalAgentBackends.length > 0) capabilities.push("external-agent");
  if (inputs.hasMcp) capabilities.push("mcp");
  return {
    capabilities,
    surfaceTools: [...inputs.surfaceTools],
    externalAgentBackends: [...inputs.externalAgentBackends],
  };
}

/**
 * Freeze the plan containers without freezing injected tool implementations or
 * provider objects that may be shared by their owning libraries.
 */
export function freezePreparedSurfaceRuntimePlan(
  plan: PreparedSurfaceRuntimePlan,
): PreparedSurfaceRuntimePlan {
  assertCapabilityManifestCoherence(plan.capabilityManifest);
  Object.freeze(plan.capabilityManifest.capabilities);
  Object.freeze(plan.capabilityManifest.surfaceTools);
  Object.freeze(plan.capabilityManifest.externalAgentBackends);
  Object.freeze(plan.capabilityManifest);
  Object.freeze(plan.systemPrompt.sources);
  Object.freeze(plan.systemPrompt);
  const resolvedModel = deepFrozenClone(plan.resolvedModel);
  for (const skill of plan.resolvedSkills.skills) Object.freeze(skill);
  for (const diagnostic of plan.resolvedSkills.diagnostics) Object.freeze(diagnostic);
  Object.freeze(plan.resolvedSkills.skills);
  Object.freeze(plan.resolvedSkills.diagnostics);
  Object.freeze(plan.resolvedSkills);
  for (const selection of Object.values(plan.skillPolicy)) {
    if (selection.mode === "selected") Object.freeze(selection.names);
    Object.freeze(selection);
  }
  Object.freeze(plan.skillPolicy);
  const frozenMemoryContext = freezeCapturedMemoryContext(plan.memoryContext);
  const executionEnvironment = Object.freeze({ ...plan.executionEnvironment });
  const surface = Object.freeze({ ...plan.surface }) as Surface;
  return Object.freeze({
    ...plan,
    surface,
    executionEnvironment,
    memoryContext: frozenMemoryContext,
    resolvedModel,
  });
}

/** Detach mutable provider metadata, then recursively freeze the clone. */
function deepFrozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
