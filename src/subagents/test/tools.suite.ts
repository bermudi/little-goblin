import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner } from "../mod.ts";
import {
  genericSubagentDir,
  namedAgentAgentsMdPath,
  namedAgentDir,
} from "../paths.ts";
import {
  createTestHome,
  flush,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";

describe("spawn_subagent tool", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-tool-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("has the correct name and description", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");

    expect(tool.name).toBe("spawn_subagent");
    expect(tool.label).toBe("Spawn Subagent");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("execute returns the subagent response text", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "Analyze the logs" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Analysis complete." },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Analysis complete." }]);
    expect((result.details as { subagentId: string }).subagentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes name parameter through to spawn", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");

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

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await execPromise;
  });

  it("propagates spawn errors as tool errors", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 3, "sess-1");

    await expect(tool.execute("tc-1", { prompt: "deep" }, undefined, undefined, {} as never)).rejects.toThrow(
      /Maximum subagent depth reached/,
    );
  });
});

describe("revive_subagent tool", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-tool-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("has the correct name and description", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner);

    expect(tool.name).toBe("revive_subagent");
    expect(tool.label).toBe("Revive Subagent");
    expect(tool.description).toBeTruthy();
  });

  it("execute revives a completed subagent with a new prompt", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner);

    const handle = await runner.spawn({ prompt: "first" });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const dir = genericSubagentDir(tmp, handle.id);
    writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");

    const revivePromise = tool.execute(
      "tc-rev-1",
      { id: handle.id, prompt: "follow-up" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    const result = await revivePromise;
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  it("propagates revive errors as tool errors", async () => {
    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner);

    await expect(
      tool.execute("tc-rev-1", { id: "nonexistent", prompt: "hi" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Subagent not found");
  });
});

describe("spawn_subagent tool — timeout", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-tool-timeout-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("times out and cancels the subagent after timeoutMs", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", undefined, 50);

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
    const tool = createSpawnSubagentTool(runner, 0, "sess-1", undefined, 10000);

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "fast work" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Done!" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Done!" }]);
  });
});

describe("revive_subagent tool — timeout", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-tool-timeout-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnAndComplete(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first" });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const dir = genericSubagentDir(tmp, handle.id);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, "2026-01-01T00-00-00_fake.jsonl"), "");
    return handle.id;
  }

  it("times out and cancels the revived subagent after timeoutMs", async () => {
    const id = await spawnAndComplete();
    resetPiMockState();

    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, undefined, 50);

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
    resetPiMockState();

    const { createReviveSubagentTool } = await import("../tool.ts");
    const tool = createReviveSubagentTool(runner, undefined, 10000);

    const execPromise = tool.execute(
      "tc-1",
      { id, prompt: "fast follow-up" },
      undefined,
      undefined,
      {} as never,
    );
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Revived!" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    const result = await execPromise;
    expect(result.content).toEqual([{ type: "text", text: "Revived!" }]);
  });
});
