import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { SubagentRunner } from "./mod.ts";
import { MAX_SUBAGENT_DEPTH } from "./types.ts";

function makeConfig(home: string): Config {
  return Object.freeze({
    botToken: "test-token",
    allowedTgUserIds: new Set<number>([1]),
    modelName: "test-model",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "none",
  }) as Config;
}

describe("SubagentRunner (phase 1 skeleton)", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    runner = new SubagentRunner(makeConfig(tmp));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("instantiates without I/O", () => {
    expect(runner).toBeInstanceOf(SubagentRunner);
  });

  it("starts with no active subagents", () => {
    expect(runner.list()).toEqual([]);
  });

  it("exposes a depth cap of 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it("spawn() is stubbed until phase 2", async () => {
    await expect(
      runner.spawn({ prompt: "hi" })
    ).rejects.toThrow(/not implemented/);
  });

  it("revive() is stubbed until phase 5", async () => {
    await expect(
      runner.revive("missing", "ping")
    ).rejects.toThrow(/not implemented/);
  });

  it("cancel() is stubbed until phase 6", async () => {
    await expect(runner.cancel("missing")).rejects.toThrow(/not implemented/);
  });
});
