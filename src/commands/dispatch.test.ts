import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import type { Config } from "../config.ts";
import type { CascadeResult } from "../interrupt.ts";
import { SessionManager, type ChatLocator, type SessionState } from "../sessions/mod.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import { cancelReply, formatCascadeTimeoutSuffix } from "./cancel.ts";
import { HELP_REPLY } from "./help.ts";
import { SUBAGENT_STUB_REPLY } from "./subagents.ts";
import { handleCancelCapableCommand, type DispatchDeps, type DispatchResult } from "./dispatch.ts";

const dirs: string[] = [];

function makeConfig(): Config {
  const goblinHome = mkdtempSync(join(tmpdir(), "goblin-dispatch-test-"));
  dirs.push(goblinHome);
  return {
    botToken: "token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/GPT-4o",
    poeApiKey: "poe-key",
    openaiApiKey: "openai-key",
    goblinHome,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    favorites: ["poe/GPT-4o"],
  };
}

function baseCascade(overrides: Partial<CascadeResult> = {}): CascadeResult {
  return {
    attemptedMain: false,
    attemptedSubagents: 0,
    timedOutMain: false,
    timedOutSubagents: 0,
    ...overrides,
  };
}

function makeRunner(): AgentRunner {
  return {
    modelName: "poe/GPT-4o",
    compact: mock(async () => ({ tokensBefore: 42_000 })),
    setThinkingLevel: mock(() => {}),
    getActiveToolNames: mock(() => []),
    skillsLoaded: null,
    contextTokens: null,
    contextFiles: null,
  } as unknown as AgentRunner;
}

function makeHarness(cascade = baseCascade()): {
  cfg: Config;
  manager: SessionManager;
  locator: ChatLocator;
  deps: DispatchDeps;
  interrupt: ReturnType<typeof mock>;
} {
  const cfg = makeConfig();
  const manager = new SessionManager(cfg);
  const interrupt = mock(async () => cascade);
  return {
    cfg,
    manager,
    locator: { chatId: 123 },
    interrupt,
    deps: {
      manager,
      cfg,
      subagentRunner: { list: mock(() => []) } as unknown as SubagentRunner,
      tryResolveModel: mock(() => undefined),
      interruptAndCascade: interrupt as unknown as DispatchDeps["interruptAndCascade"],
    },
  };
}

async function dispatch(args: {
  command: string;
  rawText?: string;
  session?: SessionState | null;
  runner?: AgentRunner | null;
  harness?: ReturnType<typeof makeHarness>;
}): Promise<DispatchResult> {
  const harness = args.harness ?? makeHarness();
  return handleCancelCapableCommand({
    command: args.command,
    rawText: args.rawText ?? args.command,
    ctx: {} as Context,
    deps: harness.deps,
    locator: harness.locator,
    isSupergroup: false,
    session: args.session ?? null,
    existingRunner: args.runner ?? null,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectReplied(result: DispatchResult): Extract<DispatchResult, { kind: "replied" }> {
  expect(result.kind).toBe("replied");
  return result as Extract<DispatchResult, { kind: "replied" }>;
}

describe("handleCancelCapableCommand", () => {
  it("replies to /cancel with an active session", async () => {
    const harness = makeHarness(baseCascade({ attemptedMain: true }));
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/cancel", session, runner: makeRunner(), harness }));

    expect(result.reply).toBe(cancelReply({ hasSession: true, cascade: baseCascade({ attemptedMain: true }), cascadeTimeoutMs: 5_000 }));
    expect(result.sideEffects).toEqual([]);
  });

  it("replies to /cancel without a session", async () => {
    const result = expectReplied(await dispatch({ command: "/cancel" }));
    expect(result.reply).toBe("Nothing to cancel.");
  });

  it("/new with a prior session disposes prior and creates a new runner", async () => {
    const harness = makeHarness();
    const prior = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/new", session: prior, harness }));

    expect(result.sideEffects.map((e) => e.kind)).toEqual(["runner-disposed", "runner-created"]);
    expect(result.sideEffects[0]).toEqual({ kind: "runner-disposed", sessionId: prior.id });
  });

  it("/new without a prior session only creates a runner", async () => {
    const result = expectReplied(await dispatch({ command: "/new" }));
    expect(result.sideEffects.map((e) => e.kind)).toEqual(["runner-created"]);
  });

  it("/new executor failures become the canned reply", async () => {
    const harness = makeHarness();
    harness.deps.manager = { createForChat: () => { throw new Error("boom"); } } as unknown as SessionManager;
    const result = expectReplied(await dispatch({ command: "/new", harness }));
    expect(result.reply).toBe("Failed to reset session. Please try again.");
  });

  it("/archive with an active session archives and disposes", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/archive", session, harness }));
    expect(result.sideEffects).toEqual([{ kind: "runner-disposed", sessionId: session.id }]);
  });

  it("/archive without a session has no side effects", async () => {
    const result = expectReplied(await dispatch({ command: "/archive" }));
    expect(result.reply).toBe("No active session to archive.");
    expect(result.sideEffects).toEqual([]);
  });

  it("/project changes project dir and disposes the runner", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/project", rawText: `/project ${harness.cfg.goblinHome}`, session, harness }));
    expect(result.sideEffects).toEqual([{ kind: "runner-disposed", sessionId: session.id }]);
  });

  it("/model switches favorites and disposes the runner", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/model", rawText: "/model 1", session, harness }));
    expect(result.reply).toContain("Switched to `poe/GPT-4o`");
    expect(result.sideEffects).toEqual([{ kind: "runner-disposed", sessionId: session.id }]);
  });

  it("/model lists favorites without an argument", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/model", session, harness }));
    expect(result.reply).toContain("Favorites:");
  });

  it("/think updates the existing runner without disposing it", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const runner = makeRunner();
    const result = expectReplied(await dispatch({ command: "/think", rawText: "/think high", session, runner, harness }));
    expect(result.sideEffects).toEqual([]);
    expect(runner.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("/debug reports diagnostics for active sessions", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/debug", session, runner: makeRunner(), harness }));
    expect(result.reply).toContain(`Session: ${session.id}`);
  });

  it("/debug without a session replies no active session", async () => {
    const result = expectReplied(await dispatch({ command: "/debug" }));
    expect(result.reply).toBe("No active session.");
  });

  it("/compact calls compact on the existing runner", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const runner = makeRunner();
    const result = expectReplied(await dispatch({ command: "/compact", session, runner, harness }));
    expect(result.reply).toBe("Compacted from ~42K tokens.");
    expect(runner.compact).toHaveBeenCalled();
  });

  it("/compact without a session replies no active session", async () => {
    const result = expectReplied(await dispatch({ command: "/compact" }));
    expect(result.reply).toBe("No active session to compact.");
  });

  it("/name sets title without runner side effects", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/name", rawText: "/name foo", session, harness }));
    expect(result.reply).toBe(`Named session \`${session.id}\`: foo`);
    expect(result.sideEffects).toEqual([]);
  });

  it("/resume disposes prior and creates the resumed runner", async () => {
    const harness = makeHarness();
    const prior = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const target = harness.manager.createForChat({ chatId: 456 }, { isSupergroup: false });
    harness.manager.setTitle(target.id, "target");
    const result = expectReplied(await dispatch({ command: "/resume", rawText: `/resume ${target.id}`, session: prior, harness }));
    expect(result.sideEffects.map((e) => e.kind)).toEqual(["runner-disposed", "runner-created"]);
    expect(result.sideEffects[0]).toEqual({ kind: "runner-disposed", sessionId: prior.id });
  });

  it("/resume of the already-bound session still disposes before recreating", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/resume", rawText: `/resume ${session.id}`, session, harness }));
    expect(result.sideEffects.map((e) => e.kind)).toEqual(["runner-disposed", "runner-created"]);
    expect(result.sideEffects[0]).toEqual({ kind: "runner-disposed", sessionId: session.id });
  });

  it("/resume without an argument lists named sessions", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    harness.manager.setTitle(session.id, "foo");
    const result = expectReplied(await dispatch({ command: "/resume", session, harness }));
    expect(result.reply).toContain("Named sessions:");
  });

  it("handles non-cancel helper commands", async () => {
    expect(expectReplied(await dispatch({ command: "/help" })).reply).toBe(HELP_REPLY);
    expect(expectReplied(await dispatch({ command: "/subagents" })).reply).toBe(SUBAGENT_STUB_REPLY);
    expect(expectReplied(await dispatch({ command: "/cancel_subagent", rawText: "/cancel_subagent abc" })).reply).toBe(SUBAGENT_STUB_REPLY);
    expect(expectReplied(await dispatch({ command: "/revive", rawText: "/revive abc" })).reply).toBe(SUBAGENT_STUB_REPLY);
  });

  it("returns fallthrough for unknown commands", async () => {
    expect(await dispatch({ command: "/foo" })).toEqual({ kind: "fallthrough" });
  });

  it("appends cascade timeout suffixes to cancel-capable replies", async () => {
    const cascade = baseCascade({ attemptedSubagents: 1, timedOutSubagents: 1 });
    const harness = makeHarness(cascade);
    const result = expectReplied(await dispatch({ command: "/new", harness }));
    expect(result.reply).toContain(formatCascadeTimeoutSuffix(cascade, 5_000));
  });
});
