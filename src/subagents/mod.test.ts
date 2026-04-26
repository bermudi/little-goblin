import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-mock pi-coding-agent for this file. Other test files (notably
// `src/agent/mod.test.ts`) install a heavier mock that omits
// `SessionManager.create` — bun's `mock.module` is process-global so the
// last writer wins. Phase 2 only needs `SessionManager.create` to not
// throw and to create the target directory; the real session machinery
// is exercised in later phases.
mock.module("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    create: (_cwd: string, dir: string) => {
      mkdirSync(dir, { recursive: true });
      return { __stub: true } as unknown;
    },
  },
}));

import type { Config } from "../config.ts";
import { SubagentRunner } from "./mod.ts";
import { MAX_SUBAGENT_DEPTH, type SubagentMeta } from "./types.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  subagentsRoot,
} from "./paths.ts";

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

describe("SubagentRunner — skeleton", () => {
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
    expect(existsSync(subagentsRoot(tmp))).toBe(false);
  });

  it("starts with no active subagents", () => {
    expect(runner.list()).toEqual([]);
  });

  it("exposes a depth cap of 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it("revive() is stubbed until phase 5", async () => {
    await expect(
      runner.revive("missing", "ping"),
    ).rejects.toThrow(/not implemented/);
  });

  it("cancel() is stubbed until phase 6", async () => {
    await expect(runner.cancel("missing")).rejects.toThrow(/not implemented/);
  });
});

describe("SubagentRunner.spawn — generic", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    runner = new SubagentRunner(makeConfig(tmp));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the subagent directory and meta.json", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs" });

    expect(handle.status).toBe("running");
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);

    const dir = genericSubagentDir(tmp, handle.id);
    expect(existsSync(dir)).toBe(true);

    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SubagentMeta;
    expect(meta).toMatchObject({
      id: handle.id,
      role: "generic",
      name: null,
      spawnedBy: null,
      depth: 1,
      status: "running",
    });
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records spawnedBy when provided", async () => {
    const handle = await runner.spawn({
      prompt: "hi",
      spawnedBy: "goblin-session-42",
    });
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.spawnedBy).toBe("goblin-session-42");
  });

  it("tracks the spawned subagent in list()", async () => {
    const handle = await runner.spawn({ prompt: "ping" });
    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: handle.id,
      role: "generic",
      status: "running",
      name: null,
    });
  });

  it("provisions a persisted SessionManager pointing at the subagent dir", async () => {
    const handle = await runner.spawn({ prompt: "ping" });
    expect(runner.list()[0]?.id).toBe(handle.id);

    // SessionManager.create() creates the dir and prepares the session file
    // path inside it. The file itself isn't flushed until pi sees an
    // assistant turn (phase 4), but the directory must exist.
    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(true);
  });

  it("rejects spawning beyond depth 3", async () => {
    // Spawner at depth 3 → child would be at depth 4 → blocked.
    await expect(
      runner.spawn({ prompt: "deep", depth: 3 }),
    ).rejects.toThrow(/Maximum subagent depth reached \(3\)/);
  });

  it("permits spawning at the boundary (depth 2 spawner → depth 3 child)", async () => {
    const handle = await runner.spawn({ prompt: "boundary", depth: 2 });
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.depth).toBe(3);
  });

  it("rejects named subagents until phase 3", async () => {
    await expect(
      runner.spawn({ prompt: "hi", name: "researcher" }),
    ).rejects.toThrow(/phase 3/);
  });
});
