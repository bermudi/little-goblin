import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
import { runtimeSessionWithPreferences } from "../../sessions/mod.ts";
import type { SessionState } from "../../sessions/types.ts";
import { surfaceId, topicSurface, type Surface } from "../../surface.ts";
import { SubagentRunner, type SubagentInstance } from "../mod.ts";
import { createReviveSubagentTool, createSpawnSubagentTool } from "../tool.ts";
import {
  createTestHome,
  flush,
  getCapturedCreateArgs,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";

installStandardPiMock();

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
    async prompt() {
      return new Promise<void>((resolve) => {
        const listener = (event: Record<string, unknown>) => {
          if (event.type === "agent_end") {
            const index = sessionHolder.listeners.indexOf(listener as (event: Record<string, unknown>) => void);
            if (index !== -1) sessionHolder.listeners.splice(index, 1);
            resolve();
          }
        };
        sessionHolder.listeners.push(listener as (event: Record<string, unknown>) => void);
      });
    },
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
  memoryStore: MemoryStore;
}

function createFixture(): RuntimeFixture {
  const home = createTestHome("goblin-runtime-authority-");
  const cfg = makeConfig(home);
  const memoryStore = new MemoryStore(home);
  const surfaceSettings = { effectiveEnvironment: () => personalEnvironment() };

  const subagentRunner = new SubagentRunner(cfg, (subRunner, depth, sessionId, parentCapture, onStatusUpdate) => [
    createSpawnSubagentTool(subRunner, depth, sessionId, parentCapture, onStatusUpdate),
    createReviveSubagentTool(subRunner, parentCapture, onStatusUpdate),
  ]);

  const dispatcher = new TurnDispatcher({
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
  });

  const lifecycle = createConversationLifecycle(home, createTurnDispatcherRuntimeHost(dispatcher));
  dispatcher.setCurrentBindingGuard(lifecycle);

  return { home, lifecycle, dispatcher, subagentRunner, memoryStore };
}

async function makeSession(lifecycle: ConversationLifecycle, surface: Surface, home: string): Promise<SessionState> {
  const conv = await lifecycle.resolveOrStart(surface);
  return runtimeSessionWithPreferences(conv, surface, home);
}

describe("TurnDispatcher + SubagentRunner Surface authority integration", () => {
  let fx: RuntimeFixture;

  beforeEach(async () => {
    fx = createFixture();
    await seedScopes(fx.home);
    resetPiMockState();
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
    const childX = await fx.subagentRunner.spawn({ prompt: "child x", authority: captureX.authority });
    await flush();
    const childXInstance = getInstance(fx.subagentRunner, childX.id);
    expect(childXInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childXOpts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const childXTools = childXOpts.customTools as unknown[];
    const childXSearch = findTool(childXTools, "memory_search");
    expect(childXSearch).toBeDefined();
    const childXResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childXSearch!.execute("ms-child-x", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childXResult.entries.map((e) => e.text)).toContain("surface-x fact");
    expect(childXResult.entries.map((e) => e.text)).not.toContain("surface-y fact");

    // The spawn_subagent tool is wired in the subagent's tool list and closes
    // over the same Surface X capture.
    const childXSpawn = findTool(childXTools, "spawn_subagent");
    expect(childXSpawn).toBeDefined();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await childX.result;
  });

  it("replacement runtime captures destination Surface while source subagents retain source authority", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);
    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);

    // Start a subagent from the Surface X runtime.
    const childX = await fx.subagentRunner.spawn({ prompt: "child x", authority: captureX.authority });
    await flush();
    const childXInstance = getInstance(fx.subagentRunner, childX.id);
    expect(childXInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childXOpts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const childXTools = childXOpts.customTools as unknown[];
    const childXSearch = findTool(childXTools, "memory_search");
    const childXResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childXSearch!.execute("ms-child-x", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childXResult.entries.map((e) => e.text)).toContain("surface-x fact");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await childX.result;

    // Move the conversation to Surface Y. This disposes the X runner.
    const convY = await fx.lifecycle.resume(SURFACE_Y, sessionX.id);
    const sessionY = runtimeSessionWithPreferences(convY, SURFACE_Y, fx.home);

    // The source subagent retains Surface X authority even after the runtime is
    // torn down and the conversation moves to a different Surface.
    expect(getInstance(fx.subagentRunner, childX.id)?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    // Replacement runtime captures Surface Y.
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
    resetPiMockState();
    const childY = await fx.subagentRunner.spawn({ prompt: "child y", authority: captureY.authority });
    await flush();
    const childYInstance = getInstance(fx.subagentRunner, childY.id);
    expect(childYInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_Y));

    const childYOpts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const childYTools = childYOpts.customTools as unknown[];
    const childYSearch = findTool(childYTools, "memory_search");
    const childYResult = jsonOf<{ entries: Array<{ text: string }> }>(
      await childYSearch!.execute("ms-child-y", { scope: "active" }, undefined, undefined, {} as never),
    );
    expect(childYResult.entries.map((e) => e.text)).toContain("surface-y fact");
    expect(childYResult.entries.map((e) => e.text)).not.toContain("surface-x fact");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await childY.result;
  });

  it("recursively spawned subagents inherit the parent Surface authority and are cancelled by a same-conversation move", async () => {
    const sessionX = await makeSession(fx.lifecycle, SURFACE_X, fx.home);
    const runnerX = await fx.dispatcher.getOrCreateRunner(sessionX, SURFACE_X);
    const captureX = assertSurfaceCapture(runnerX.memoryContext);
    expect(captureX.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childX = await fx.subagentRunner.spawn({
      prompt: "child x",
      authority: captureX.authority,
      spawnedBy: sessionX.id,
    });
    await flush();
    const childXInstance = getInstance(fx.subagentRunner, childX.id);
    expect(childXInstance?.authority.sourceSurfaceId).toBe(surfaceId(SURFACE_X));

    const childXOpts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const childXTools = childXOpts.customTools as unknown[];
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
    await fx.lifecycle.resume(SURFACE_Y, sessionX.id);
    await flush();

    expect(getInstance(fx.subagentRunner, childX.id)?.status).toBe("cancelled");
    expect(grandchild!.status).toBe("cancelled");

    await spawnPromise;
    expect(spawnError).toBeInstanceOf(Error);
  });
});
