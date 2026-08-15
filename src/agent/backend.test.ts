import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Config } from "../config.ts";
import { piAgentDir, type PiServices } from "../pi-host.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { ResolvedSkillSet, ResolvedSkillSnapshot } from "./skills/mod.ts";
import { PiAgentBackend } from "./backend.ts";

let tmpDir: string;

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/test-model",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
    voiceName: "test-voice",
    favorites: [],
  };
}

function makeResolvedSkills(paths: readonly string[]): ResolvedSkillSet {
  return {
    skills: paths.map((filePath, index) => ({
      source: "goblin",
      name: `test-skill-${index}`,
      filePath,
    })),
    diagnostics: [],
    fingerprint: "test-fingerprint",
  };
}

function makeInitArgs(cwd: string, resolvedSkills: ResolvedSkillSet) {
  return {
    resolvedModel: {
      model: {} as Model<Api>,
      apiKey: "test-key",
      thinkingLevel: "medium" as ThinkingLevel,
    },
    thinkingLevel: "medium" as ThinkingLevel,
    customTools: [],
    guardBuiltInTool: (tool: ToolDefinition) => tool,
    systemPrompt: "test system prompt",
    cwd,
    resolvedSkills,
  };
}

interface HarnessState {
  createSessionCalls: number;
  loaderReloadCalls: number;
  loaderOptions: unknown;
}

function makeHarness(loadedSkillPaths: readonly string[] | null): {
  backend: PiAgentBackend;
  state: HarnessState;
} {
  const state: HarnessState = {
    createSessionCalls: 0,
    loaderReloadCalls: 0,
    loaderOptions: null,
  };
  const fakeSession = {
    isStreaming: false,
    subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
    dispose: () => {},
  } as unknown as AgentSession;

  class TestResourceLoader {
    constructor(options: unknown) {
      state.loaderOptions = options;
    }

    async reload(): Promise<void> {
      state.loaderReloadCalls += 1;
    }

    getSkills(): { skills: Array<{ filePath: string }>; diagnostics: [] } {
      const options = state.loaderOptions as { additionalSkillPaths?: readonly string[] };
      const paths = loadedSkillPaths ?? options.additionalSkillPaths ?? [];
      return {
        skills: paths.map((filePath) => ({ filePath })),
        diagnostics: [],
      };
    }
  }

  const createSession = async () => {
    state.createSessionCalls += 1;
    return { session: fakeSession } as Awaited<ReturnType<typeof createAgentSession>>;
  };
  const sessionManager = {
    create: () => ({}),
    open: () => ({}),
  } as unknown as typeof SessionManager;

  const backend = new PiAgentBackend({
    cfg: makeConfig(tmpDir),
    sessionId: "test-session",
    onEvent: () => {},
    deps: {
      createPiServices: async () => ({
        modelRuntime: { setRuntimeApiKey: async () => {} },
        settingsManager: {},
      } as unknown as PiServices),
      createAgentSession: createSession as typeof createAgentSession,
      DefaultResourceLoader: TestResourceLoader as unknown as typeof DefaultResourceLoader,
      SessionManager: sessionManager,
      findMostRecentCompatiblePiSession: () => null,
      piAgentDir,
      sessionDir,
    },
  });
  return { backend, state };
}

describe("PiAgentBackend skill loading", () => {
  it("rejects a selected skill that is missing before Pi reload", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const skillPath = join(tmpDir, "missing", "SKILL.md");
    const harness = makeHarness([]);

    await expect(
      harness.backend.init(makeInitArgs(tmpDir, makeResolvedSkills([skillPath]))),
    ).rejects.toThrow(new RegExp(`${skillPath}.*missing`));
    expect(harness.state.loaderReloadCalls).toBe(0);
    expect(harness.state.createSessionCalls).toBe(0);
  });

  it("rejects a selected path that is not a regular file before Pi reload", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const skillPath = join(tmpDir, "skill", "SKILL.md");
    mkdirSync(skillPath, { recursive: true });
    const harness = makeHarness([]);

    await expect(
      harness.backend.init(makeInitArgs(tmpDir, makeResolvedSkills([skillPath]))),
    ).rejects.toThrow(new RegExp(`${skillPath}.*not a regular file`));
    expect(harness.state.loaderReloadCalls).toBe(0);
    expect(harness.state.createSessionCalls).toBe(0);
  });

  it("rejects a selected skill omitted from Pi's loaded set", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const skillPath = join(tmpDir, "skill", "SKILL.md");
    mkdirSync(join(tmpDir, "skill"), { recursive: true });
    writeFileSync(skillPath, "---\nname: test\ndescription: test\n---\n", "utf8");
    const harness = makeHarness([]);

    await expect(
      harness.backend.init(makeInitArgs(tmpDir, makeResolvedSkills([skillPath]))),
    ).rejects.toThrow(skillPath);
    expect(harness.state.loaderReloadCalls).toBe(1);
    expect(harness.state.createSessionCalls).toBe(0);
  });

  it("initializes with the exact selected manifest and normalized loaded paths", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const skillPath = join(tmpDir, "skill", "SKILL.md");
    mkdirSync(join(tmpDir, "skill"), { recursive: true });
    writeFileSync(skillPath, "---\nname: test\ndescription: test\n---\n", "utf8");
    const harness = makeHarness([join(tmpDir, "skill", ".", "SKILL.md")]);

    await harness.backend.init(makeInitArgs(tmpDir, makeResolvedSkills([skillPath])));

    expect(harness.backend.isInitialized).toBe(true);
    expect(harness.state.createSessionCalls).toBe(1);
    expect(harness.state.loaderReloadCalls).toBe(1);
    const options = harness.state.loaderOptions as {
      noSkills: boolean;
      additionalSkillPaths: string[];
    };
    expect(options.noSkills).toBe(true);
    expect(options.additionalSkillPaths).toEqual([skillPath]);
  });

  it("initializes with an empty manifest", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const harness = makeHarness([]);

    await harness.backend.init(makeInitArgs(tmpDir, makeResolvedSkills([])));

    expect(harness.backend.isInitialized).toBe(true);
    expect(harness.state.createSessionCalls).toBe(1);
    const options = harness.state.loaderOptions as {
      noSkills: boolean;
      additionalSkillPaths: string[];
    };
    expect(options.noSkills).toBe(true);
    expect(options.additionalSkillPaths).toEqual([]);
  });

  it("materializes malformed skill names under an index-only directory", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-backend-test-"));
    const snapshot: ResolvedSkillSnapshot = {
      entryPath: "SKILL.md",
      files: [{
        relativePath: "SKILL.md",
        base64: Buffer.from("---\nname: UPPER BAD\n---\nbody\n").toString("base64"),
      }],
    };
    const harness = makeHarness(null);

    await harness.backend.init(makeInitArgs(tmpDir, {
      skills: [{
        source: "goblin",
        name: "UPPER BAD",
        filePath: join(tmpDir, "catalog", "SKILL.md"),
        snapshot,
      }],
      diagnostics: [],
      fingerprint: "test-fingerprint",
    }));

    const options = harness.state.loaderOptions as { additionalSkillPaths: string[] };
    const pathParts = options.additionalSkillPaths[0]!.split(sep);
    expect(pathParts.slice(-2)).toEqual(["0", "SKILL.md"]);
    expect(options.additionalSkillPaths[0]).not.toContain("UPPER BAD");
    expect(readFileSync(options.additionalSkillPaths[0]!, "utf8")).toContain("UPPER BAD");
    await harness.backend.dispose();
  });
});
