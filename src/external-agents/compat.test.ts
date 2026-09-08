import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BACKEND_CONTRACTS,
  CLAUDE_ACP_BRIDGE_PACKAGE,
  CLAUDE_ACP_BRIDGE_PIN,
  resolveClaudeBridge,
} from "./host.ts";

describe("ACP backend compatibility contract", () => {
  it("pins the claude bridge exactly and resolves the installed package to that version", () => {
    const repoPackageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    expect(repoPackageJson.dependencies?.[CLAUDE_ACP_BRIDGE_PACKAGE]).toBe(CLAUDE_ACP_BRIDGE_PIN);

    const resolved = resolveClaudeBridge();
    expect(resolved.version).toBe(CLAUDE_ACP_BRIDGE_PIN);
    expect(existsSync(resolved.entryPath)).toBe(true);
    expect(existsSync(resolved.packageJsonPath)).toBe(true);
  });

  it("keeps the per-backend capability expectations from decision 0044", () => {
    expect(BACKEND_CONTRACTS.claude).toEqual({
      continuationMethod: "session/resume",
      retirementMethod: "session/close",
      supportsSessionResume: true,
    });
    expect(BACKEND_CONTRACTS.devin).toEqual({
      continuationMethod: "session/load",
      retirementMethod: "session/delete",
      supportsSessionResume: false,
    });
  });
});
