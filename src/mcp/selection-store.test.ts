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
