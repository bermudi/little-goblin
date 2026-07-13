import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { CascadeResult } from "../interrupt.ts";
import { SessionManager, type ChatLocator, type SessionState } from "../sessions/mod.ts";
import { sessionDir } from "../sessions/paths.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentInfo, SubagentRunner } from "../subagents/mod.ts";
import { cancelReply, formatCascadeTimeoutSuffix } from "./cancel.ts";
import { HELP_REPLY } from "./help.ts";
import {
  CANCEL_SUBAGENT_USAGE_REPLY,
  NO_SUBAGENTS_REPLY,
  REVIVE_SUBAGENT_USAGE_REPLY,
} from "./subagents.ts";
import { handleCommand, type DispatchDeps, type DispatchOpts, type DispatchResult } from "./dispatch.ts";

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
    voiceName: "en-US-AriaNeural",
    favorites: ["poe/GPT-4o"],
  };
}

function baseCascade(overrides: Partial<CascadeResult> = {}): CascadeResult {
  return {
    attemptedMain: false,
    attemptedSubagents: 0,
    attemptedExternalAgents: 0,
    timedOutMain: false,
    timedOutSubagents: 0,
    timedOutExternalAgents: 0,
    wedgedMain: false,
    ...overrides,
  };
}

function makeRunner(streaming = false): AgentRunner {
  return {
    modelName: "poe/GPT-4o",
    compact: mock(async () => ({ tokensBefore: 42_000 })),
    setModel: mock(async (_name: string) => {}),
    setThinkingLevel: mock(() => {}),
    getActiveToolNames: mock(() => []),
    skillsLoaded: null,
    contextTokens: null,
    contextFiles: null,
    isStreaming: streaming,
    isPrompting: false,
    isAbortTimedOut: false,
  } as unknown as AgentRunner;
}

type SubagentRunnerStub = Pick<SubagentRunner, "list" | "cancel" | "revive">;

function makeSubagentRunner(overrides: Partial<SubagentRunnerStub> = {}): SubagentRunner {
  return {
    list: mock(() => []),
    cancel: mock(async () => {}),
    revive: mock(async () => "revived response"),
    ...overrides,
  } as unknown as SubagentRunner;
}

function makeHarness(cascade = baseCascade(), subagentRunner = makeSubagentRunner()): {
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
      subagentRunner,
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
  return handleCommand({
    command: args.command,
    rawText: args.rawText ?? args.command,
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

describe("handleCommand", () => {
  it("replies to /cancel with an active session and invokes the cascade itself", async () => {
    const cascade = baseCascade({ attemptedMain: true });
    const harness = makeHarness(cascade);
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const runner = makeRunner(true); // streaming → cascade attempts the main runner
    const result = expectReplied(await dispatch({ command: "/cancel", session, runner, harness }));

    expect(result.reply).toBe(cancelReply({ cascade, cascadeTimeoutMs: 5_000 }));
    expect(result.sideEffects).toEqual([]);
    // /cancel is self-contained: it calls interruptAndCascade, not a dispatch pre-check.
    expect(harness.interrupt).toHaveBeenCalledWith(runner, expect.any(Object), 5_000, session.id, undefined);
  });

  it("replies to /cancel without a session (no cascade attempted)", async () => {
    const cascade = baseCascade();
    const harness = makeHarness(cascade);
    const result = expectReplied(await dispatch({ command: "/cancel", harness }));
    expect(result.reply).toBe("Nothing to cancel.");
    // Still invokes the cascade (with null session id) — but nothing was running,
    // so the reply reflects "Nothing to cancel."
    expect(harness.interrupt).toHaveBeenCalledWith(null, expect.any(Object), 5_000, null, undefined);
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

  it("/model switches the model in place without disposing the runner", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const runner = makeRunner();
    const result = expectReplied(await dispatch({ command: "/model", rawText: "/model 1", session, runner, harness }));
    expect(result.reply).toContain("Switched to `poe/GPT-4o`");
    // No dispose/recreate — the model change is applied to the live session
    // via setModel(), preserving history in the same pi session file.
    expect(result.sideEffects).toEqual([]);
    expect(runner.setModel).toHaveBeenCalledWith("poe/GPT-4o");
  });

  it("/model without a runner only persists the override", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    // No runner passed — session exists but runner not yet created.
    const result = expectReplied(await dispatch({ command: "/model", rawText: "/model 1", session, harness }));
    expect(result.reply).toContain("Switched to `poe/GPT-4o`");
    expect(result.sideEffects).toEqual([]);
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

  it("handles /help", async () => {
    expect(expectReplied(await dispatch({ command: "/help" })).reply).toBe(HELP_REPLY);
  });

  it("lists tracked subagents", async () => {
    const infos: SubagentInfo[] = [{
      id: "abc",
      name: "researcher",
      role: "named",
      status: "running",
      spawnedAt: "2026-06-21T00:00:00.000Z",
      spawnedBy: "session-1",
    }];
    const subagentRunner = makeSubagentRunner({
      list: mock(() => infos),
    });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/subagents", harness }));
    expect(result.reply).toContain("Tracked subagents:");
    expect(result.reply).toContain("abc (researcher) — running named");
  });

  it("reports when no subagents are tracked", async () => {
    expect(expectReplied(await dispatch({ command: "/subagents" })).reply).toBe(NO_SUBAGENTS_REPLY);
  });

  it("cancels a subagent by id", async () => {
    const cancel = mock(async () => {});
    const subagentRunner = makeSubagentRunner({ cancel });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/cancel_subagent", rawText: "/cancel_subagent abc", harness }));
    expect(result.reply).toBe("Cancelled subagent `abc`.");
    expect(cancel).toHaveBeenCalledWith("abc");
  });

  it("rejects /cancel_subagent without an id", async () => {
    expect(expectReplied(await dispatch({ command: "/cancel_subagent" })).reply).toBe(CANCEL_SUBAGENT_USAGE_REPLY);
  });

  it("surfaces cancel_subagent failures", async () => {
    const subagentRunner = makeSubagentRunner({
      cancel: mock(async () => { throw new Error("Subagent not found"); }),
    });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/cancel_subagent", rawText: "/cancel_subagent missing", harness }));
    expect(result.reply).toBe("Failed to cancel subagent `missing`: Subagent not found");
  });

  it("revives a subagent with an explicit prompt", async () => {
    const revive = mock(async () => "done");
    const subagentRunner = makeSubagentRunner({ revive });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/revive", rawText: "/revive abc inspect again", harness }));
    expect(result.reply).toBe("Revived subagent `abc`:\ndone");
    expect(revive).toHaveBeenCalledWith("abc", "inspect again");
  });

  it("rejects /revive without a prompt", async () => {
    const revive = mock(async () => "");
    const subagentRunner = makeSubagentRunner({ revive });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/revive", rawText: "/revive abc", harness }));
    expect(result.reply).toBe(REVIVE_SUBAGENT_USAGE_REPLY);
    expect(revive).not.toHaveBeenCalled();
  });

  it("rejects /revive without an id", async () => {
    expect(expectReplied(await dispatch({ command: "/revive" })).reply).toBe(REVIVE_SUBAGENT_USAGE_REPLY);
  });

  it("surfaces revive failures", async () => {
    const subagentRunner = makeSubagentRunner({
      revive: mock(async () => { throw new Error("Subagent not found"); }),
    });
    const harness = makeHarness(baseCascade(), subagentRunner);

    const result = expectReplied(await dispatch({ command: "/revive", rawText: "/revive missing try again", harness }));
    expect(result.reply).toBe("Failed to revive subagent `missing`: Subagent not found");
  });

  it("/voice returns handled when voice is sent", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const sendVoice = mock(async () => ({ message_id: 1 }));
    const bot = { api: { sendVoice } } as unknown as import("grammy").Bot;
    const dir = sessionDir(harness.cfg.goblinHome, session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({ role: "assistant", content: "Hi there." })}\n`,
    );
    const result = await handleCommand({
      command: "/voice",
      rawText: "/voice",
      deps: harness.deps,
      locator: harness.locator,
      isSupergroup: false,
      session,
      existingRunner: null,
      bot,
    });
    expect(result.kind).toBe("handled");
    expect(sendVoice).toHaveBeenCalled();
  }, 60_000);

  it("/voice does not interrupt the running turn", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const sendVoice = mock(async () => ({ message_id: 1 }));
    const bot = { api: { sendVoice } } as unknown as import("grammy").Bot;
    const dir = sessionDir(harness.cfg.goblinHome, session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({ role: "assistant", content: "Hi." })}\n`,
    );
    await handleCommand({
      command: "/voice",
      rawText: "/voice",
      deps: harness.deps,
      locator: harness.locator,
      isSupergroup: false,
      session,
      existingRunner: makeRunner(true),
      bot,
    });
    expect(harness.interrupt).not.toHaveBeenCalled();
  }, 60_000);

  it("/help reply includes /queue <text>", async () => {
    const result = expectReplied(await dispatch({ command: "/help" }));
    expect(result.reply).toContain("/queue <text>");
  });

  it("/queue while streaming enqueues a queue-prompt side effect and acknowledges Queued", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue do this after", session, runner: makeRunner(true), harness }));
    expect(result.reply).toBe("Queued. Will run after the current turn.");
    expect(result.sideEffects).toEqual([{ kind: "queue-prompt", session, text: "do this after" }]);
    expect(harness.interrupt).not.toHaveBeenCalled();
  });

  it("/queue while idle replies Running and emits a queue-prompt side effect", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue do this", session, runner: makeRunner(false), harness }));
    expect(result.reply).toBe("Running.");
    expect(result.sideEffects).toEqual([{ kind: "queue-prompt", session, text: "do this" }]);
    // Symmetric with the streaming-variant assertion: /queue is not
    // cancel-capable, so the interrupt cascade must never fire.
    expect(harness.interrupt).not.toHaveBeenCalled();
  });

  it("/queue without an argument replies usage and enqueues nothing", async () => {
    const harness = makeHarness();
    const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
    const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue", session, harness }));
    expect(result.reply).toBe("Usage: /queue <text>");
    expect(result.sideEffects).toEqual([]);
  });

  it("/queue without a session replies No active session.", async () => {
    const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue do something" }));
    expect(result.reply).toBe("No active session.");
    expect(result.sideEffects).toEqual([]);
  });

  it("returns fallthrough for unknown commands", async () => {
    expect(await dispatch({ command: "/foo" })).toEqual({ kind: "fallthrough" });
  });

  it("DispatchOpts has no ctx field (regression guard)", () => {
    // If `ctx` ever sneaks back into DispatchOpts, this object literal
    // fails TypeScript's excess-property check at compile time, and
    // the runtime check confirms the field is not actually present.
    const opts: DispatchOpts = {
      command: "/help",
      rawText: "/help",
      deps: makeHarness().deps,
      locator: { chatId: 1 },
      isSupergroup: false,
      session: null,
      existingRunner: null,
    };
    expect("ctx" in opts).toBe(false);
  });

  it("/cancel appends cascade timeout suffixes when subagents time out", async () => {
    const cascade = baseCascade({ attemptedSubagents: 1, timedOutSubagents: 1 });
    const harness = makeHarness(cascade);
    const result = expectReplied(await dispatch({ command: "/cancel", harness }));
    expect(result.reply).toContain(formatCascadeTimeoutSuffix(cascade, 5_000));
  });

  it("only /cancel ever cascades — state-mutating commands do not", async () => {
    // Regression guard: before the timing refactor, /new (and 8 others) ran
    // interruptAndCascade from a dispatch pre-check. Now only /cancel does.
    // Drive a /new through dispatch with a cascade mock and confirm it's untouched.
    const harness = makeHarness();
    await dispatch({ command: "/new", harness });
    expect(harness.interrupt).not.toHaveBeenCalled();
  });

  describe("DispatchResult.tag propagation", () => {
    it("/new success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const result = expectReplied(await dispatch({ command: "/new", harness }));
      expect(result.tag).toBe("ok");
    });

    it("/cancel 'Nothing to cancel.' is tagged 'info'", async () => {
      const harness = makeHarness();
      const result = expectReplied(await dispatch({ command: "/cancel", harness }));
      expect(result.tag).toBe("info");
    });

    it("/cancel 'Cancelled.' is tagged 'ok'", async () => {
      const cascade = baseCascade({ attemptedMain: true });
      const harness = makeHarness(cascade);
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const runner = makeRunner(true);
      const result = expectReplied(await dispatch({ command: "/cancel", session, runner, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/cancel when main is wedged is tagged 'error'", async () => {
      const cascade = baseCascade({ attemptedMain: true, wedgedMain: true });
      const harness = makeHarness(cascade);
      const result = expectReplied(await dispatch({ command: "/cancel", harness }));
      expect(result.tag).toBe("error");
    });

    it("/help is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/help" }));
      expect(result.tag).toBe("info");
    });

    it("/queue while streaming is tagged 'queued'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const runner = makeRunner(true);
      const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue do thing", session, runner, harness }));
      expect(result.tag).toBe("queued");
    });

    it("/queue while idle is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const runner = makeRunner(false);
      const result = expectReplied(await dispatch({ command: "/queue", rawText: "/queue do thing", session, runner, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/model list (no arg) is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/model", session, harness }));
      expect(result.tag).toBe("info");
    });

    it("/model switch is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const runner = makeRunner(false);
      const result = expectReplied(await dispatch({ command: "/model", rawText: "/model 1", session, runner, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/new failure is tagged 'error'", async () => {
      // Force createForChat to throw by archiving then making manager fail.
      const harness = makeHarness();
      const orig = harness.manager.createForChat.bind(harness.manager);
      harness.manager.createForChat = () => { throw new Error("boom"); };
      try {
        const result = expectReplied(await dispatch({ command: "/new", harness }));
        expect(result.tag).toBe("error");
      } finally {
        harness.manager.createForChat = orig;
      }
    });

    it("/subagents is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/subagents" }));
      expect(result.tag).toBe("info");
    });

    it("/cancel_subagent without id is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/cancel_subagent" }));
      expect(result.tag).toBe("info");
    });

    it("replied() without an explicit tag leaves tag undefined (defaults to 'ok' at the dispatch site)", async () => {
      // The spec says: "Command reply without explicit tag defaults to ok."
      // The default is applied at the intake dispatch site via
      // `sendSystemReply(message, result.reply, result.tag ?? "ok")`, so the
      // DispatchResult itself carries `tag: undefined` when omitted. This test
      // guards the contract: a handler that forgets to set a tag still gets
      // `[ok]` prefixed at the send site.
      const harness = makeHarness();
      const result = expectReplied(await dispatch({ command: "/new", harness }));
      // /new sets "ok" explicitly; verify the field is present and typed.
      expect(result.tag).toBe("ok");
      // A handler that omits tag produces `tag: undefined` — the dispatch
      // site's `?? "ok"` covers it. Simulate by checking the type permits
      // undefined: the field is `tag?: SystemTag`.
      const untagged: DispatchResult = { kind: "replied", reply: "x", sideEffects: [] };
      expect(untagged.tag).toBeUndefined();
    });

    it("/archive success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/archive", session, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/archive without a session is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/archive" }));
      expect(result.tag).toBe("info");
    });

    it("/project set is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/project", rawText: `/project ${harness.cfg.goblinHome}`, session, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/project without a session is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/project", rawText: "/project /tmp" }));
      expect(result.tag).toBe("info");
    });

    it("/project bad path is tagged 'warn'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/project", rawText: "/project /nonexistent/path/xyz", session, harness }));
      expect(result.tag).toBe("warn");
    });

    it("/project missing arg is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/project", rawText: "/project", session, harness }));
      expect(result.tag).toBe("info");
    });

    it("/compact success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const runner = makeRunner(false);
      const result = expectReplied(await dispatch({ command: "/compact", session, runner, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/compact without a session is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/compact" }));
      expect(result.tag).toBe("info");
    });

    it("/compact without a runner is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/compact", session, runner: null, harness }));
      expect(result.tag).toBe("info");
    });

    it("/name success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/name", rawText: "/name my-session", session, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/name without a session is tagged 'info'", async () => {
      const result = expectReplied(await dispatch({ command: "/name", rawText: "/name foo" }));
      expect(result.tag).toBe("info");
    });

    it("/name missing arg is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const result = expectReplied(await dispatch({ command: "/name", rawText: "/name", session, harness }));
      expect(result.tag).toBe("info");
    });

    it("/resume success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const target = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      harness.manager.setTitle(target.id, "my-target");
      const result = expectReplied(await dispatch({ command: "/resume", rawText: `/resume ${target.id}`, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/resume list (no arg) is tagged 'info'", async () => {
      const harness = makeHarness();
      const result = expectReplied(await dispatch({ command: "/resume", rawText: "/resume", harness }));
      expect(result.tag).toBe("info");
    });

    it("/resume not-found is tagged 'warn'", async () => {
      const harness = makeHarness();
      const result = expectReplied(await dispatch({ command: "/resume", rawText: "/resume nonexistent", harness }));
      expect(result.tag).toBe("warn");
    });

    it("/schedule list is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const { ScheduleStore } = await import("../scheduler/store.ts");
      const scheduleStore = new ScheduleStore(harness.cfg.goblinHome);
      harness.deps.scheduleStore = scheduleStore;
      const result = expectReplied(await dispatch({ command: "/schedule", rawText: "/schedule list", session, harness }));
      expect(result.tag).toBe("info");
    });

    it("/schedule at success is tagged 'ok'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const { ScheduleStore } = await import("../scheduler/store.ts");
      const scheduleStore = new ScheduleStore(harness.cfg.goblinHome);
      harness.deps.scheduleStore = scheduleStore;
      const future = new Date(Date.now() + 3600_000).toISOString();
      const result = expectReplied(await dispatch({ command: "/schedule", rawText: `/schedule at ${future} hello`, session, harness }));
      expect(result.tag).toBe("ok");
    });

    it("/schedule past time is tagged 'warn'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const { ScheduleStore } = await import("../scheduler/store.ts");
      const scheduleStore = new ScheduleStore(harness.cfg.goblinHome);
      harness.deps.scheduleStore = scheduleStore;
      const result = expectReplied(await dispatch({ command: "/schedule", rawText: "/schedule at 2000-01-01T00:00:00Z hello", session, harness }));
      expect(result.tag).toBe("warn");
    });

    it("/schedule usage (no sub) is tagged 'info'", async () => {
      const harness = makeHarness();
      const session = harness.manager.createForChat(harness.locator, { isSupergroup: false });
      const { ScheduleStore } = await import("../scheduler/store.ts");
      const scheduleStore = new ScheduleStore(harness.cfg.goblinHome);
      harness.deps.scheduleStore = scheduleStore;
      const result = expectReplied(await dispatch({ command: "/schedule", rawText: "/schedule", session, harness }));
      expect(result.tag).toBe("info");
    });
  });
});
