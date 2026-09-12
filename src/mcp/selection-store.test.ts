import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { formatMcpSelection, setMcpServerEnabled, validateMcpSection } from "./selection-store.ts";
import { goblinConfigLockPath } from "../sessions/paths.ts";

function makeHome(config: string): string {
  const home = mkdtempSync(join(tmpdir(), "mcp-writer-"));
  writeFileSync(join(home, "goblin.json5"), config, "utf-8");
  return home;
}

describe("setMcpServerEnabled", () => {
  it("creates an mcp section when absent and records the deny", () => {
    const home = makeHome('{ botToken: "x" }\n');
    const { config } = setMcpServerEnabled(home, "tavily", false);
    expect(config.enabled).toBeUndefined();
    expect(config.disabledServers).toEqual(["tavily"]);
    const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(written.botToken).toBe("x");
    expect(written.mcp.disabledServers).toEqual(["tavily"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves mcp:{} when an enable empties the section", () => {
    // enabled: undefined + disabled [tavily] means everything except tavily.
    // Re-enabling the last denied server must persist `mcp: {}` so a restart
    // still sees MCP configured; dropping the section would silently disable
    // MCP (absent mcp === disabled).
    const home = makeHome('{ mcp: { disabledServers: ["tavily"] } }\n');
    setMcpServerEnabled(home, "tavily", false);
    const afterDeny = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(afterDeny.mcp.disabledServers).toEqual(["tavily"]);

    const { config } = setMcpServerEnabled(home, "tavily", true);
    expect(config.disabledServers).toBeUndefined();
    expect(config.enabled).toBeUndefined();
    const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(written.mcp).toEqual({}); // empty section preserved on enable
    rmSync(home, { recursive: true, force: true });
  });

  it("adds to an existing allow-list on enable and removes on disable", () => {
    const home = makeHome('{ mcp: { enabled: ["grep"] } }\n');
    const on = setMcpServerEnabled(home, "tavily", true);
    expect(on.config.enabled?.sort()).toEqual(["grep", "tavily"]);

    const off = setMcpServerEnabled(home, "tavily", false);
    expect(off.config.enabled).toEqual(["grep"]);
    expect(off.config.disabledServers).toEqual(["tavily"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("disable wins over allow-list (deny precedence)", () => {
    const home = makeHome('{ mcp: { enabled: ["grep", "tavily"], disabledServers: ["tavily"] } }\n');
    const { config } = setMcpServerEnabled(home, "tavily", false);
    expect(config.enabled).toEqual(["grep"]);
    expect(config.disabledServers).toEqual(["tavily"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("enable removes the deny even when the server is not in any allow-list", () => {
    const home = makeHome('{ mcp: { disabledServers: ["tavily", "grep"] } }\n');
    const { config } = setMcpServerEnabled(home, "tavily", true);
    expect(config.disabledServers).toEqual(["grep"]);
    expect(config.enabled).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a missing config file", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-writer-"));
    expect(() => setMcpServerEnabled(home, "tavily", false)).toThrow(/Config file not found/);
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves unknown sibling keys in the mcp section", () => {
    const home = makeHome('{ mcp: { configPath: "mc.json", disabledServers: ["a"] } }\n');
    const { config } = setMcpServerEnabled(home, "a", true);
    expect(config.configPath).toBe("mc.json");
    expect(config.disabledServers).toBeUndefined();
    const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(written.mcp.configPath).toBe("mc.json");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("validateMcpSection", () => {
  it("applies schema defaults to an empty section", () => {
    const cfg = validateMcpSection({});
    expect(cfg.defaultTimeoutMs).toBe(120000);
    expect(cfg.maxResultChars).toBe(16000);
  });

  it("rejects garbage", () => {
    expect(() => validateMcpSection({ defaultTimeoutMs: 1 })).toThrow(/validation failed/);
  });
});

// Issue #66 unit 3: MCP section surfaced and editable through
// McpSelectionStore. New symbols load dynamically so this verifier commit
// typechecks before the implementation lands (mirrors server.test.ts).
interface McpLimitsPatch {
  defaultTimeoutMs?: number;
  maxResultChars?: number;
}
interface SelectionStoreModule {
  setMcpServerEnabled(
    goblinHome: string,
    server: string,
    enabled: boolean,
    options?: { expectedRevision?: string },
  ): { config: unknown; path: string; revision: string };
  setMcpLimits(
    goblinHome: string,
    limits: McpLimitsPatch,
    options?: { expectedRevision?: string },
  ): { config: unknown; path: string; revision: string };
  validateMcpLimits(limits: unknown): McpLimitsPatch;
  projectMcpSelection(config: unknown): {
    enabled: string[] | null;
    disabledServers: string[];
    defaultTimeoutMs: number;
    maxResultChars: number;
    configPath: { present: boolean };
  };
}
async function loadStore(): Promise<SelectionStoreModule> {
  const loaded: unknown = await import("./selection-store.ts");
  return loaded as SelectionStoreModule;
}

function readRaw(home: string): Record<string, unknown> {
  return JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8")) as Record<string, unknown>;
}

describe("MCP revision CAS (issue #66 unit 3)", () => {
  it("setMcpServerEnabled participates in the shared revision CAS", async () => {
    const { setMcpServerEnabled } = await loadStore();
    const home = makeHome('{ botToken: "x", mcp: { disabledServers: ["a"] } }\n');
    try {
      const target = join(home, "goblin.json5");
      const first = setMcpServerEnabled(home, "b", false);
      expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
      const beforeText = readFileSync(target, "utf-8");
      expect(() => setMcpServerEnabled(home, "c", false, { expectedRevision: "0".repeat(64) })).toThrow(
        /stale revision/,
      );
      expect(readFileSync(target, "utf-8")).toBe(beforeText);
      const fresh = setMcpServerEnabled(home, "c", false, { expectedRevision: first.revision });
      expect(fresh.revision).not.toBe(first.revision);
      const written = readRaw(home) as { mcp: { disabledServers: string[] } };
      expect(written.mcp.disabledServers).toEqual(["a", "b", "c"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("setMcpLimits participates in the shared revision CAS and writes only provided keys", async () => {
    const { setMcpLimits } = await loadStore();
    const home = makeHome('{ botToken: "x", mcp: { enabled: ["grep"], configPath: "mc.json" } }\n');
    try {
      const target = join(home, "goblin.json5");
      const { revision } = setMcpLimits(home, { defaultTimeoutMs: 45000 });
      expect(revision).toMatch(/^[0-9a-f]{64}$/);
      const written = readRaw(home) as { mcp: Record<string, unknown>; botToken: unknown };
      expect(written.mcp.defaultTimeoutMs).toBe(45000);
      // Only the patched keys change; allow-list, configPath, and unrelated
      // top-level keys survive, and schema defaults are not materialized.
      expect(written.mcp.enabled).toEqual(["grep"]);
      expect(written.mcp.configPath).toBe("mc.json");
      expect(written.botToken).toBe("x");
      expect(written.mcp.maxResultChars).toBeUndefined();

      const beforeText = readFileSync(target, "utf-8");
      expect(() => setMcpLimits(home, { maxResultChars: 2000 }, { expectedRevision: "f".repeat(64) })).toThrow(
        /stale revision/,
      );
      expect(readFileSync(target, "utf-8")).toBe(beforeText);
      const fresh = setMcpLimits(home, { maxResultChars: 2000 }, { expectedRevision: revision });
      expect(fresh.revision).not.toBe(revision);
      expect((readRaw(home) as { mcp: { maxResultChars?: number } }).mcp.maxResultChars).toBe(2000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("setMcpLimits rejects invalid values with an actionable error before any filesystem effect", async () => {
    const { setMcpLimits } = await loadStore();
    const home = makeHome('{ mcp: { defaultTimeoutMs: 60000 } }\n');
    try {
      const target = join(home, "goblin.json5");
      const beforeText = readFileSync(target, "utf-8");
      const badPatches: unknown[] = [
        { defaultTimeoutMs: 1 },
        { defaultTimeoutMs: 1_800_001 },
        { maxResultChars: 999 },
        { defaultTimeoutMs: 12.5 },
        { maxResultChars: "fast" },
        { nope: 1 },
      ];
      for (const patch of badPatches) {
        let caught: unknown;
        try {
          setMcpLimits(home, patch as McpLimitsPatch);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error & { reason?: string };
        expect(err.message).toMatch(/mcp limits validation failed|Unknown MCP limit field/);
        expect(err.reason).toBe("invalid-limits");
      }
      expect(readFileSync(target, "utf-8")).toBe(beforeText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("setMcpLimits refuses to mutate a section that already fails validation", async () => {
    const { setMcpLimits } = await loadStore();
    const home = makeHome("{ mcp: { defaultTimeoutMs: 1 } }\n");
    try {
      const target = join(home, "goblin.json5");
      const beforeText = readFileSync(target, "utf-8");
      expect(() => setMcpLimits(home, { defaultTimeoutMs: 45000 })).toThrow(/mcp config validation failed/);
      expect(readFileSync(target, "utf-8")).toBe(beforeText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("validateMcpLimits (issue #66 unit 3)", () => {
  it("returns only the provided keys", async () => {
    const { validateMcpLimits } = await loadStore();
    expect(validateMcpLimits({ defaultTimeoutMs: 30000 })).toEqual({ defaultTimeoutMs: 30000 });
    expect(validateMcpLimits({ maxResultChars: 4000, defaultTimeoutMs: 30000 })).toEqual({
      defaultTimeoutMs: 30000,
      maxResultChars: 4000,
    });
    expect(validateMcpLimits({})).toEqual({});
  });

  it("rejects non-object patches", async () => {
    const { validateMcpLimits } = await loadStore();
    for (const bad of ["x", 5, null, [1]]) {
      expect(() => validateMcpLimits(bad)).toThrow(/MCP limits patch must be an object/);
    }
  });
});

describe("projectMcpSelection (issue #66 unit 3)", () => {
  it("projects an absent section as schema defaults with no allow-list", async () => {
    const { projectMcpSelection } = await loadStore();
    expect(projectMcpSelection(undefined)).toEqual({
      enabled: null,
      disabledServers: [],
      defaultTimeoutMs: 120000,
      maxResultChars: 16000,
      configPath: { present: false },
    });
  });

  it("projects lists, limits, and configPath presence without the path value", async () => {
    const { projectMcpSelection } = await loadStore();
    const config = validateMcpSection({
      enabled: ["grep"],
      disabledServers: ["tavily"],
      configPath: "/home/daniel/mcporter.json",
      defaultTimeoutMs: 30000,
    });
    expect(projectMcpSelection(config)).toEqual({
      enabled: ["grep"],
      disabledServers: ["tavily"],
      defaultTimeoutMs: 30000,
      maxResultChars: 16000,
      configPath: { present: true },
    });
    expect(JSON.stringify(projectMcpSelection(config))).not.toContain("mcporter");
  });
});

describe("formatMcpSelection", () => {
  it("describes the unconfigured-deny state as all servers", () => {
    expect(formatMcpSelection(validateMcpSection({})) ).toBe("all servers in the gateway config");
  });

  it("describes a pure deny-list as all-except", () => {
    const cfg = validateMcpSection({ disabledServers: ["grep"] });
    expect(formatMcpSelection(cfg)).toBe("all servers except: grep");
  });

  it("describes an empty allow-list as none", () => {
    const cfg = validateMcpSection({ enabled: [] });
    expect(formatMcpSelection(cfg)).toBe("none (empty allow-list)");
  });

  it("shows effective selection when deny overlaps allow (deny wins)", () => {
    const cfg = validateMcpSection({ enabled: ["tavily", "grep"], disabledServers: ["grep"] });
    const text = formatMcpSelection(cfg);
    // Effective is tavily only, but the raw lists are retained so the denied
    // server is never displayed as selected.
    expect(text).toContain("tavily");
    expect(text).toContain("denied: grep");
    expect(text).toContain("allow-list: tavily, grep");
  });
});

describe("setMcpServerEnabled ownership hardening", () => {
  it("persists mcp:{} when enabling from an absent mcp section", () => {
    const home = makeHome('{ botToken: "x" }\n');
    const { config } = setMcpServerEnabled(home, "tavily", true);
    expect(config.enabled).toBeUndefined();
    expect(config.disabledServers).toBeUndefined();
    const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(written.mcp).toEqual({});
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves a hardened 0600 config mode across replacement", () => {
    const home = makeHome('{ mcp: { disabledServers: ["a"] } }\n');
    const target = join(home, "goblin.json5");
    chmodSync(target, 0o600);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    setMcpServerEnabled(home, "b", false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf-8")).toContain("b");
    rmSync(home, { recursive: true, force: true });
  });

  it("reaps a stale lock and completes the write", () => {
    const home = makeHome('{ mcp: {} }\n');
    const lockPath = goblinConfigLockPath(home);
    writeFileSync(lockPath, "stale\n", "utf-8");
    // Backdate the lock so it reads as stale (>10s old).
    const old = new Date(Date.now() - 20_000);
    utimesSync(lockPath, old, old);
    const { config } = setMcpServerEnabled(home, "tavily", false);
    expect(config.disabledServers).toEqual(["tavily"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses when a live lock is held", () => {
    const home = makeHome('{ mcp: {} }\n');
    const lockPath = goblinConfigLockPath(home);
    writeFileSync(lockPath, `${process.pid}\n`, "utf-8");
    try {
      expect(() => setMcpServerEnabled(home, "tavily", false)).toThrow(/locked/);
      const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
      expect(written.mcp).toEqual({});
    } finally {
      rmSync(lockPath, { force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
