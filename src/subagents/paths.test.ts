import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  namedAgentsRoot,
  namedAgentDir,
  namedAgentAgentsMdPath,
  namedAgentSkillsDir,
} from "./paths.ts";

describe("subagents paths", () => {
  const home = "/tmp/goblin";

  it("resolves the named agents root under workspace/", () => {
    expect(namedAgentsRoot(home)).toBe(join(home, "workspace", "agents"));
  });

  it("resolves a named agent definition directory by name", () => {
    expect(namedAgentDir(home, "researcher")).toBe(
      join(home, "workspace", "agents", "researcher"),
    );
  });

  it("resolves a named agent AGENTS.md by name", () => {
    expect(namedAgentAgentsMdPath(home, "researcher")).toBe(
      join(home, "workspace", "agents", "researcher", "AGENTS.md"),
    );
  });

  it("resolves a named agent's isolated pi-native skills directory by name", () => {
    expect(namedAgentSkillsDir(home, "researcher")).toBe(
      join(home, "workspace", "agents", "researcher", ".agents", "skills"),
    );
  });
});
