import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../memory/store.ts";
import { captureRuntimeMemoryContext, type CapturedMemoryContext } from "../memory/mod.ts";
import { MetricsStore } from "../metrics/mod.ts";
import { dmSurface } from "../surface.ts";
import {
  personalEnvironment,
  projectEnvironment,
  type ExecutionEnvironment,
} from "../sessions/environment.ts";
import { soulMdPath, workspacePath } from "../workspace/paths.ts";
import { piAgentDir } from "../pi-host.ts";
import {
  assembleSurfaceCustomTools,
  CapabilityManifestToolSource,
  type SurfaceToolAssemblyInputs,
} from "./tool-assembly.ts";
import {
  buildMainRuntimeCapabilityManifest,
  freezePreparedSurfaceRuntimePlan,
  MANDATORY_SURFACE_CAPABILITIES,
  type MainRuntimeCapability,
  type MainRuntimeCapabilityManifest,
} from "./runtime-plan.ts";
import { prepareTestSurfaceRuntimePlan } from "./runtime-plan.test-support.ts";
import type { GenericSubagentInheritance } from "../subagents/mod.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import type { ResolvedSkillSet } from "./skills/types.ts";
import { makeConfig } from "../subagents/test/support.ts";

// ---------------------------------------------------------------------------
// Stubs. The tool factories only touch these at construction time for a few
// reads (e.g. SubagentRunner.goblinHome, McpRunner.buildCatalogText); they do
// not execute, so minimal stubs keep the manifest-authoritative contract under
// test without standing up real backends.
// ---------------------------------------------------------------------------

function makeSubagentRunnerStub(home: string): SubagentRunner {
  return { goblinHome: home } as unknown as SubagentRunner;
}

function makeExternalAgentRunnerStub(): ExternalAgentRunner {
  return {} as unknown as ExternalAgentRunner;
}

function makeMcpRunnerStub(catalogText: string): McpRunner {
  return {
    ready: Promise.resolve(),
    buildCatalogText: () => catalogText,
    callTool: async () => ({ kind: "ok" as const, text: "" }),
    describeTool: async () => "",
    refreshCatalog: async () => {},
  } as unknown as McpRunner;
}

function makeScheduleStoreStub(): ScheduleStore {
  return {} as unknown as ScheduleStore;
}

function makeInheritance(env: ExecutionEnvironment): GenericSubagentInheritance {
  const resolvedSkills = {
    skills: [],
    diagnostics: [],
    fingerprint: "test-fingerprint",
  } as unknown as ResolvedSkillSet;
  return { executionEnvironment: env, resolvedSkills };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let home: string;
let memoryStore: MemoryStore;
let metricsStore: MetricsStore;
let memoryContext: CapturedMemoryContext;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "goblin-tool-assembly-"));
  mkdirSync(workspacePath(home), { recursive: true });
  mkdirSync(piAgentDir(home), { recursive: true });
  mkdirSync(dirname(soulMdPath(home)), { recursive: true });
  writeFileSync(soulMdPath(home), "test identity\n", "utf-8");
  memoryStore = new MemoryStore(home);
  metricsStore = new MetricsStore(home, "assembly-test");
  memoryContext = await captureRuntimeMemoryContext({
    surface: dmSurface(123),
    caller: { kind: "main" },
    store: memoryStore,
  });
});

afterEach(() => {
  memoryStore.close();
  rmSync(home, { recursive: true, force: true });
});

function makeInputs(
  manifest: MainRuntimeCapabilityManifest,
  overrides: Partial<SurfaceToolAssemblyInputs> = {},
): SurfaceToolAssemblyInputs {
  const env = overrides.executionEnvironment ?? personalEnvironment();
  return {
    manifest,
    memoryContext,
    memoryStore,
    metricsStore,
    resolveTopicName: async () => null,
    surface: dmSurface(123),
    sessionId: "assembly-test",
    delegatedRuntimeContext: null,
    genericSubagentInheritance: makeInheritance(env),
    executionEnvironment: env,
    scheduleStore: makeScheduleStoreStub(),
    subagentRunner: makeSubagentRunnerStub(home),
    externalAgentRunner: makeExternalAgentRunnerStub(),
    mcpRunner: makeMcpRunnerStub("Available MCP servers (use mcp_call to invoke):\n- tavily: tavily_search"),
    guardTool: (tool) => tool,
    isCurrent: () => true,
    sendStatusUpdate: () => {},
    awaitCurrent: (op) => op(),
    ...overrides,
  };
}

/** Strip capabilities from a full manifest, keeping it coherent: dropping a
 * paired capability also empties its data array. */
function manifestWithout(...omitted: MainRuntimeCapability[]): MainRuntimeCapabilityManifest {
  const full = buildMainRuntimeCapabilityManifest({
    surfaceTools: [{ name: "beta_tool" } as unknown as ToolDefinition],
    hasScheduleStore: true,
    hasSubagentRunner: true,
    externalAgentBackends: ["codex" as never],
    hasMcp: true,
  });
  return {
    capabilities: full.capabilities.filter((c) => !omitted.includes(c)),
    surfaceTools: omitted.includes("surface-tools") ? [] : full.surfaceTools,
    externalAgentBackends: omitted.includes("external-agent") ? [] : full.externalAgentBackends,
  };
}

/** Manifest advertising only the always-on capabilities plus the given ones. */
function manifestOnly(...caps: MainRuntimeCapability[]): MainRuntimeCapabilityManifest {
  return {
    capabilities: ["pi-file-tools", "memory", "prompt-file-notices", ...caps],
    surfaceTools: caps.includes("surface-tools")
      ? [{ name: "beta_tool" } as unknown as ToolDefinition]
      : [],
    externalAgentBackends: caps.includes("external-agent") ? ["codex" as never] : [],
  };
}

async function toolNames(manifest: MainRuntimeCapabilityManifest, overrides: Partial<SurfaceToolAssemblyInputs> = {}): Promise<string[]> {
  const tools = await assembleSurfaceCustomTools(makeInputs(manifest, overrides));
  return tools.map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Pin (a): a capability absent from the manifest is absent even when its
// store/runner is passed. A rename-only change that keeps store-presence
// gating fails here.
// ---------------------------------------------------------------------------

describe("assembleSurfaceCustomTools — manifest is sole authority", () => {
  it("(a) omits every dep-gated capability's tools when the manifest omits them, even though all deps are passed", async () => {
    // All deps present, but the manifest advertises only memory.
    const manifest = manifestWithout("surface-tools", "scheduling", "subagents", "external-agent", "mcp");
    const names = await toolNames(manifest);

    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("revive_subagent");
    expect(names).not.toContain("schedule_turn");
    expect(names).not.toContain("external_agent");
    expect(names).not.toContain("mcp_call");
    expect(names).not.toContain("mcp_describe");
    expect(names).not.toContain("beta_tool");
    // Memory is still advertised and its tools still appear.
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_write");
  });

  it("(a) omits memory tools when the manifest does not advertise memory, even though the store is present", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "prompt-file-notices"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    const names = await toolNames(manifest);
    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("memory_write");
  });

  // ---------------------------------------------------------------------------
  // Pin (b): an advertised capability whose required dep is absent throws.
  // ---------------------------------------------------------------------------

  it("(b) throws when subagents is advertised but subagentRunner is absent", async () => {
    await expect(assembleSurfaceCustomTools(makeInputs(manifestOnly("subagents"), { subagentRunner: null })))
      .rejects.toThrow(/subagents capability advertised.*subagentRunner is absent/);
  });

  it("(b) throws when scheduling is advertised but scheduleStore is absent", async () => {
    await expect(assembleSurfaceCustomTools(makeInputs(manifestOnly("scheduling"), { scheduleStore: undefined })))
      .rejects.toThrow(/scheduling capability advertised.*scheduleStore is absent/);
  });

  it("(b) throws when external-agent is advertised but externalAgentRunner is absent", async () => {
    await expect(
      assembleSurfaceCustomTools(
        makeInputs(manifestOnly("external-agent"), {
          externalAgentRunner: null,
          executionEnvironment: projectEnvironment(join(home, "project")),
        }),
      ),
    ).rejects.toThrow(/external-agent capability advertised.*externalAgentRunner is absent/);
  });

  it("(b) throws when external-agent is advertised but the environment is not a project", async () => {
    await expect(
      assembleSurfaceCustomTools(
        makeInputs(manifestOnly("external-agent"), { executionEnvironment: personalEnvironment() }),
      ),
    ).rejects.toThrow(/external-agent capability advertised.*not a project/);
  });

  it("(b) throws when mcp is advertised but mcpRunner is absent", async () => {
    await expect(assembleSurfaceCustomTools(makeInputs(manifestOnly("mcp"), { mcpRunner: null })))
      .rejects.toThrow(/mcp capability advertised.*mcpRunner is absent/);
  });

  it("(b) throws when subagents is advertised but generic inheritance is null", async () => {
    await expect(
      assembleSurfaceCustomTools(makeInputs(manifestOnly("subagents"), { genericSubagentInheritance: null })),
    ).rejects.toThrow(/subagents capability advertised.*inheritance is unavailable/);
  });

  // ---------------------------------------------------------------------------
  // Pin (c): full manifest + all deps ⇒ the complete expected tool-name set.
  // ---------------------------------------------------------------------------

  it("(c) produces the complete tool set when the full manifest and all deps agree", async () => {
    const manifest = buildMainRuntimeCapabilityManifest({
      surfaceTools: [{ name: "beta_tool" } as unknown as ToolDefinition],
      hasScheduleStore: true,
      hasSubagentRunner: true,
      externalAgentBackends: ["codex" as never],
      hasMcp: true,
    });
    const names = await toolNames(manifest, {
      executionEnvironment: projectEnvironment(join(home, "project")),
    });

    // surface-tools first, then memory, scheduling, subagents, external-agent, mcp.
    expect(names).toEqual([
      "beta_tool",
      "memory_search",
      "memory_write",
      "schedule_turn",
      "spawn_subagent",
      "revive_subagent",
      "external_agent",
      "mcp_call",
      "mcp_describe",
    ]);
  });

  it("(c) registers memory_search before memory_write", async () => {
    const manifest = manifestWithout("surface-tools", "scheduling", "subagents", "external-agent", "mcp");
    const names = await toolNames(manifest);
    expect(names.indexOf("memory_search")).toBeLessThan(names.indexOf("memory_write"));
  });
});

// ---------------------------------------------------------------------------
// Shared manifest-builder parity: production inputs advertise exactly the
// capabilities their deps can assemble.
// ---------------------------------------------------------------------------

describe("buildMainRuntimeCapabilityManifest", () => {
  it("advertises the always-on capabilities plus each dep-gated one", () => {
    const manifest = buildMainRuntimeCapabilityManifest({
      surfaceTools: [{ name: "t" } as unknown as ToolDefinition],
      hasScheduleStore: true,
      hasSubagentRunner: true,
      externalAgentBackends: ["codex" as never],
      hasMcp: true,
    });
    expect(manifest.capabilities).toEqual([
      "pi-file-tools",
      "memory",
      "subagents",
      "prompt-file-notices",
      "surface-tools",
      "scheduling",
      "external-agent",
      "mcp",
    ]);
  });

  it("advertises only the always-on capabilities when no deps are present", () => {
    const manifest = buildMainRuntimeCapabilityManifest({
      surfaceTools: [],
      hasScheduleStore: false,
      hasSubagentRunner: false,
      externalAgentBackends: [],
      hasMcp: false,
    });
    expect(manifest.capabilities).toEqual(["pi-file-tools", "memory", "prompt-file-notices"]);
  });

  it("does not advertise external-agent without a project (empty backends)", () => {
    const manifest = buildMainRuntimeCapabilityManifest({
      surfaceTools: [],
      hasScheduleStore: true,
      hasSubagentRunner: true,
      externalAgentBackends: [],
      hasMcp: true,
    });
    expect(manifest.capabilities).not.toContain("external-agent");
  });

  it("always advertises every mandatory capability", () => {
    const manifest = buildMainRuntimeCapabilityManifest({
      surfaceTools: [],
      hasScheduleStore: false,
      hasSubagentRunner: false,
      externalAgentBackends: [],
      hasMcp: false,
    });
    for (const mandatory of MANDATORY_SURFACE_CAPABILITIES) {
      expect(manifest.capabilities).toContain(mandatory);
    }
  });
});

// ---------------------------------------------------------------------------
// Coherence validation (findings #1 and #2): the manifest is a closed, trusted
// object. Mandatory always-on capabilities must be present, and paired data
// (surfaceTools / externalAgentBackends) must agree with their capability bits.
// The validator is the consume gate (assemble) and the freeze gate.
// ---------------------------------------------------------------------------

describe("capability manifest coherence validation", () => {
  // (finding #1) a mandatory capability cannot be omitted.
  it("throws when pi-file-tools is missing", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["memory", "prompt-file-notices"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/missing mandatory capability "pi-file-tools"/);
  });

  it("throws when prompt-file-notices is missing", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "memory"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/missing mandatory capability "prompt-file-notices"/);
  });

  // (finding #2) surface-tools capability must agree with the surfaceTools array.
  it("throws when surface-tools is advertised but no surface tools were captured", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "prompt-file-notices", "surface-tools"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/"surface-tools" capability disagrees/);
  });

  it("throws when surface tools were captured but surface-tools is not advertised", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "prompt-file-notices"],
      surfaceTools: [{ name: "beta_tool" } as unknown as ToolDefinition],
      externalAgentBackends: [],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/"surface-tools" capability disagrees/);
  });

  // (finding #2) external-agent capability must agree with the backends array.
  it("throws when external-agent is advertised but no backends were captured", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "prompt-file-notices", "external-agent"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/"external-agent" capability disagrees/);
  });

  it("throws when backends were captured but external-agent is not advertised", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: ["pi-file-tools", "prompt-file-notices"],
      surfaceTools: [],
      externalAgentBackends: ["codex" as never],
    };
    await expect(toolNames(manifest)).rejects.toThrow(/"external-agent" capability disagrees/);
  });

  it("assembles an empty tool list for the minimal coherent manifest (mandatory caps only)", async () => {
    const manifest: MainRuntimeCapabilityManifest = {
      capabilities: [...MANDATORY_SURFACE_CAPABILITIES],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    expect(await toolNames(manifest)).toEqual([]);
  });

  it("freeze rejects a manifest missing a mandatory capability", async () => {
    const coherent = await prepareTestSurfaceRuntimePlan({
      cfg: makeConfig(home),
      conversationId: "freeze-coherence-test",
      surface: dmSurface(123),
      memoryContext,
      executionEnvironment: personalEnvironment(),
      customTools: [],
    });
    const incoherent: MainRuntimeCapabilityManifest = {
      capabilities: ["memory", "prompt-file-notices"],
      surfaceTools: [],
      externalAgentBackends: [],
    };
    expect(() =>
      freezePreparedSurfaceRuntimePlan({ ...coherent, capabilityManifest: incoherent }),
    ).toThrow(/missing mandatory capability "pi-file-tools"/);
  });
});

// ---------------------------------------------------------------------------
// CapabilityManifestToolSource: the dependency-bundle encapsulator. The runner
// consumes this instead of carrying capability runners. It must merge captured
// plan identity + capability deps with the runner's live state identically to a
// direct assembleSurfaceCustomTools call — no input lost through the layer.
// ---------------------------------------------------------------------------

describe("CapabilityManifestToolSource", () => {
  it("produces identical tools to a direct assembleSurfaceCustomTools call", async () => {
    const subagentRunner = makeSubagentRunnerStub(home);
    const scheduleStore = makeScheduleStoreStub();
    const mcpRunner = makeMcpRunnerStub("Available MCP servers:\n- tavily: tavily_search");
    const env = projectEnvironment(join(home, "project"));
    const plan = await prepareTestSurfaceRuntimePlan({
      cfg: { ...makeConfig(home), mcp: { enabled: [], configPath: undefined, defaultTimeoutMs: 120_000, maxResultChars: 16_000 } },
      conversationId: "source-parity",
      surface: dmSurface(123),
      memoryContext,
      executionEnvironment: env,
      customTools: [{ name: "beta_tool" } as unknown as ToolDefinition],
      subagentRunner,
      scheduleStore,
      mcpRunner,
    });
    const runtimeInputs = {
      memoryStore,
      metricsStore,
      delegatedRuntimeContext: null,
      genericSubagentInheritance: makeInheritance(env),
      resolveTopicName: async (_chatId: number, _topicId: number): Promise<string | null> => null,
      guardTool: (tool: ToolDefinition) => tool,
      isCurrent: () => true,
      sendStatusUpdate: (_text: string) => {},
      awaitCurrent: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    };
    const source = new CapabilityManifestToolSource(plan, { scheduleStore, subagentRunner, mcpRunner });

    const viaSource = (await source.assemble(runtimeInputs)).map((t) => t.name);
    const direct = (
      await assembleSurfaceCustomTools({
        manifest: plan.capabilityManifest,
        memoryContext: plan.memoryContext,
        surface: plan.surface,
        sessionId: plan.conversationId,
        executionEnvironment: plan.executionEnvironment,
        scheduleStore,
        subagentRunner,
        externalAgentRunner: null,
        mcpRunner,
        ...runtimeInputs,
      })
    ).map((t) => t.name);

    expect(viaSource).toEqual(direct);
    expect(viaSource).toEqual([
      "beta_tool",
      "memory_search",
      "memory_write",
      "schedule_turn",
      "spawn_subagent",
      "revive_subagent",
      "mcp_call",
      "mcp_describe",
    ]);
  });
});
