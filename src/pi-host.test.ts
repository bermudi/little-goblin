import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { piAgentDir } from "./pi-host.ts";

describe("pi-host path helpers", () => {
  const fixtureHome = "/home/goblin";

  describe("piAgentDir", () => {
    it("returns state/pi subdirectory", () => {
      expect(piAgentDir(fixtureHome)).toBe(join(fixtureHome, "state", "pi"));
    });
  });
});
