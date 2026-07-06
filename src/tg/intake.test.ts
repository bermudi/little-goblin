import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { AgentRunner } from "../agent/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import { SessionManager, type ChatLocator } from "../sessions/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { SchedulerLoop, type SchedulerClock } from "../scheduler/loop.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import {
  createTelegramIntake,
  replyNoActiveSession,
  type GuestMessage,
  type PromptContent,
  type TelegramIntakeMessage,
} from "./intake.ts";
import type { MessageBuffer } from "./mod.ts";
import type { GuestReplySink } from "./guest-sink.ts";
import type { InlineQueryResult } from "@grammyjs/types";

class MockAgentRunner {
  static nextPrompt?: (content: unknown, buffer: unknown) => Promise<void>;

  readonly sessionId: string;
  streaming = false;
  readonly prompt = mock(async (content: unknown, buffer: unknown) => {
    this.streaming = true;
    try {
      await MockAgentRunner.nextPrompt?.(content, buffer);
    } finally {
      this.streaming = false;
    }
  });
  static nextFollowUp?: (content: unknown) => Promise<void>;

  readonly followUp = mock(async (content: unknown) => {
    await MockAgentRunner.nextFollowUp?.(content);
  });
  readonly setModel = mock(async (_name: string) => {});
  readonly dispose = mock(() => {});
  readonly abort = mock(async () => {
    this.streaming = false;
  });
  readonly modelName?: string;

  constructor(opts: { sessionId: string; modelName?: string }) {
    this.sessionId = opts.sessionId;
    this.modelName = opts.modelName;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }
}

/** A GuestMessage capturing replyVia calls for assertions. */
function makeGuestMessage(chatId = 99): {
  message: GuestMessage;
  results: InlineQueryResult[];
  rejectNext: (err: Error) => void;
} {
  const results: InlineQueryResult[] = [];
  let pendingReject: Error | undefined;
  const message: GuestMessage = {
    chatId,
    replyVia: async (result) => {
      if (pendingReject) {
        const err = pendingReject;
        pendingReject = undefined;
        throw err;
      }
      results.push(result);
    },
  };
  return { message, results, rejectNext: (err) => { pendingReject = err; } };
}

interface IntakeHarness {
  cfg: Config;
  manager: SessionManager;
  agentRunners: Map<string, AgentRunner>;
  intake: ReturnType<typeof createTelegramIntake>;
  bot: Bot;
  bufferLocators: ChatLocator[];
  editForumTopic: ReturnType<typeof mock>;
}

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
let runners: MockAgentRunner[] = [];

function makeConfig(): Config {
  const goblinHome = mkdtempSync(join(tmpdir(), "goblin-intake-test-"));
  dirs.push(goblinHome);
  return {
    botToken: "123:token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/GPT-4o",
    poeApiKey: "poe-key",
    goblinHome,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

function fakeBot(editForumTopic = mock(async () => true)): Bot {
  return {
    api: {
      sendVoice: mock(async () => ({ message_id: 1 })),
      sendPhoto: mock(async () => ({ message_id: 1 })),
      sendDocument: mock(async () => ({ message_id: 1 })),
      editForumTopic,
    },
  } as unknown as Bot;
}

function fakeApi(): Bot["api"] {
  return {
    getFile: mock(async () => ({ file_path: "photos/x.jpg" })),
  } as unknown as Bot["api"];
}

/**
 * Install a `globalThis.fetch` mock that serves both the Telegram file download
 * (api.telegram.org) and the Groq ASR endpoint (api.groq.com). Returns the
 * Groq handler so a test can customize the transcription response.
 */
function installVoiceFetch(opts: {
  audio?: Uint8Array;
  groqStatus?: number;
  groqBody?: string;
  groqText?: string;
  groqError?: Error;
}): { groqCalls: number; downloadCalls: number } {
  const audio = opts.audio ?? new Uint8Array([1, 2, 3, 4]);
  const stats = { groqCalls: 0, downloadCalls: 0 };
  globalThis.fetch = mock(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.telegram.org")) {
      stats.downloadCalls += 1;
      return new Response(audio, { headers: { "content-length": String(audio.byteLength) } });
    }
    if (url.includes("api.groq.com")) {
      stats.groqCalls += 1;
      if (opts.groqError) throw opts.groqError;
      const status = opts.groqStatus ?? 200;
      const body = opts.groqBody ?? JSON.stringify({ text: opts.groqText ?? "hello from voice" });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return stats;
}

function makeHarness(cfg = makeConfig()): IntakeHarness {
  const manager = new SessionManager(cfg);
  const agentRunners = new Map<string, AgentRunner>();
  const bufferLocators: ChatLocator[] = [];
  const editForumTopic = mock(async () => true);
  const bot = fakeBot(editForumTopic);
  const intake = createTelegramIntake({
    cfg,
    bot,
    manager,
    subagentRunner: new SubagentRunner(cfg),
    memoryStore: new MemoryStore(cfg.goblinHome),
    agentRunners,
    createMessageBuffer: (locator) => {
      bufferLocators.push(locator);
      return {} as MessageBuffer;
    },
    createAgentRunner: (opts) => {
      const runner = new MockAgentRunner(opts);
      runners.push(runner);
      return runner as unknown as AgentRunner;
    },
  });
  return { cfg, manager, agentRunners, intake, bot, bufferLocators, editForumTopic };
}

function makeMessage(replies: string[] = [], overrides: Partial<TelegramIntakeMessage> = {}): TelegramIntakeMessage {
  return {
    locator: { chatId: 1 },
    isSupergroup: false,
    reply: async (text) => {
      replies.push(text);
    },
    prepare: (content: PromptContent): PromptContent => {
      if (typeof content === "string") return `[prepared] ${content}`;
      return [{ type: "text", text: "[prepared]" }, ...content];
    },
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function fixedClock(now: number): SchedulerClock {
  return {
    now: () => now,
    setInterval: () => ({ clear: () => {} }),
  };
}

beforeEach(() => {
  runners = [];
  MockAgentRunner.nextPrompt = undefined;
  MockAgentRunner.nextFollowUp = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Telegram intake", () => {
  it("handles command creation, idle prompts, and streaming steer without buildBot", async () => {
    const { manager, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");

    expect(manager.list()).toHaveLength(1);
    expect(replies[0]).toContain("Created new session");
    expect(runners).toHaveLength(1);

    await intake.handleText(message, "hello");
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    expect(runners[0]!.prompt).toHaveBeenCalledWith("[prepared] hello", expect.anything());

    runners[0]!.streaming = true;
    await intake.handleText(message, "steer this");

    expect(runners[0]!.followUp).toHaveBeenCalledWith("[prepared] steer this");
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
  });

  it("applies runner-disposing command side effects", async () => {
    const { cfg, agentRunners, intake, manager } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");
    const firstSession = manager.list()[0]!;
    const firstRunner = runners[0]!;

    await intake.handleText(message, "/archive");

    expect(firstRunner.dispose).toHaveBeenCalledTimes(1);
    expect(agentRunners.has(firstSession.id)).toBe(false);
    expect(replies.at(-1)).toContain("Session archived");

    await intake.handleText(message, "/new");
    const secondSession = manager.list().at(-1)!;
    const secondRunner = runners.at(-1)!;

    await intake.handleText(message, `/project ${cfg.goblinHome}`);

    expect(secondRunner.dispose).toHaveBeenCalledTimes(1);
    expect(agentRunners.has(secondSession.id)).toBe(false);
    expect(replies.at(-1)).toContain("Project bound");
  });

  it("queues /queue prompts behind active work at the intake seam", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await pending.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "/queue later");
    await flushMicrotasks();

    expect(replies.at(-1)).toContain("Queued");
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);

    expect(runners[0]!.prompt.mock.calls[1]![0]).toBe("[prepared] later");
  });

  it("replies for no-session DMs but not topic-scoped no-session drops", () => {
    const dmReplies: string[] = [];
    const topicReplies: string[] = [];

    replyNoActiveSession(makeMessage(dmReplies), { chatId: 1 }, "message");
    replyNoActiveSession(makeMessage(topicReplies), { chatId: 1, topicId: 42 }, "message");

    expect(dmReplies).toEqual(["No active session. Use /new to start one."]);
    expect(topicReplies).toEqual([]);
  });

  it("does not prompt stale photo work after a runner-disposing command", async () => {
    const { cfg, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    globalThis.fetch = mock(async () => {
      await pending.promise;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    }) as unknown as typeof fetch;

    await intake.handleText(message, "/new");
    await intake.handlePhoto(message, fakeApi(), ["small", "big"], "stale image");
    const staleRunner = runners[0]!;

    await intake.handleText(message, `/project ${cfg.goblinHome}`);

    pending.resolve();
    await flushMicrotasks();

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).not.toHaveBeenCalled();
  });

  it("handles document fallback without a project directory", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");
    await intake.handleDocument(message, fakeApi(), { fileId: "doc", fileName: "note.txt", caption: "read this" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    expect(runners[0]!.prompt.mock.calls[0]![0]).toBe("[prepared] read this");

    await intake.handleDocument(message, fakeApi(), { fileId: "doc", fileName: "note.txt" });
    await flushMicrotasks();

    expect(replies.at(-1)).toBe("No project directory is set. Use /project <path> to enable file saving.");
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
  });

  it("falls back to a fresh turn when a steer loses the streaming race", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };
    MockAgentRunner.nextFollowUp = async () => {
      throw new Error("Cannot steer: session is not streaming.");
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "steer this");
    await flushMicrotasks();

    expect(runners[0]!.followUp).toHaveBeenCalledWith("[prepared] steer this");
    // Fallback is queued behind the still-running first turn — not started yet.
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);

    slow.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);

    expect(runners[0]!.prompt.mock.calls[1]![0]).toBe("[prepared] steer this");
  });

  it("does not fall back when a steer fails for a non-race reason", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };
    MockAgentRunner.nextFollowUp = async () => {
      throw new Error("session disposed");
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "steer this");
    await flushMicrotasks();

    expect(runners[0]!.followUp).toHaveBeenCalledTimes(1);
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);

    slow.resolve();
    await flushMicrotasks();

    // No fresh turn scheduled even after the first settles.
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
  });

  it("queues a state-mutating command behind an in-flight turn and runs it after", async () => {
    // /model <n> is queue-timing: while streaming, it acks "Queued." and
    // defers; once the turn settles it runs and sends the follow-up reply.
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    // Sanity: the turn is in flight.
    expect(runners[0]!.isStreaming).toBe(true);

    await intake.handleText(message, "/model 1");
    await flushMicrotasks();

    // Instant ack; the switch has NOT happened yet (runner still on old model).
    expect(replies.at(-1)).toBe("Queued. Will run after this turn.");

    // Release the turn. The deferred command re-dispatches and replies.
    slow.resolve();
    await waitFor(() => replies.at(-1)!.startsWith("Switched to"));
    expect(replies.at(-1)).toContain("Switched to `poe/GPT-4o`");
  });

  it("runs an instant-timing command (read-only) while a turn is streaming", async () => {
    // /model with no arg is instant: it lists favorites without touching the turn.
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "/model");
    await flushMicrotasks();

    // The list reply lands instantly; the turn is still streaming, untouched.
    expect(replies.at(-1)).toContain("Favorites:");
    expect(runners[0]!.isStreaming).toBe(true);

    slow.resolve();
    await flushMicrotasks();
  });

  it("/cancel interrupts an in-flight turn rather than queueing", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "/cancel");
    await flushMicrotasks();

    // /cancel aborted the turn (MockAgentRunner.abort flips streaming false)
    // and replied — no "Queued." ack.
    expect(runners[0]!.abort).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)).toBe("Cancelled.");
    expect(runners[0]!.isStreaming).toBe(false);

    slow.resolve();
    await flushMicrotasks();
  });

  it("orphans a later-deferred command when an earlier /new swaps the runner", async () => {
    // When /new queues before /model, /new swaps out S1's runner before the
    // deferred /model continuation runs. The isCurrent() guard then drops
    // /model — setModel is not called and no "Switched to" reply arrives.
    // This pins the documented behavior so a future change to stale-runner
    // orphaning is intentional.
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    // /new FIRST: queues and will dispose S1 when it runs.
    await intake.handleText(message, "/new");
    await flushMicrotasks();
    // /model SECOND: queues behind /new on the same chain.
    await intake.handleText(message, "/model 1");
    await flushMicrotasks();

    slow.resolve();
    await waitFor(() => replies.at(-1)!.includes("Created new session"));

    // /new swapped the runner; the stale deferred /model never executed.
    expect(runners[0]!.setModel).not.toHaveBeenCalled();
    expect(replies.some((r) => r.startsWith("Switched to"))).toBe(false);
  });

  it("runs deferred commands in arrival order when the chain is intact", async () => {
    // Inverse of the orphan test: when /model queues before /new, the chain
    // preserves arrival order — /model runs first (S1 still current) and
    // succeeds, THEN /new runs and creates S2. No command is dropped.
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    await intake.handleText(message, "/model 1");
    await flushMicrotasks();
    await intake.handleText(message, "/new");
    await flushMicrotasks();

    slow.resolve();
    // /model succeeds first, then /new creates the second session.
    await waitFor(() => replies.filter((r) => r.startsWith("Switched to")).length === 1);
    await waitFor(() => replies.filter((r) => r.includes("Created new session")).length === 2);

    expect(runners[0]!.setModel).toHaveBeenCalledTimes(1);
    expect(replies.some((r) => r.startsWith("Switched to `poe/GPT-4o`"))).toBe(true);
  });

  it("surfaces a deferred command's handler failure as the canned reply", async () => {
    // modelHandler catches internal errors and returns a canned "Failed to
    // switch model." reply via the normal replied path — the deferred dispatch
    // delivers it as the follow-up. This confirms deferred failures don't
    // silently drop; the user sees the handler's error reply after the turn.
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    // setModel rejects; modelHandler's try/catch converts it to a canned reply.
    runners[0]!.setModel.mockImplementationOnce(async () => {
      throw new Error("provider key rejected");
    });

    await intake.handleText(message, "/model 1");
    await flushMicrotasks();
    expect(replies.at(-1)).toBe("Queued. Will run after this turn.");

    slow.resolve();
    await waitFor(() => replies.at(-1)!.startsWith("Failed"));

    // The canned error reply arrives after the turn settles.
    expect(replies.at(-1)).toBe("Failed to switch model. Please try again.");
  });

  it("shares per-session ordering between /queue and scheduled dispatch", async () => {
    // The dispatcher extraction requirement: Telegram `/queue` prompts and
    // scheduler-dispatched prompts must serialize through the same per-session
    // chain so a due scheduled turn cannot start while a queued prompt is in
    // flight. We drive both paths through the same dispatcher instance.
    const { intake, manager } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    const order: string[] = [];
    MockAgentRunner.nextPrompt = async (content) => {
      // Record the arrival order of each prompt's content.
      order.push(typeof content === "string" ? content : "[parts]");
      if (order.length === 1) await pending.promise;
    };

    await intake.handleText(message, "/new");
    const session = manager.list()[0]!;
    const dispatcher = intake.dispatcher;

    // 1. Start a slow Telegram turn.
    await intake.handleText(message, "first (telegram)");
    await waitFor(() => runners[0]!.isStreaming);

    // 2. Queue a /queue prompt behind it (Telegram path).
    await intake.handleText(message, "/queue second (queued)");
    await flushMicrotasks();

    // 3. Enqueue a scheduled turn on the SAME dispatcher (scheduler path).
    dispatcher.enqueueScheduledTurn(session, { chatId: 1 }, "third (scheduled)");
    await flushMicrotasks();

    // Only the first turn has started; the other two wait on the chain.
    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 3);

    // Both paths serialized through the same chain in enqueue order.
    expect(order[0]).toBe("[prepared] first (telegram)");
    expect(order[1]).toBe("[prepared] second (queued)");
    expect(order[2]).toBe("third (scheduled)");
  });

  it("queues a scheduler tick behind an active Telegram turn for the same session", async () => {
    const cfg = makeConfig();
    const { intake, manager } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const now = Date.parse("2026-07-04T12:00:00Z");
    const store = new ScheduleStore(cfg.goblinHome);
    const pending = deferred();
    const order: string[] = [];
    MockAgentRunner.nextPrompt = async (content) => {
      order.push(typeof content === "string" ? content : "[parts]");
      if (order.length === 1) await pending.promise;
    };

    await intake.handleText(message, "/new");
    const session = manager.list()[0]!;
    const schedule = store.create({
      sessionId: session.id,
      locator: { chatId: 1 },
      kind: "once",
      prompt: "scheduled while busy",
      nextRunAt: new Date(now - 1000).toISOString(),
    });
    const loop = new SchedulerLoop({
      store,
      manager,
      dispatcher: intake.dispatcher,
      clock: fixedClock(now),
      home: cfg.goblinHome,
    });

    await intake.handleText(message, "active telegram turn");
    await waitFor(() => runners[0]!.isStreaming);

    await loop.tick();
    await flushMicrotasks();

    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["[prepared] active telegram turn"]);
    expect(store.getForSession(session.id, schedule.id)!.lastRun?.outcome).toBe("ok");

    pending.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);

    expect(order).toEqual(["[prepared] active telegram turn", "scheduled while busy"]);
  });

  it("aborts a scheduled turn whose runner was swapped before it started", async () => {
    // Stale-runner guard on the scheduled-turn path: enqueue a scheduled turn
    // behind a slow in-flight turn, then dispose the runner (as /new would)
    // before the queued scheduled turn starts. The isCurrent() guard must
    // abort the scheduled turn without producing side effects — the scheduled
    // prompt never reaches the disposed runner.
    const { intake, manager, agentRunners } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => {
      await pending.promise; // keep the first turn in flight
    };

    await intake.handleText(message, "/new");
    const session = manager.list()[0]!;
    const dispatcher = intake.dispatcher;
    const firstRunner = runners[0]!;

    // Start a slow turn, then enqueue a scheduled turn behind it.
    await intake.handleText(message, "slow");
    await waitFor(() => firstRunner.isStreaming);
    dispatcher.enqueueScheduledTurn(session, { chatId: 1 }, "scheduled prompt");
    await flushMicrotasks();

    // Swap the runner out (as /new does) before the scheduled turn starts.
    dispatcher.disposeRunner(session.id);
    expect(agentRunners.has(session.id)).toBe(false);

    // Release the in-flight turn. The queued scheduled turn wakes, sees its
    // runner is no longer current, and aborts.
    pending.resolve();
    await flushMicrotasks();

    // The scheduled prompt never ran on the disposed runner.
    expect(firstRunner.prompt).toHaveBeenCalledTimes(1);
    expect(firstRunner.prompt.mock.calls[0]![0]).toBe("[prepared] slow");
    // No new runner was created for the scheduled turn (isCurrent() aborted).
    expect(dispatcher.runners.has(session.id)).toBe(false);
  });

  it("transcribes a voice message into a transcript prompt without a projectDir", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({ groqText: "take out the trash" });

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    expect(runners[0]!.prompt.mock.calls[0]![0]).toBe(
      "[prepared] [Voice message transcript]\ntake out the trash",
    );
    // No setup/failure reply on a clean transcription without projectDir.
    expect(replies.some((r) => r.includes("Groq ASR is not configured"))).toBe(false);
    expect(replies.some((r) => r.includes("couldn't transcribe"))).toBe(false);
    expect(replies.some((r) => r.startsWith("Saved voice-"))).toBe(false);
  });

  it("saves the voice file and prompts with transcript + saved-file note when projectDir is bound", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({ groqText: "hello project" });

    await intake.handleText(message, "/new");
    await intake.handleText(message, `/project ${cfg.goblinHome}`);
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await waitFor(() => {
      const last = runners.at(-1)!;
      return last.prompt.mock.calls.length === 1;
    });

    const runner = runners.at(-1)!;
    const promptArg = runner.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("[Voice message transcript]\nhello project");
    // Saved-file note names the voice file with its .oga extension.
    expect(promptArg).toMatch(/\[Voice file `voice-\d+\.oga` saved to project directory\.\]/);
    expect(replies.some((r) => /^Saved voice-\d+\.oga\.$/.test(r))).toBe(true);
  });

  it("replies with a setup message when groqApiKey is absent and does not prompt", async () => {
    // makeConfig() has no groqApiKey by default.
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({});

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await flushMicrotasks();

    expect(replies.some((r) => r.includes("Groq ASR is not configured"))).toBe(true);
    expect(runners[0]!.prompt).not.toHaveBeenCalled();
  });

  it("replies that the voice could not be transcribed on ASR failure and does not prompt", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({ groqStatus: 500, groqBody: '{"error":"internal"}' });

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await flushMicrotasks();

    expect(replies.some((r) => r.includes("couldn't transcribe"))).toBe(true);
    // The raw error body is not surfaced.
    expect(replies.some((r) => r.includes("internal"))).toBe(false);
    expect(runners[0]!.prompt).not.toHaveBeenCalled();
  });

  it("replies that no speech was detected on an empty transcript and does not prompt", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({ groqText: "   " });

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await flushMicrotasks();

    expect(replies.some((r) => r.includes("No speech was detected"))).toBe(true);
    expect(runners[0]!.prompt).not.toHaveBeenCalled();
  });

  it("defaults a missing mimeType to audio/ogg and still transcribes", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const stats = installVoiceFetch({ groqText: "no mime given" });

    await intake.handleText(message, "/new");
    // No mimeType on the voice input.
    await intake.handleVoice(message, fakeApi(), { fileId: "v1" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    expect(stats.groqCalls).toBe(1);
    expect(runners[0]!.prompt.mock.calls[0]![0]).toContain("[Voice message transcript]\nno mime given");
  });

  it("does not save, reply, or prompt stale voice work after a runner-disposing command", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    // Block the Groq call so the work is in-flight when the runner is swapped.
    const pending = deferred();
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.telegram.org")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
      }
      await pending.promise; // hold transcription open
      return new Response(JSON.stringify({ text: "stale" }), { status: 200 });
    }) as unknown as typeof fetch;

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    const staleRunner = runners[0]!;

    // Swap the runner out (as /new does) before transcription settles.
    await intake.handleText(message, "/new");

    pending.resolve();
    await flushMicrotasks();

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).not.toHaveBeenCalled();
    // The spec scenario "Stale ASR work does not side-effect" prohibits replies
    // too — assert the no-side-effect guarantee the test name claims.
    expect(replies.some((r) => r.includes("transcrib") || r.includes("No speech") || r.includes("Saved"))).toBe(false);
  });

  it("does not save the voice file for stale work when a projectDir is bound", async () => {
    // The no-projectDir stale test above can't exercise the "SHALL NOT save"
    // guarantee (saving is structurally impossible without a projectDir), so
    // this fixture binds a projectDir and asserts no voice file is written
    // when the runner is swapped before transcription settles.
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.telegram.org")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
      }
      await pending.promise;
      return new Response(JSON.stringify({ text: "stale" }), { status: 200 });
    }) as unknown as typeof fetch;

    await intake.handleText(message, "/new");
    await intake.handleText(message, `/project ${cfg.goblinHome}`);
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    const staleRunner = runners[0]!;

    // Swap the runner out before transcription settles.
    await intake.handleText(message, "/new");

    pending.resolve();
    await flushMicrotasks();

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).not.toHaveBeenCalled();
    // No voice file was written to the project directory.
    expect(replies.some((r) => r.startsWith("Saved voice-"))).toBe(false);
    const writtenVoices = readdirSync(cfg.goblinHome).filter((f) => /^voice-\d+\.oga$/.test(f));
    expect(writtenVoices).toEqual([]);
  });

  describe("handleGuestMessage", () => {
    it("replies once with the full accumulated text on success", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      MockAgentRunner.nextPrompt = async (_content, buffer) => {
        const sink = buffer as GuestReplySink;
        sink.onTextDelta("Hello, ");
        sink.onTextDelta("guest!");
      };

      await intake.handleGuestMessage(message, "[prepared] hi");

      expect(runners).toHaveLength(1);
      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.type).toBe("article");
      const article = r as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toBe("Hello, guest!");
    });

    it("passes the cleaned text to prompt (no prepare wrapper for guest)", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      let captured: unknown;
      MockAgentRunner.nextPrompt = async (content) => {
        captured = content;
      };

      await intake.handleGuestMessage(message, "raw guest text");

      expect(captured).toBe("raw guest text");
      expect(results[0]!.type).toBe("article");
    });

    it("replies with the fallback when agent output is empty", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      // No onTextDelta calls — sink.text stays empty.
      MockAgentRunner.nextPrompt = async () => {};

      await intake.handleGuestMessage(message, "hi");

      expect(results).toHaveLength(1);
      const article = results[0] as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toBe("(no response)");
    });

    it("sends a busy fallback without prompting when the runner is streaming", async () => {
      const { intake } = makeHarness();
      const pending = deferred();
      MockAgentRunner.nextPrompt = async () => { await pending.promise; };

      // First summon starts a streaming turn. Don't await it — it stays open.
      const first = intake.handleGuestMessage(makeGuestMessage().message, "first");
      await waitFor(() => runners[0]!.isStreaming);

      // Second summon while busy: must not prompt, must reply busy fallback.
      const { message: message2, results: results2 } = makeGuestMessage();
      await intake.handleGuestMessage(message2, "second");

      expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
      expect(results2).toHaveLength(1);
      const article = results2[0] as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toContain("already thinking");

      pending.resolve();
      await first;
      await flushMicrotasks();
    });

    it("replies with the error fallback when prompt rejects", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      MockAgentRunner.nextPrompt = async () => { throw new Error("model down"); };

      await intake.handleGuestMessage(message, "hi");

      expect(results).toHaveLength(1);
      const article = results[0] as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toBe("⚠️ Something went wrong.");
    });

    it("swallows a replyVia rejection without throwing", async () => {
      const { intake } = makeHarness();
      const { message, results, rejectNext } = makeGuestMessage();
      rejectNext(new Error("guest_query_id expired"));
      MockAgentRunner.nextPrompt = async (_c, buffer) => {
        (buffer as GuestReplySink).onTextDelta("text");
      };

      // Must not throw — the expired id is an inherent limitation.
      await expect(intake.handleGuestMessage(message, "hi")).resolves.toBeUndefined();
      expect(results).toHaveLength(0);
    });

    it("swallows a replyVia rejection on the error-fallback path too", async () => {
      const { intake } = makeHarness();
      const { message, results, rejectNext } = makeGuestMessage();
      rejectNext(new Error("expired"));
      MockAgentRunner.nextPrompt = async () => { throw new Error("turn failed"); };

      await expect(intake.handleGuestMessage(message, "hi")).resolves.toBeUndefined();
      expect(results).toHaveLength(0);
    });

    it("auto-creates a guest session keyed on the foreign chat id", async () => {
      const { intake, manager } = makeHarness();
      const { message, results } = makeGuestMessage(7777);
      MockAgentRunner.nextPrompt = async () => {};

      await intake.handleGuestMessage(message, "first");

      // A guest binding for chat 7777 now exists.
      expect(manager.peekBinding({ chatId: 7777 }, { isGuest: true })).not.toBeNull();
      // And NOT a DM binding for the same id.
      expect(manager.peekBinding({ chatId: 7777 })).toBeNull();
      expect(results).toHaveLength(1);
    });

    it("reuses the same guest session on a second summon from the same chat", async () => {
      const { intake, manager } = makeHarness();
      MockAgentRunner.nextPrompt = async (_c, buffer) => {
        (buffer as GuestReplySink).onTextDelta("ack");
      };

      await intake.handleGuestMessage(makeGuestMessage(7777).message, "first");
      const firstSession = manager.peekBinding({ chatId: 7777 }, { isGuest: true });
      expect(firstSession).not.toBeNull();

      await intake.handleGuestMessage(makeGuestMessage(7777).message, "second");
      const secondSession = manager.peekBinding({ chatId: 7777 }, { isGuest: true });

      expect(secondSession!.sessionId).toBe(firstSession!.sessionId);
      // Only one session was ever created.
      expect(manager.list().filter((s) => s.chatId === 7777)).toHaveLength(1);
    });

    it("each InlineQueryResult article has a unique id and a title", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      MockAgentRunner.nextPrompt = async (_c, buffer) => {
        (buffer as GuestReplySink).onTextDelta("x");
      };

      await intake.handleGuestMessage(message, "a");
      await intake.handleGuestMessage(makeGuestMessage().message, "b");

      const ids = results.map((r) => (r as { id: string }).id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of results) {
        expect((r as { title: string }).title).toBe("Goblin");
      }
    });
  });
});
