import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { setMcpServerEnabled, validateMcpSection } from "./mcp-config-writer.ts";

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

  it("materializes the allow-list from a deny when re-enabling", () => {
    // enabled: undefined + disabled [a, b] means everything except a and b.
    // Enabling c must not widen the surface, so the allow-list becomes the
    // known set minus the disabled ones — expressed via enabled: ["c"] here
    // only when c was already listed; otherwise the deny just shrinks.
    const home = makeHome('{ mcp: { disabledServers: ["tavily"] } }\n');
    setMcpServerEnabled(home, "tavily", false);
    const afterDeny = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(afterDeny.mcp.disabledServers).toEqual(["tavily"]);

    const { config } = setMcpServerEnabled(home, "tavily", true);
    expect(config.disabledServers).toBeUndefined();
    expect(config.enabled).toBeUndefined();
    const written = JSON5.parse(readFileSync(join(home, "goblin.json5"), "utf-8"));
    expect(written.mcp).toBeUndefined(); // empty section dropped entirely
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
