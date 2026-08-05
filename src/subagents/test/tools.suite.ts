import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SubagentRunner } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  namedAgentAgentsMdPath,
  namedAgentDir,
} from "../paths.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  writeSessionFile,
} from "./support.ts";

describe("spawn_subagent tool", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-tool-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("has the correct name and description", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    expect(tool.name).toBe("spawn_subagent");
    expect(tool.label).toBe("Spawn Subagent");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("execute returns the subagent response text", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "Analyze the logs" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    host.latest().complete("Analysis complete.");

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Analysis complete." }]);
    expect((result.details as { subagentId: string }).subagentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes name parameter through to spawn", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "go", name: "researcher" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0]?.name).toBe("researcher");
    expect(runner.list()[0]?.role).toBe("named");

    host.latest().complete("done");
    await execPromise;
  });

  it("rejects generic spawn when a named caller has no inheritance authority", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 1, "named-1", DEFAULT_PARENT_CAPTURE, null);

    expect(tool.description).toContain("can spawn named agents only");
    await expect(
      tool.execute("tc-1", { prompt: "generic" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/requires inherited execution and skill authority/);
    expect(runner.list()).toEqual([]);
  });

  it("propagates spawn errors as tool errors", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 3, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    await expect(tool.execute("tc-1", { prompt: "deep" }, undefined, undefined, {} as never)).rejects.toThrow(
      /Maximum subagent depth reached/,
    );
  });
});

describe("revive_subagent tool", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-tool-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("has the correct name and description", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    expect(tool.name).toBe("revive_subagent");
    expect(tool.label).toBe("Revive Subagent");
    expect(tool.description).toBeTruthy();
  });

  it("execute revives a completed subagent with a new prompt", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");

    writeSessionFile(tmp, handle.id);

    const revivePromise = tool.execute(
      "tc-rev-1",
      { id: handle.id, prompt: "follow-up" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    host.latest().complete("done");
    const result = await revivePromise;
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("does not fabricate an empty manifest for a named caller reviving generic history", async () => {
    const handle = await runner.spawn({
      prompt: "first",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");

    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, null);
    await expect(
      tool.execute("tc-rev-1", { id: handle.id, prompt: "again" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/requires the reviving runtime's resolved skill manifest/);
  });

  it("propagates revive errors as tool errors", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);

    await expect(
      tool.execute("tc-rev-1", { id: "nonexistent", prompt: "hi" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Subagent not found");
  });
});

describe("spawn_subagent tool — timeout", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-tool-timeout-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("times out and cancels the subagent after timeoutMs", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, undefined, 50);

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "slow work" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    await expect(execPromise).rejects.toThrow(/timed out after 50ms/);

    const list = runner.list();
    if (list.length > 0) {
      expect(list[0]?.status).toBe("cancelled");
    }
  });

  it("completes normally if subagent finishes before timeout", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, undefined, 10000);

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "fast work" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    host.latest().complete("Done!");

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Done!" }]);
  });
});

describe("revive_subagent tool — timeout", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-tool-timeout-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnAndComplete(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");

    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00_fake.jsonl");
    return handle.id;
  }

  it("times out and cancels the revived subagent after timeoutMs", async () => {
    const id = await spawnAndComplete();

    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, undefined, 50);

    const execPromise = tool.execute(
      "tc-1",
      { id, prompt: "slow follow-up" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    await expect(execPromise).rejects.toThrow(/timed out after 50ms/);

    const list = runner.list();
    if (list.length > 0) {
      expect(list[0]?.status).toBe("cancelled");
    }
  });

  it("completes normally if revived subagent finishes before timeout", async () => {
    const id = await spawnAndComplete();

    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, undefined, 10000);

    const execPromise = tool.execute(
      "tc-1",
      { id, prompt: "fast follow-up" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    host.latest().complete("Revived!");

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Revived!" }]);
  });
});
