import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunner } from "../../agent/mod.ts";
import { createMemorySearchTool } from "../../memory/mod.ts";
import type { ActiveScope, CapturedMemoryContext, InternalMemoryContext } from "../../memory/mod.ts";
import { MemoryStore } from "../../memory/mod.ts";
import { activeMemoryScopeFor } from "../../memory/scope.ts";
import { createConversationLifecycle, type ConversationLifecycle } from "../../orchestration/conversation-lifecycle.ts";
import { createTurnDispatcherRuntimeHost } from "../../orchestration/conversation-runtime-host.ts";
import { TurnDispatcher, type TurnSink } from "../../orchestration/dispatcher.ts";
import { personalEnvironment } from "../../sessions/environment.ts";
import { DEFAULT_SKILL_POLICY } from "../../agent/skills/mod.ts";
import type { ConversationState } from "../../sessions/types.ts";
import { surfaceId, topicSurface, type Surface } from "../../surface.ts";
import { SubagentRunner, type SubagentInstance } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import { createReviveSubagentTool, createSpawnSubagentTool } from "../tool.ts";
import { genericSubagentDir } from "../paths.ts";
import {
  createTestHome,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
} from "./support.ts";

const SURFACE_X: Surface = topicSurface("supergroup", -100123, 1);
const SURFACE_Y: Surface = topicSurface("supergroup", -100123, 2);
const SCOPE_X: ActiveScope = { chatId: -100123, topicScope: { topicId: 1 } };
const SCOPE_Y: ActiveScope = { chatId: -100123, topicScope: { topicId: 2 } };

function assertSurfaceCapture(ctx: CapturedMemoryContext | InternalMemoryContext): CapturedMemoryContext {
  if (ctx.kind !== "surface") throw new Error("expected a Surface-backed memory context");
  return ctx;
}

function getInstance(runner: SubagentRunner, id: string): SubagentInstance | undefined {
  return (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(id);
}

function findInstanceBySpawnedBy(runner: SubagentRunner, spawnedBy: string): SubagentInstance | undefined {
  for (const inst of (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.values()) {
    if (inst.spawnedBy === spawnedBy) return inst;
  }
  return undefined;
}

function jsonOf<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text) as T;
}

function findTool(
  tools: unknown[],
  name: string,
): { name: string; execute: (...args: unknown[]) => Promise<unknown> } | undefined {
  return (tools as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>).find(
    (t) => t.name === name,
  );
}

function ensureSessionFile(home: string, id: string): void {
  const dir = genericSubagentDir(home, id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");
}

async function seedScopes(home: string): Promise<void> {
  const store = new MemoryStore(home);
  try {
    await store.add(activeMemoryScopeFor(SCOPE_X), "surface-x fact");
    await store.add(activeMemoryScopeFor(SCOPE_Y), "surface-y fact");
  } finally {
    store.close();
  }
  const xTopicId = (SCOPE_X.topicScope as { topicId: number }).topicId;
  const yTopicId = (SCOPE_Y.topicScope as { topicId: number }).topicId;
  mkdirSync(join(home, "state", "memory", "topics", String(SCOPE_X.chatId), String(xTopicId)), { recursive: true });
  mkdirSync(join(home, "state", "memory", "topics", String(SCOPE_Y.chatId), String(yTopicId)), { recursive: true });
}

function makeFakeAgentRunner(opts: ConstructorParameters<typeof AgentRunner>[0]): AgentRunner {
  const capture = assertSurfaceCapture(opts.memoryContext);
  return {
    memoryContext: capture,
    genericSubagentInheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    get isStreaming() {
      return false;
    },
    get isPrompting() {
      return false;
    },
    get isAbortTimedOut() {
      return false;
    },
    get modelName() {
      return "poe/test-model";
    },
    async prompt() {},
    async abort() {},
    async dispose() {},
    async followUp() {},
    async compact() {
      return {};
    },
    async setModel() {},
    setThinkingLevel() {},
  } as unknown as AgentRunner;
}

interface RuntimeFixture {
  home: string;
  lifecycle: ConversationLifecycle;
  dispatcher: TurnDispatcher;
  subagentRunner: SubagentRunner;
  subagentHost: FakeSubagentHost;
  memoryStore: MemoryStore;
}

function createFixture(): RuntimeFixture {
  const home = createTestHome("goblin-runtime-authority-");
  const cfg = makeConfig(home);
  const memoryStore = new MemoryStore(home);
  const surfaceSettings = {
    effectiveEnvironment: () => personalEnvironment(),
    getModelName: () => undefined,
    setModelName: () => {},
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
    getSkillPolicy: () => DEFAULT_SKILL_POLICY,
  };

  const subagentHost = new FakeSubagentHost();
  const subagentRunner = new SubagentRunner(cfg, (subRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate) => [
    createSpawnSubagentTool(subRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate),
    createReviveSubagentTool(subRunner, parentCapture, inheritedSkills, onStatusUpdate),
  ], undefined, subagentHost);

  let dispatcher: TurnDispatcher | undefined;
  const lifecycle = createConversationLifecycle(home, createTurnDispatcherRuntimeHost(() => {
    if (dispatcher === undefined) throw new Error("runtime host used before dispatcher construction");
    return dispatcher;
  }), surfaceSettings);
  dispatcher = new TurnDispatcher({
    cfg,
    surfaceSettings,
    subagentRunner,
    memoryStore,
    agentRunners: new Map(),
    createMessageBuffer: (): TurnSink => ({
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onStatusUpdate: () => {},
      onMessageStart: () => {},
      onMessageEnd: () => {},
      onAgentEnd: () => {},
    }),
    createBetaTools: () => [],
    createAgentRunner: (opts) => makeFakeAgentRunner(opts),
    surfaceRuntimeAuthority: lifecycle,
  });

  return { home, lifecycle, dispatcher, subagentRunner, subagentHost, memoryStore };
}

async function makeSession(lifecycle: ConversationLifecycle, surface: Surface, _home: string): Promise<ConversationState> {
  const conv = await lifecycle.resolveOrStart(surface);
  return conv;
}

describe("TurnDispatcher + SubagentRunner Surface authority integration", () => {
  let fx: RuntimeFixture;

  beforeEach(async () => {
    fx = createFixture();
    await seedScopes(fx.home);
  });

  afterEach(() => {
    fx.memoryStore.close();
    rmSync(fx.home, { recursive: true, force: true });
  });

  it("captures one Surface and keeps it frozen through main runtime tools and subagents", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);
    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);
    expect(captureX.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    // Main-runtime memory_search sees the Surface X capture.
    const mainSearch = createMemorySearchTool({
      store: fx.memoryStore,
      context: captureX,
    });
    const mainResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await mainSearch.execute("ms-main", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(mainResult.entries.map((e) => e.text)).toContain("surface-x fact");
    expect(mainResult.entries.map((e) => e.text)).not.toContain("surface-y fact");

    // First subagent inherits the Surface X authority.
    const childX = await fx.subagentRunner.spawn({ prompt: "child x", authority: captureX.authority, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    const childXInstance = getInstance(fx.subagentRunner, childX.id);
    expect(childXInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childXTools = fx.subagentHost.latest().invocations[0]?.customTools;
    if (childXTools === undefined) throw new Error("No invocation captured for childX");
    const childXSearch = findTool(childXTools as unknown[], "memory_search");
    expect(childXSearch).toBeDefined();
    const childXResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childXSearch!.execute("ms-child-x", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childXResult.entries.map((e) => e.text)).toContain("surface-x fact");
    expect(childXResult.entries.map((e) => e.text)).not.toContain("surface-y fact");

    // The spawn_subagent tool is wired in the subagent's tool list and closes
    // over the same Surface X capture.
    const childXSpawn = findTool(childXTools as unknown[], "spawn_subagent");
    expect(childXSpawn).toBeDefined();

    fx.subagentHost.latest().complete("done");
    await childX.result;
  });



  it("recursively spawned subagents are cancelled by a same-conversation move and the replacement runtime captures Surface Y tools", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);
    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);
    expect(captureX.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const mainXSearch = createMemorySearchTool({ store: fx.memoryStore, context: captureX });
    const mainXResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await mainXSearch.execute("ms-main-x", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(mainXResult.entries.map((e) => e.text)).toContain("surface-x fact");
    expect(mainXResult.entries.map((e) => e.text)).not.toContain("surface-y fact");

    const childX = await fx.subagentRunner.spawn({
      prompt: "child x",
      authority: captureX.authority,
      spawnedBy: sessionX.id,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    const childXInstance = getInstance(fx.subagentRunner, childX.id);
    expect(childXInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childXTools = fx.subagentHost.latest().invocations[0]?.customTools as unknown as unknown[];
    const childXSearch = findTool(childXTools, "memory_search");
    const childXResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childXSearch!.execute("ms-child-x", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childXResult.entries.map((e) => e.text)).toContain("surface-x fact");
    expect(childXResult.entries.map((e) => e.text)).not.toContain("surface-y fact");

    const childXSpawn = findTool(childXTools, "spawn_subagent");
    expect(childXSpawn).toBeDefined();

    let spawnError: unknown = undefined;
    const spawnPromise = childXSpawn!.execute(
      "gc-1",
      { prompt: "grandchild" },
      undefined,
      undefined,
      {} as never,
    ).catch((err: unknown) => {
      spawnError = err;
      return undefined;
    });
    await flush();

    const grandchild = findInstanceBySpawnedBy(fx.subagentRunner, childX.id);
    expect(grandchild).toBeDefined();
    expect(grandchild!.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    // Move the same conversation to Surface Y. The lifecycle disposes the
    // Surface X runtime, which cancels every subagent in the session tree.
    const convY = await fx.lifecycle.resume(SURFACE_Y, sessionX.id);
    await flush();

    expect(getInstance(fx.subagentRunner, childX.id)?.status).toBe("cancelled");
    expect(grandchild!.status).toBe("cancelled");

    await spawnPromise;
    expect(spawnError).toBeInstanceOf(Error);

    // The source tree keeps Surface X authority even after the runtime is gone.
    expect(getInstance(fx.subagentRunner, childX.id)?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    // Replacement runtime captures Surface Y.
    const sessionY = convY;
    const runnerY = await fx.dispatcher.getOrCreateRunner(sessionY, SURFACE_Y);
    const captureY = assertSurfaceCapture(runnerY.memoryContext);
    expect(captureY.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_Y));
    expect(captureY.authority.activeScope).toEqual(SCOPE_Y);

    const mainYSearch = createMemorySearchTool({
      store: fx.memoryStore,
      context: captureY,
    });
    const mainYResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await mainYSearch.execute("ms-main-y", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(mainYResult.entries.map((e) => e.text)).toContain("surface-y fact");
    expect(mainYResult.entries.map((e) => e.text)).not.toContain("surface-x fact");

    // A new subagent from the replacement runtime captures Surface Y.
    const childY = await fx.subagentRunner.spawn({
      prompt: "child y",
      authority: captureY.authority,
      spawnedBy: sessionY.id,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    const childYInstance = getInstance(fx.subagentRunner, childY.id);
    expect(childYInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_Y));

    const childYTools = fx.subagentHost.latest().invocations[0]?.customTools as unknown as unknown[];
    const childYSearch = findTool(childYTools, "memory_search");
    const childYResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childYSearch!.execute("ms-child-y", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childYResult.entries.map((e) => e.text)).toContain("surface-y fact");
    expect(childYResult.entries.map((e) => e.text)).not.toContain("surface-x fact");

    fx.subagentHost.latest().complete("done");
    await childY.result;
  });

  it("revived subagent attaches under the lifecycle guard and a same-conversation move cancels it before the terminal result", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);
    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);

    // Spawn and complete a child so it can be revived.
    const childX = await fx.subagentRunner.spawn({
      prompt: "child x",
      authority: captureX.authority,
      spawnedBy: sessionX.id,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    fx.subagentHost.latest().complete("done");
    await childX.result;
    ensureSessionFile(fx.home, childX.id);

    // Begin revival. The guard attaches, then the lifecycle transition proceeds
    // while the terminal result is still pending.
    const revivePromise = fx.dispatcher.reviveSubagent(SURFACE_X, sessionX, childX.id, "follow-up");
    revivePromise.catch(() => {});

    // Let the attachment signal fire.
    await flush();

    const convY = await fx.lifecycle.resume(SURFACE_Y, sessionX.id);
    await flush();

    await expect(revivePromise).rejects.toThrow(/cancelled/i);
    expect(getInstance(fx.subagentRunner, childX.id)?.status).toBe("cancelled");
    expect(fx.lifecycle.inspect(SURFACE_Y)?.id).toBe(sessionX.id);

    // Replacement runtime can still be created for Surface Y after the move.
    const sessionY = convY;
    const runnerY = await fx.dispatcher.getOrCreateRunner(sessionY, SURFACE_Y);
    const captureY = assertSurfaceCapture(runnerY.memoryContext);
    expect(captureY.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_Y));
  });

  it("corrupt or missing revival state releases the lifecycle transition lock", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);

    // No runner: the guarded callback throws before attachment, but the lock
    // must still be released so the next lifecycle transition can proceed.
    await expect(
      fx.dispatcher.reviveSubagent(SURFACE_X, sessionX, "missing", "go"),
    ).rejects.toThrow(/no current runner/);

    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);

    const childX = await fx.subagentRunner.spawn({
      prompt: "child x",
      authority: captureX.authority,
      spawnedBy: sessionX.id,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    fx.subagentHost.latest().complete("done");
    await childX.result;

    // Corrupt revival id: subagentRunner.revive fails before onAttached, the
    // attachment gate rejects, and the lock is released.
    await expect(
      fx.dispatcher.reviveSubagent(SURFACE_X, sessionX, "also-missing", "go"),
    ).rejects.toThrow(/Subagent not found/);

    // The lifecycle transition lock is free, so resume can proceed.
    const convY = await fx.lifecycle.resume(SURFACE_Y, sessionX.id);
    expect(fx.lifecycle.inspect(SURFACE_Y)?.id).toBe(sessionX.id);
    expect(convY).toBeDefined();
  });
});
