import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { workdirPath, piAgentDir, agentsMdPath } from "./pi-host.ts";

describe("pi-host path helpers", () => {
  const fixtureHome = "/home/goblin";

  describe("workdirPath", () => {
    it("returns workdir subdirectory", () => {
      expect(workdirPath(fixtureHome)).toBe(join(fixtureHome, "workdir"));
    });
  });

  describe("piAgentDir", () => {
    it("returns goblin subdirectory", () => {
      expect(piAgentDir(fixtureHome)).toBe(join(fixtureHome, "goblin"));
    });
  });

  describe("agentsMdPath", () => {
    it("returns AGENTS.md at home root", () => {
      expect(agentsMdPath(fixtureHome)).toBe(join(fixtureHome, "AGENTS.md"));
    });
  });
});
