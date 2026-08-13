import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { DelegatedWorkHost } from "../delegated-work/mod.ts";
import type { CapturedMemoryContext } from "../memory/mod.ts";
import { environmentCwd, type ExecutionEnvironment } from "../sessions/environment.ts";
import { surfaceId, type Surface } from "../surface.ts";
import { resolveModel, type ResolvedModel } from "./models.ts";
import { freezePreparedSurfaceRuntimePlan, type PreparedSurfaceRuntimePlan } from "./runtime-plan.ts";
import { buildGoblinSystemPrompt } from "./system-prompt.ts";
import { DEFAULT_SKILL_POLICY, resolveSkillSet, skillPolicyFingerprint, type SkillPolicy } from "./skills/mod.ts";

/** Test-only direct plan builder for AgentRunner unit and SDK contract tests. */
export async function prepareTestSurfaceRuntimePlan(args: {
  cfg: Config;
  conversationId: string;
  surface: Surface;
  memoryContext: CapturedMemoryContext;
  executionEnvironment: ExecutionEnvironment;
  customTools?: ToolDefinition[];
  modelName?: string;
  thinkingLevel?: ThinkingLevel;
  resolvedModel?: ResolvedModel;
  skillPolicy?: SkillPolicy;
}): Promise<PreparedSurfaceRuntimePlan> {
  const skillPolicy = args.skillPolicy ?? DEFAULT_SKILL_POLICY;
  const modelName = args.modelName ?? args.cfg.modelName;
  const resolvedModel = args.resolvedModel ?? resolveModel({ ...args.cfg, modelName });
  const resolvedSkills = await resolveSkillSet(args.executionEnvironment, skillPolicy, args.cfg.goblinHome);
  const systemPrompt = await buildGoblinSystemPrompt({
    home: args.cfg.goblinHome,
    executionEnvironment: args.executionEnvironment,
  });
  const prompt = args.memoryContext.frozenSummary === null
    ? systemPrompt.prompt
    : `${systemPrompt.prompt}\n\n${args.memoryContext.frozenSummary}`;
  const policyFingerprint = skillPolicyFingerprint(skillPolicy);
  const surfaceTools = args.customTools ?? [];
  return freezePreparedSurfaceRuntimePlan({
    conversationId: args.conversationId,
    runtimeId: DelegatedWorkHost.newRuntimeId(),
    surface: args.surface,
    surfaceId: surfaceId(args.surface),
    executionEnvironment: args.executionEnvironment,
    cwd: environmentCwd(args.executionEnvironment, args.cfg.goblinHome),
    modelName,
    resolvedModel,
    thinkingLevel: args.thinkingLevel ?? resolvedModel.thinkingLevel,
    systemPrompt,
    prompt,
    memoryContext: args.memoryContext,
    skillPolicy,
    settingsFingerprint: `test:${policyFingerprint}:${modelName}:${args.thinkingLevel ?? "default"}`,
    policyFingerprint,
    resolvedSkills,
    capabilityManifest: {
      capabilities: [
        "pi-file-tools",
        ...(surfaceTools.length > 0 ? ["surface-tools" as const] : []),
        "memory",
        "scheduling",
        "subagents",
        "external-agent",
        "mcp",
        "prompt-file-notices",
      ],
      surfaceTools,
      externalAgentBackends: [...(args.cfg.externalAgents?.backends ?? [])],
    },
  });
}
