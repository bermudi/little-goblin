import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, type CapturedMemoryContext } from "../../memory/mod.ts";
import { memoryDir } from "../../memory/paths.ts";
import { activeMemoryScopeFor } from "../../memory/scope.ts";
import { surfaceId, topicSurface } from "../../surface.ts";
import { SubagentRunner, type SubagentToolFactory } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import { namedAgentAgentsMdPath, namedAgentDir } from "../paths.ts";
import { createSpawnSubagentTool, createReviveSubagentTool } from "../tool.ts";
import type { SubagentInstance } from "../types.ts";
import {
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  DEFAULT_SCOPE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  writeRecordAndSession,
  writeSessionFile,
} from "./support.ts";

function getInstance(runner: SubagentRunner, id: string): SubagentInstance | undefined {
  return (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(id);
}

function jsonOf<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text) as T;
}

const PARENT_SURFACE = topicSurface("supergroup", -100123, 42);
const PARENT_SCOPE = { chatId: -100123, topicScope: { topicId: 42 } } as const;
const PARENT_AUTHORITY = {
  kind: "surface" as const,
  sourceSurfaceId: surfaceId(PARENT_SURFACE),
  activeScope: PARENT_SCOPE,
};

const MOVED_SURFACE = topicSurface("supergroup", -100123, 99);
const MOVED_SCOPE = { chatId: -100123, topicScope: { topicId: 99 } } as const;
const MOVED_AUTHORITY = {
  kind: "surface" as const,
  sourceSurfaceId: surfaceId(MOVED_SURFACE),
  activeScope: MOVED_SCOPE,
};
const MOVED_PARENT_CAPTURE = {
  kind: "surface" as const,
  authority: MOVED_AUTHORITY,
  caller: { kind: "main" as const },
  frozenSummary: null,
  frozenUserBody: "",
  frozenActiveMemoryBody: "",
};

async function seedScopes(home: string): Promise<void> {
  const store = new MemoryStore(home);
  try {
    await store.add(activeMemoryScopeFor(PARENT_SCOPE), "parent-topic fact");
    await store.add(activeMemoryScopeFor(MOVED_SCOPE), "moved-topic fact");
  } finally {
    store.close();
  }
  mkdirSync(join(memoryDir(home), "topics", String(PARENT_SCOPE.chatId), String(PARENT_SCOPE.topicScope.topicId)), { recursive: true });
  mkdirSync(join(memoryDir(home), "topics", String(MOVED_SCOPE.chatId), String(MOVED_SCOPE.topicScope.topicId)), { recursive: true });
}

function findSearch(
  tools: unknown[],
): { execute: (...args: unknown[]) => Promise<unknown> } | undefined {
  return (tools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>).find(
    (t) => t.name === "memory_search",
  );
}

describe("SubagentRunner — Surface-derived invocation authority", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-surface-authority-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("freezes the parent Surface authority at spawn and ignores later parent movement", async () => {
    await seedScopes(tmp);

    const firstHandle = await runner.spawn({ prompt: "first", authority: PARENT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    const firstInstance = getInstance(runner, firstHandle.id);
    expect(firstInstance?.authority).toEqual(PARENT_AUTHORITY);

    const firstSearch = findSearch(host.latest().invocations[0]?.customTools as unknown as unknown[]);
    expect(firstSearch).toBeDefined();
    const firstResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await firstSearch!.execute("ms-1", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(firstResult.entries.map((e) => e.text)).toContain("parent-topic fact");
    expect(firstResult.entries.map((e) => e.text)).not.toContain("moved-topic fact");

    host.latest().complete("done");
    await firstHandle.result;


    const secondHandle = await runner.spawn({ prompt: "second", authority: MOVED_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    const secondInstance = getInstance(runner, secondHandle.id);
    expect(secondInstance?.authority).toEqual(MOVED_AUTHORITY);

    const secondSearch = findSearch(host.latest().invocations[0]?.customTools as unknown as unknown[]);
    expect(secondSearch).toBeDefined();
    const secondResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await secondSearch!.execute("ms-2", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(secondResult.entries.map((e) => e.text)).toContain("moved-topic fact");
    expect(secondResult.entries.map((e) => e.text)).not.toContain("parent-topic fact");

    host.latest().complete("done");
    await secondHandle.result;
  });

  it("recursively inherits the parent invocation's captured authority", async () => {
    await seedScopes(tmp);

    let capturedParentCapture: CapturedMemoryContext | undefined;
    const toolFactory: SubagentToolFactory = (subRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate) => {
      capturedParentCapture = parentCapture;
      return [createSpawnSubagentTool(subRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate, undefined)];
    };
    runner = new SubagentRunner(makeConfig(tmp), toolFactory, undefined, host);

    const parentHandle = await runner.spawn({ prompt: "parent", authority: PARENT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    expect(capturedParentCapture).toBeDefined();
    expect(capturedParentCapture!.authority).toEqual(PARENT_AUTHORITY);

    const parentTools = host.latest().invocations[0]?.customTools as unknown as Array<{
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }>;
    expect(parentTools.some((t) => t.name === "spawn_subagent")).toBe(true);

    host.latest().complete("done");
    await parentHandle.result;

    const spawnTool = createSpawnSubagentTool(
      runner,
      0,
      "sess-after-parent",
      capturedParentCapture!,
      EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    );

    const execPromise = spawnTool.execute("tc-nested", { prompt: "child" }, undefined, undefined, {} as never);
    await flush();

    const childId = runner.list()[0]?.id;
    expect(childId).toBeDefined();
    const childInstance = getInstance(runner, childId!);
    expect(childInstance?.authority).toEqual(PARENT_AUTHORITY);
    expect(childInstance?.authority).toBe(capturedParentCapture!.authority);

    host.latest().complete("done");
    await execPromise;
  });

  it("keeps named-agent persona identity out of the Surface authority", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");

    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      authority: DEFAULT_AUTHORITY,
    });
    await flush();

    const instance = getInstance(runner, handle.id);
    expect(instance?.caller).toEqual({ kind: "named-subagent", name: "researcher" });
    expect(instance?.authority).toEqual(DEFAULT_AUTHORITY);
    expect(instance?.authority.activeScope).toEqual(DEFAULT_SCOPE);
    expect("namedAgent" in instance!.authority.activeScope).toBe(false);
    expect(instance?.capture).toBeDefined();
    expect(instance?.capture?.caller).toEqual({ kind: "named-subagent", name: "researcher" });
    expect(instance?.capture?.authority.activeScope).toEqual(DEFAULT_SCOPE);

    host.latest().complete("done");
    await handle.result;
  });

  it("revival uses the reviving parent runtime's current authority, not the persisted origin Surface", async () => {
    await seedScopes(tmp);

    const firstHandle = await runner.spawn({ prompt: "first", authority: PARENT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().complete("done");
    await firstHandle.result;

    writeSessionFile(tmp, firstHandle.id, "2026-01-01T00-00-00.jsonl");

    const secondRunner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
    const revivePromise = secondRunner.revive(MOVED_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, firstHandle.id, "follow-up");
    await flush();

    const instance = getInstance(secondRunner, firstHandle.id);
    expect(instance?.authority).toEqual(MOVED_AUTHORITY);

    const search = findSearch(host.latest().invocations[0]?.customTools as unknown as unknown[]);
    expect(search).toBeDefined();
    const result = jsonOf<{ entries: Array<{ text: string }> }>(
      await search!.execute("ms-revived", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(result.entries.map((e) => e.text)).toContain("moved-topic fact");
    expect(result.entries.map((e) => e.text)).not.toContain("parent-topic fact");

    host.latest().complete("done");
    await revivePromise;
  });

  it("rejects spawn when given a legacy ActiveScope instead of SurfaceMemoryAuthority", async () => {
    const badAuthority = DEFAULT_SCOPE as unknown as typeof DEFAULT_AUTHORITY;
    await expect(
      runner.spawn({ prompt: "x", authority: badAuthority, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE }),
    ).rejects.toThrow("Subagent spawn requires a SurfaceMemoryAuthority");
  });

  it("rejects revival with an internal memory context", async () => {
    const internalCapture = {
      kind: "internal" as const,
      caller: { kind: "internal" as const },
    } as unknown as typeof DEFAULT_PARENT_CAPTURE;
    await expect(runner.revive(internalCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "any-id", "go")).rejects.toThrow(
      "Revival requires a Surface-backed parent memory context",
    );
  });
});

describe("Subagent tool factories — parent capture closure", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-tool-capture-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("revive_subagent tool closes over the parent capture", async () => {
    const id = "revive-tool-test";
    writeRecordAndSession(tmp, id, { id, kind: "generic-subagent", name: null, depth: 1, createdAt: new Date().toISOString(), invocations: [] }, "2026-01-01T00-00-00_tool.jsonl");

    const tool = createReviveSubagentTool(runner, DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE);
    const execPromise = tool.execute("tc-rev", { id, prompt: "hi" }, undefined, undefined, {} as never);
    await flush();

    const instance = getInstance(runner, id);
    expect(instance?.authority).toEqual(DEFAULT_AUTHORITY);

    host.latest().complete("done");
    await execPromise;
  });
});
