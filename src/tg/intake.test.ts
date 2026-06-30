import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { AgentRunner } from "../agent/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import { SessionManager, type ChatLocator } from "../sessions/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import {
  createTelegramIntake,
  replyNoActiveSession,
  type PromptContent,
  type TelegramIntakeMessage,
} from "./intake.ts";
import type { MessageBuffer } from "./mod.ts";

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

  it("uses thread id for topic tools while buffers stay locator-scoped", async () => {
    const cfg = makeConfig();
    const manager = new SessionManager(cfg);
    const agentRunners = new Map<string, AgentRunner>();
    const bufferLocators: ChatLocator[] = [];
    const editForumTopic = mock(async () => true);
    const bot = fakeBot(editForumTopic);
    let renameTool: { execute: (toolCallId: string, params: { title: string }) => Promise<unknown> } | undefined;
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
        const found = opts.customTools.find((tool) => tool.name === "rename_topic");
        if (found) {
          renameTool = found as unknown as { execute: (toolCallId: string, params: { title: string }) => Promise<unknown> };
        }
        return runner as unknown as AgentRunner;
      },
    });
    const message = makeMessage([], {
      locator: { chatId: -100, topicId: 42 },
      isSupergroup: true,
      threadId: 7,
    });

    await intake.handleText(message, "/new");
    await intake.handleText(message, "hello");
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);
    await renameTool?.execute("tool-call", { title: "Renamed" });

    expect(bufferLocators).toEqual([{ chatId: -100, topicId: 42 }]);
    expect(editForumTopic).toHaveBeenCalledWith(-100, 7, { name: "Renamed" });
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
});
