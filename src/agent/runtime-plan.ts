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

export function hasMainRuntimeCapability(
  manifest: MainRuntimeCapabilityManifest,
  capability: MainRuntimeCapability,
): boolean {
  return manifest.capabilities.includes(capability);
}

/**
 * Freeze the plan containers without freezing injected tool implementations or
 * provider objects that may be shared by their owning libraries.
 */
export function freezePreparedSurfaceRuntimePlan(
  plan: PreparedSurfaceRuntimePlan,
): PreparedSurfaceRuntimePlan {
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
