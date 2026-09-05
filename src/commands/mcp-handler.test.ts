import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { handleCommand, type DispatchDeps } from "./dispatch.ts";
import type { Config } from "../config.ts";
import { dmSurface } from "../surface.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { TurnDispatcher } from "../orchestration/dispatcher.ts";
import type { McpRunner } from "../mcp/mod.ts";

function makeHome(configBody: string): string {
  const home = mkdtempSync(join(tmpdir(), "mcp-handler-"));
  writeFileSync(join(home, "goblin.json5"), configBody, "utf-8");
  return home;
}

function makeCfg(home: string, mcp: Config["mcp"]): Config {
  return {
    botToken: "token",
    allowedTgUserIds: new Set([1]),
    modelName: "openai/gpt-5.4",
    openaiApiKey: "k",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "standard",
    voiceName: "en-US-AriaNeural",
    favorites: [],
    mcp,
  };
}

function makeDeps(cfg: Config, mcpRunner?: McpRunner): DispatchDeps {
  return {
    lifecycle: {} as ConversationLifecycle,
    subagentRunner: {} as SubagentRunner,
    cfg,
    tryResolveModel: () => undefined,
    interruptAndCascade: (async () => {
      throw new Error("not used");
    }) as unknown as DispatchDeps["interruptAndCascade"],
    dispatcher: {} as TurnDispatcher,
    mcpRunner,
  };
}

function makeRunner(overrides: Partial<McpRunner> = {}): McpRunner {
  return {
    ready: Promise.resolve(),
    buildCatalogText: () => "Available MCP servers (use mcp_call to invoke):\n- tavily: x",
    refreshCatalog: async () => {},
    setSelection: () => {},
    getSelection: () => ({ enabled: undefined, disabledServers: [] }),
    ...overrides,
  } as unknown as McpRunner;
}

describe("/mcp operator gate and runtime honesty", () => {
  it("rejects enable from a non-operator without touching the file", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const before = readFileSync(join(home, "goblin.json5"), "utf-8");
      const cfg = makeCfg(home, {
        enabled: undefined,
        disabledServers: undefined,
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      const deps = makeDeps(cfg, makeRunner());
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp enable tavily",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
        invokingUserId: 999,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      expect(result.reply).toContain("Only the operator");
      expect(result.tag).toBe("warn");
      expect(readFileSync(join(home, "goblin.json5"), "utf-8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects enable when invoking identity is missing", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const cfg = makeCfg(home, {
        enabled: undefined,
        disabledServers: undefined,
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      const deps = makeDeps(cfg, makeRunner());
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp disable tavily",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      expect(result.reply).toContain("Only the operator");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("operator enable persists, installs policy into runner and deps, and reports honestly", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const cfg = makeCfg(home, {
        enabled: undefined,
        disabledServers: undefined,
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      let refreshedWith: unknown;
      const runner = makeRunner({
        refreshCatalog: async (sel?: unknown) => {
          refreshedWith = sel;
        },
      });
      const deps = makeDeps(cfg, runner);
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp disable tavily",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
        invokingUserId: 1,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      expect(result.tag).toBe("ok");
      expect(result.reply).toContain("tavily");
      expect(result.reply).toContain("in-memory catalog is refreshed");
      // Persisted to disk.
      const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
      expect(written.mcp.disabledServers).toEqual(["tavily"]);
      // Installed into the live runner before refresh.
      expect(refreshedWith).toEqual({ enabled: undefined, disabledServers: ["tavily"] });
      // Installed into shared deps for later inspects.
      expect(deps.cfg.mcp?.disabledServers).toEqual(["tavily"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a warning when the live refresh fails after a saved config", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const cfg = makeCfg(home, {
        enabled: undefined,
        disabledServers: undefined,
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      const runner = makeRunner({
        refreshCatalog: async () => {
          throw new Error("gateway down");
        },
      });
      const deps = makeDeps(cfg, runner);
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp disable tavily",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
        invokingUserId: 1,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      expect(result.tag).toBe("warn");
      expect(result.reply).toContain("config was saved");
      expect(result.reply).toContain("gateway down");
      // Config still saved despite refresh failure.
      const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
      expect(written.mcp.disabledServers).toEqual(["tavily"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("states restart-only when no live runner exists", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const cfg = makeCfg(home, {
        enabled: undefined,
        disabledServers: undefined,
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      const deps = makeDeps(cfg, undefined);
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp disable tavily",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
        invokingUserId: 1,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      expect(result.tag).toBe("ok");
      expect(result.reply).not.toContain("catalog is refreshed");
      expect(result.reply).toContain("restart");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("inspect shows effective selection when deny overlaps allow", async () => {
    const home = makeHome('{ mcp: {} }\n');
    try {
      const cfg = makeCfg(home, {
        enabled: ["tavily", "grep"],
        disabledServers: ["grep"],
        configPath: undefined,
        defaultTimeoutMs: 120000,
        maxResultChars: 16000,
      });
      const deps = makeDeps(cfg, makeRunner());
      const result = await handleCommand({
        command: "/mcp",
        rawText: "/mcp",
        deps,
        surface: dmSurface(123),
        conversation: null,
        existingRunner: null,
        invokingUserId: 999,
      });
      expect(result.kind).toBe("replied");
      if (result.kind !== "replied") throw new Error("expected reply");
      // Effective tavily, with deny noted — never shows grep as selected alone.
      expect(result.reply).toContain("denied: grep");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
