import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { workdirPath, piAgentDir, agentsMdPath, soulMdPath, skillsPath, heartbeatMdPath } from "./pi-host.ts";

describe("pi-host path helpers", () => {
  const fixtureHome = "/home/goblin";

  describe("workdirPath", () => {
    it("returns scratch/workdir subdirectory", () => {
      expect(workdirPath(fixtureHome)).toBe(join(fixtureHome, "scratch", "workdir"));
    });
  });

  describe("piAgentDir", () => {
    it("returns state/pi subdirectory", () => {
      expect(piAgentDir(fixtureHome)).toBe(join(fixtureHome, "state", "pi"));
    });
  });

  describe("agentsMdPath", () => {
    it("returns AGENTS.md in workspace", () => {
      expect(agentsMdPath(fixtureHome)).toBe(join(fixtureHome, "workspace", "AGENTS.md"));
    });
  });

  describe("soulMdPath", () => {
    it("returns SOUL.md in workspace", () => {
      expect(soulMdPath(fixtureHome)).toBe(join(fixtureHome, "workspace", "SOUL.md"));
    });
  });

  describe("heartbeatMdPath", () => {
    it("returns HEARTBEAT.md in workspace", () => {
      expect(heartbeatMdPath(fixtureHome)).toBe(join(fixtureHome, "workspace", "HEARTBEAT.md"));
    });
  });

  describe("skillsPath", () => {
    it("returns skills directory in workspace", () => {
      expect(skillsPath(fixtureHome)).toBe(join(fixtureHome, "workspace", "skills"));
    });
  });
});
