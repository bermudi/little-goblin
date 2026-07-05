import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  subagentsRoot,
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentsRoot,
  namedAgentDir,
  namedAgentAgentsMdPath,
  namedAgentSkillsDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
} from "./paths.ts";

describe("subagents paths", () => {
  const home = "/tmp/goblin";

  it("resolves the generic subagents root under scratch/", () => {
    expect(subagentsRoot(home)).toBe(join(home, "scratch", "subagents"));
  });

  it("resolves a generic subagent instance directory by id", () => {
    expect(genericSubagentDir(home, "inst-1")).toBe(
      join(home, "scratch", "subagents", "inst-1"),
    );
  });

  it("resolves a generic subagent meta.json by id", () => {
    expect(genericSubagentMetaPath(home, "inst-1")).toBe(
      join(home, "scratch", "subagents", "inst-1", "meta.json"),
    );
  });

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

  it("resolves a named agent skills directory by name", () => {
    expect(namedAgentSkillsDir(home, "researcher")).toBe(
      join(home, "workspace", "agents", "researcher", "skills"),
    );
  });

  it("resolves a named agent instance directory by name and id", () => {
    expect(namedAgentInstanceDir(home, "researcher", "inst-9")).toBe(
      join(home, "workspace", "agents", "researcher", "instances", "inst-9"),
    );
  });

  it("resolves a named agent instance meta.json by name and id", () => {
    expect(namedAgentInstanceMetaPath(home, "researcher", "inst-9")).toBe(
      join(home, "workspace", "agents", "researcher", "instances", "inst-9", "meta.json"),
    );
  });
});
