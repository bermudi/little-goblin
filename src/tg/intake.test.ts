import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentsPath, soulMdPath, workspacePath } from "../workspace/paths.ts";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { PreparedSurfaceRuntimePlan } from "../agent/runtime-plan.ts";
import { log } from "../log.ts";
import { MemoryStore } from "../memory/mod.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import type { ConversationState } from "../sessions/types.ts";
import { InternalSessionStore } from "../sessions/internal-session-store.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, guestSurface, surfaceId, topicSurface, type Surface } from "../surface.ts";
import { metricsPath, transcriptPath } from "../sessions/paths.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { CapturedMemoryContext, InternalMemoryContext } from "../memory/mod.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { createConversationOrchestration } from "../orchestration/composition.ts";
import type { EmbeddingProvider, DreamingPipeline } from "../memory/mod.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import { DelegatedWorkHost } from "../delegated-work/mod.ts";
import type { TurnSink } from "../orchestration/dispatcher.ts";
import { SchedulerLoop, type SchedulerClock } from "../scheduler/loop.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import { UpdateGate, type UpdateHandle } from "../shutdown/mod.ts";
import {
  createTelegramIntake,
  replyNoActiveSession,
  type GuestMessage,
  type PromptContent,
  type TelegramIntakeMessage,
} from "./intake.ts";
import type { MessageBuffer } from "./mod.ts";
import { createTelegramRuntimeAdapters } from "./runtime-adapters.ts";
import type { GuestReplySink } from "./guest-sink.ts";
import type { InlineQueryResult } from "@grammyjs/types";

class MockAgentRunner {
  static nextPrompt?: (content: unknown, buffer: unknown) => Promise<void>;

  readonly sessionId: string;
  readonly memoryContext: CapturedMemoryContext | InternalMemoryContext;
  streaming = false;
  abortTimedOut = false;
  abortBeforeInit = false;
  isPrompting = false;
  readonly prompt = mock(async (content: unknown, buffer: unknown) => {
    if (this.abortBeforeInit) {
      this.abortBeforeInit = false;
      throw new Error("Turn aborted before it started.");
    }
    this.isPrompting = true;
    this.streaming = true;
    try {
      await MockAgentRunner.nextPrompt?.(content, buffer);
    } finally {
      this.streaming = false;
      this.isPrompting = false;
    }
  });
  static nextFollowUp?: (content: unknown) => Promise<void> | void;

  readonly followUp = mock((content: unknown): Promise<void> => {
    const next = MockAgentRunner.nextFollowUp?.(content);
    return next ?? Promise.resolve();
  });
  readonly setModel = mock(async (_name: string) => {});
  readonly dispose = mock(() => {});
  readonly abort = mock(async () => {
    if (!this.streaming) this.abortBeforeInit = true;
    this.streaming = false;
  });
  readonly markAbortTimedOut = mock(() => {
    this.abortTimedOut = true;
  });
  readonly modelName?: string;

  constructor(opts: {
    sessionId: string;
    plan?: PreparedSurfaceRuntimePlan;
    modelName?: string;
    memoryContext?: CapturedMemoryContext | InternalMemoryContext;
  }) {
    this.sessionId = opts.sessionId;
    this.modelName = opts.plan?.modelName ?? (opts.plan === undefined ? opts.modelName : undefined);
    this.memoryContext = opts.plan?.memoryContext ?? (opts.plan === undefined ? opts.memoryContext : undefined) ?? {
      kind: "surface",
      authority: {
        kind: "surface",
        sourceSurfaceId: surfaceId(dmSurface(1)),
        activeScope: { chatId: 1, topicScope: "general" },
      },
      caller: { kind: "main" },
      frozenSummary: null,
      frozenUserBody: "",
      frozenActiveMemoryBody: "",
    };
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get isAbortTimedOut(): boolean {
    return this.abortTimedOut;
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
    surface: guestSurface(chatId),
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

interface TestIntakeOptions {
  cfg: Config;
  bot: Bot;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  embeddingProvider?: EmbeddingProvider;
  dreamingPipeline?: DreamingPipeline;
  createMessageBuffer?: (surface: Surface, conversation?: ConversationState) => TurnSink;
  scheduleStore?: ScheduleStore;
  externalAgentRunner?: ExternalAgentRunner;
  delegatedWorkHost?: DelegatedWorkHost;
}

type TestIntake = ReturnType<typeof createTelegramIntake> & {
  readonly runtimeHost: ReturnType<typeof createConversationOrchestration>["runtimeHost"];
};

function createTestIntake(options: TestIntakeOptions): TestIntake {
  const adapters = createTelegramRuntimeAdapters({
    cfg: options.cfg,
    bot: options.bot,
    memoryStore: options.memoryStore,
    createMessageBuffer: options.createMessageBuffer,
  });
  const orchestration = createConversationOrchestration({
    cfg: options.cfg,
    subagentRunner: options.subagentRunner,
    memoryStore: options.memoryStore,
    createAgentRunner: options.createAgentRunner,
    embeddingProvider: options.embeddingProvider,
    dreamingPipeline: options.dreamingPipeline,
    createMessageBuffer: adapters.createMessageBuffer,
    createBetaTools: adapters.createBetaTools,
    scheduleStore: options.scheduleStore,
    externalAgentRunner: options.externalAgentRunner,
  });
  const gate = new UpdateGate({
    closeCoalescer: async () => {},
    awaitBufferedTextAdmission: async () => {},
  });
  const intake = createTelegramIntake({
    cfg: options.cfg,
    bot: options.bot,
    subagentRunner: options.subagentRunner,
    memoryStore: options.memoryStore,
    dispatcher: orchestration.dispatcher,
    lifecycle: orchestration.lifecycle,
    scheduleStore: options.scheduleStore,
    externalAgentRunner: options.externalAgentRunner,
    gate,
  });
  return Object.assign(intake, { runtimeHost: orchestration.runtimeHost });
}

interface IntakeHarness {
  cfg: Config;
  conversationStore: ConversationStore;
  runtimeHost: ReturnType<typeof createConversationOrchestration>["runtimeHost"];
  intake: ReturnType<typeof createTelegramIntake> & { lifecycle: ConversationLifecycle };
  bot: Bot;
  bufferLocators: Surface[];
  editForumTopic: ReturnType<typeof mock>;
  subagentRunner: SubagentRunner;
}

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
let runners: MockAgentRunner[] = [];

function makeConfig(): Config {
  const goblinHome = mkdtempSync(join(tmpdir(), "goblin-intake-test-"));
  mkdirSync(workspacePath(goblinHome), { recursive: true });
  writeFileSync(soulMdPath(goblinHome), "test goblin identity\n", "utf-8");
  dirs.push(goblinHome);
  return {
    botToken: "123:token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/GPT-4o",
    poeApiKey: "poe-key",
    goblinHome,
    logLevel: "error",
    toolVisibility: "standard",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

function fakeBot(editForumTopic = mock(async () => true)): Bot {
  return {
    api: {
      sendMessage: mock(async (_chatId, text) => ({ message_id: 1, date: 1, chat: { id: 1, type: "private" }, text })),
      sendChatAction: mock(async () => true),
      sendVoice: mock(async () => ({ message_id: 1 })),
      sendPhoto: mock(async () => ({ message_id: 1 })),
      sendDocument: mock(async () => ({ message_id: 1 })),
      editMessageText: mock(async () => true),
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

function makeHarness(cfg = makeConfig(), subagentRunner: SubagentRunner = new SubagentRunner(cfg)): IntakeHarness {
  const conversationStore = new ConversationStore(cfg.goblinHome);
  const bufferLocators: Surface[] = [];
  const editForumTopic = mock(async () => true);
  const bot = fakeBot(editForumTopic);
  const testIntake = createTestIntake({
    cfg,
    bot,
    subagentRunner,
    memoryStore: new MemoryStore(cfg.goblinHome),
    createMessageBuffer: (surface) => {
      bufferLocators.push(surface);
      return {} as MessageBuffer;
    },
    createAgentRunner: (opts) => {
      const runner = new MockAgentRunner(opts);
      runners.push(runner);
      return runner as unknown as AgentRunner;
    },
  });
  return {
    cfg,
    conversationStore,
    runtimeHost: testIntake.runtimeHost,
    intake: testIntake,
    bot,
    bufferLocators,
    editForumTopic,
    subagentRunner,
  };
}

function registerTestRunner(
  runtimeHost: ReturnType<typeof createConversationOrchestration>["runtimeHost"],
  conversationId: string,
  runner: AgentRunner,
): void {
  // Match the real usage pattern: reserve a creation, then register.
  const creation = runtimeHost.reserveCreation(conversationId, surfaceId(dmSurface(1)), "test-settings");
  try {
    runtimeHost.registerSurfaceRuntime(conversationId, runner, {
      surfaceId: surfaceId(dmSurface(1)),
      runtimeId: DelegatedWorkHost.newRuntimeId(),
      skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "test", manifestFingerprint: null },
    });
  } finally {
    creation.complete();
  }
}

function makeMessage(replies: string[] = [], overrides: Partial<TelegramIntakeMessage> = {}): TelegramIntakeMessage {
  return {
    surface: dmSurface(1),
    reply: async (text, _opts) => {
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

function readTranscriptLines(home: string, sessionId: string): unknown[] {
  const path = transcriptPath(home, sessionId);
  if (!path) return [];
  const content = readFileSync(path, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
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
    const { conversationStore, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");

    expect(conversationStore.list()).toHaveLength(1);
    expect(replies[0]).toContain("Created new conversation");
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
    const { cfg, runtimeHost, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");
    const firstConversation = intake.lifecycle.inspect(dmSurface(1))!;
    const firstRunner = runners[0]!;

    await intake.handleText(message, "/archive");

    expect(firstRunner.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeHost.hasRunner(firstConversation.id)).toBe(false);
    expect(replies.at(-1)).toContain("Conversation archived");

    await intake.handleText(message, "/new");
    const secondConversation = intake.lifecycle.inspect(dmSurface(1))!;
    const secondRunner = runners.at(-1)!;

    await intake.handleText(message, `/project ${cfg.goblinHome}`);

    expect(secondRunner.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeHost.hasRunner(secondConversation.id)).toBe(false);
    expect(replies.at(-1)).toContain("Project assigned");
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

    replyNoActiveSession(makeMessage(dmReplies), dmSurface(1), "message");
    replyNoActiveSession(makeMessage(topicReplies), topicSurface("supergroup", 1, 42), "message");

    expect(dmReplies).toEqual(["`[info]` No active conversation\\. Use /new to start one\\."]);
    expect(topicReplies).toEqual([]);
  });

  it("lazily creates a conversation for plain text when none is bound", async () => {
    const { intake, conversationStore } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "hello");
    await waitFor(() => runners[0]?.prompt?.mock?.calls?.length === 1);

    expect(conversationStore.list()).toHaveLength(1);
    expect(runners[0]!.prompt).toHaveBeenCalledWith("[prepared] hello", expect.anything());
    expect(replies).toEqual([]);
  });

  it("lazily creates a conversation for the first unbound media message", async () => {
    const { intake, conversationStore } = makeHarness();
    installVoiceFetch({ audio: new Uint8Array([1, 2, 3]) });
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handlePhoto(message, fakeApi(), ["small", "big"], "first photo");
    await waitFor(() => runners[0]?.prompt?.mock?.calls?.length === 1);

    expect(conversationStore.list()).toHaveLength(1);
    const content = runners[0]!.prompt.mock.calls[0]![0] as { type: string; text?: string; mimeType?: string }[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((part) => part.type === "text" && part.text === "first photo")).toBe(true);
    expect(content.some((part) => part.type === "image" && part.mimeType === "image/jpeg")).toBe(true);
    expect(replies).toEqual([]);
  });

  it("installs cold text bootstrap work before releasing runtime admission", async () => {
    const { intake, runtimeHost } = makeHarness();
    const promptBlock = deferred();
    MockAgentRunner.nextPrompt = async () => { await promptBlock.promise; };
    let releases = 0;
    const handle: UpdateHandle = {
      releaseRuntimeAdmission: () => { releases += 1; },
    };
    const message = makeMessage();

    await intake.handleText(message, "cold text", handle);
    const conversation = intake.lifecycle.inspect(dmSurface(1));
    expect(conversation).not.toBeNull();
    expect(releases).toBe(1);
    expect(runtimeHost.hasPromptWork(conversation!.id)).toBe(true);

    promptBlock.resolve();
    await waitFor(() => runners[0]?.prompt.mock.calls.length === 1);
    await waitFor(() => !runtimeHost.hasPromptWork(conversation!.id));
  });

  it("installs cold media bootstrap work before releasing runtime admission", async () => {
    const { intake, runtimeHost } = makeHarness();
    const downloadBlock = deferred();
    globalThis.fetch = mock(async () => {
      await downloadBlock.promise;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      });
    }) as unknown as typeof fetch;
    let releases = 0;
    const handle: UpdateHandle = {
      releaseRuntimeAdmission: () => { releases += 1; },
    };
    const message = makeMessage();

    await intake.handlePhoto(message, fakeApi(), ["photo"], "cold media", handle);
    const conversation = intake.lifecycle.inspect(dmSurface(1));
    expect(conversation).not.toBeNull();
    expect(releases).toBe(1);
    expect(runtimeHost.hasPromptWork(conversation!.id)).toBe(true);

    downloadBlock.resolve();
    await waitFor(() => runners[0]?.prompt.mock.calls.length === 1);
    await waitFor(() => !runtimeHost.hasPromptWork(conversation!.id));
  });

  it("writes assistant transcript with the destination surface id after a cross-surface resume", async () => {
    const { cfg, intake } = makeHarness();
    const replies1: string[] = [];
    const message1 = makeMessage(replies1, { surface: dmSurface(1) });

    await intake.handleText(message1, "hello");
    await waitFor(() => runners[0]?.prompt?.mock?.calls?.length === 1);

    const convId = intake.lifecycle.inspect(dmSurface(1))!.id;
    expect(convId).toBeDefined();

    const replies2: string[] = [];
    const message2 = makeMessage(replies2, { surface: dmSurface(2) });
    await intake.handleText(message2, `/resume ${convId}`);
    await flushMicrotasks();

    globalThis.fetch = mock(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await intake.handlePhoto(message2, fakeApi(), ["file-id"], "after resume");
    await waitFor(() => readTranscriptLines(cfg.goblinHome, convId).length > 0);

    const lines = readTranscriptLines(cfg.goblinHome, convId);
    const last = lines.at(-1) as Record<string, unknown>;
    expect(last.role).toBe("assistant");
    expect(last.sourceSurfaceId).toBe("tg:v1:dm:2");
  });

  it("does not block unrelated conversations on different surfaces", async () => {
    const { intake } = makeHarness();
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners.length === 1 && runners[0]!.prompt.mock.calls.length === 1) {
        await slow.promise;
      }
    };

    const replies1: string[] = [];
    const message1 = makeMessage(replies1, { surface: dmSurface(1) });
    const replies2: string[] = [];
    const message2 = makeMessage(replies2, { surface: dmSurface(2) });

    await intake.handleText(message1, "first");
    await waitFor(() => runners[0]?.isStreaming ?? false);

    await intake.handleText(message2, "second");
    await waitFor(() => runners[1]?.prompt?.mock?.calls?.length === 1);

    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
    expect(runners[0]!.prompt).toHaveBeenCalledWith("[prepared] first", expect.anything());
    expect(runners[1]!.prompt).toHaveBeenCalledTimes(1);
    expect(runners[1]!.prompt).toHaveBeenCalledWith("[prepared] second", expect.anything());

    slow.resolve();
    await waitFor(() => !runners[0]!.isStreaming);

    expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
    expect(runners[1]!.prompt).toHaveBeenCalledTimes(1);
  });

  it("serializes a runner-disposing command behind in-flight photo work", async () => {
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
    await waitFor(() => staleRunner.prompt.mock.calls.length === 1);
    await waitFor(() => staleRunner.dispose.mock.calls.length === 1);

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).toHaveBeenCalledTimes(1);
  });

  it("saves documents to the personal attachments directory", async () => {
    const { intake, cfg } = makeHarness();
    installVoiceFetch({ audio: new Uint8Array([1, 2, 3]) });
    const replies: string[] = [];
    const message = makeMessage(replies);

    await intake.handleText(message, "/new");
    await intake.handleDocument(message, fakeApi(), { fileId: "doc", fileName: "note.txt", caption: "read this" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    const firstPrompt = runners[0]!.prompt.mock.calls[0]![0] as string;
    expect(firstPrompt).toContain("read this");
    expect(firstPrompt).toContain("[File `attachments/note.txt` saved.]");
    expect(replies.some((r) => r.includes("Saved attachments/note") && !r.includes("2"))).toBe(true);

    await intake.handleDocument(message, fakeApi(), { fileId: "doc", fileName: "note.txt" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);

    const secondPrompt = runners[0]!.prompt.mock.calls[1]![0] as string;
    expect(secondPrompt).toContain("User uploaded `attachments/note-2.txt`.");
    expect(replies.some((r) => r.includes("Saved attachments/note") && r.includes("2"))).toBe(true);

    expect(existsSync(join(attachmentsPath(cfg.goblinHome), "note.txt"))).toBe(true);
    expect(existsSync(join(attachmentsPath(cfg.goblinHome), "note-2.txt"))).toBe(true);
  });

  it("records a photo download failure reply in the transcript", async () => {
    const { intake, cfg } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    globalThis.fetch = mock(async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    await intake.handleText(message, "/new");
    await intake.handlePhoto(message, fakeApi(), ["file-id"], undefined);
    await flushMicrotasks();

    const replyText = "`[error]` Sorry, I couldn't download that image\\.";
    expect(replies.some((r) => r === replyText)).toBe(true);

    const conversationId = intake.lifecycle.inspect(dmSurface(1))!.id;
    const lines = readTranscriptLines(cfg.goblinHome, conversationId);
    const lastEntry = lines.at(-1);
    expect(lastEntry).toEqual({
      ts: expect.any(String),
      role: "assistant",
      content: "[system] Sorry, I couldn't download that image.",
      sourceSurfaceId: "tg:v1:dm:1",
    });
  });

  it("delivers a synthetic reply with no transcript writer context, leaves JSONL unchanged, and logs bounded telemetry", async () => {
    // A runner with an internal memory context has no Surface authority, so any
    // synthetic assistant reply must be delivered to the user without stamping
    // the transcript. This verifies the no-context path never materializes a
    // Surface context, never mutates the transcript, and emits a telemetry
    // signal that contains only bounded identifiers.
    const cfg = makeConfig();
    const conversationStore = new ConversationStore(cfg.goblinHome);
    const warnSpy = spyOn(log, "warn");

    const internalContext: InternalMemoryContext = { kind: "internal", caller: { kind: "internal" } };
    const intake = createTestIntake({
      cfg,
      bot: fakeBot(),
      subagentRunner: new SubagentRunner(cfg),
      memoryStore: new MemoryStore(cfg.goblinHome),
      createMessageBuffer: () => ({}) as MessageBuffer,
      createAgentRunner: (opts) => {
        const runner = new MockAgentRunner({ sessionId: opts.sessionId, memoryContext: internalContext });
        runners.push(runner);
        return runner as unknown as AgentRunner;
      },
    });

    const replies: string[] = [];
    const message = makeMessage(replies);
    globalThis.fetch = mock(async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    await intake.handleText(message, "/new");
    const conversationCount = conversationStore.list().length;
    const conversationId = intake.lifecycle.inspect(dmSurface(1))!.id;
    const runnerCount = intake.dispatcher.hasRunner(conversationId) ? 1 : 0;

    await intake.handlePhoto(message, fakeApi(), ["file-id"], undefined);
    await flushMicrotasks();

    // 1. The user-visible reply is still delivered.
    const replyText = "`[error]` Sorry, I couldn't download that image\\.";
    expect(replies.some((r) => r === replyText)).toBe(true);

    // 2. The transcript JSONL is unchanged (no synthetic entry appended).
    const path = transcriptPath(cfg.goblinHome, conversationId);
    expect(readFileSync(path, "utf-8").trim()).toBe("");

    // 3. No additional binding lookup or runtime creation occurred.
    expect(conversationStore.list()).toHaveLength(conversationCount);
    expect(intake.dispatcher.hasRunner(conversationId) ? 1 : 0).toBe(runnerCount);

    // 4. The telemetry signal is bounded and contains no reply text.
    const noContextCall = warnSpy.mock.calls.find((call) => call[0] === "no-transcript-writer-context");
    expect(noContextCall).toBeDefined();
    const payload = noContextCall![1] as Record<string, unknown>;
    expect(payload.sessionId).toBe(conversationId);
    expect(payload.surfaceId).toBe("tg:v1:dm:1");
    expect(payload.surfaceKind).toBe("dm");
    expect(payload.runnerPresent).toBe(true);
    expect(payload.runnerKind).toBe("internal");
    expect("text" in payload).toBe(false);

    warnSpy.mockRestore();
  });

  it("keeps handleText in flight until accepted steering settles", async () => {
    const { intake } = makeHarness();
    const message = makeMessage([]);
    const slow = deferred();
    const steering = deferred();
    MockAgentRunner.nextPrompt = async () => { await slow.promise; };
    MockAgentRunner.nextFollowUp = async () => { await steering.promise; };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    let handled = false;
    const handling = intake.handleText(message, "steer this").then(() => { handled = true; });
    await waitFor(() => runners[0]!.followUp.mock.calls.length === 1);
    expect(runners[0]!.followUp).toHaveBeenCalledWith("[prepared] steer this");
    expect(handled).toBe(false);

    steering.resolve();
    await handling;
    expect(handled).toBe(true);
    slow.resolve();
  });

  it("falls back to a fresh turn when a steer loses the streaming race", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };
    MockAgentRunner.nextFollowUp = () => {
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

  it("admits the late-steer fallback before releasing Telegram runtime admission", async () => {
    const { intake } = makeHarness();
    const message = makeMessage([]);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };
    MockAgentRunner.nextFollowUp = () => {
      throw new Error("Cannot steer: session is not streaming.");
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    let released = false;
    let promptPendingAtRelease: boolean | undefined;
    const session = intake.lifecycle.inspect(dmSurface(1))!;
    const handle: UpdateHandle = {
      releaseRuntimeAdmission: () => {
        // Record that the release ran and capture the observed state; any
        // assertion here would mask failures thrown by steerOrFallbackToFreshTurn.
        released = true;
        promptPendingAtRelease = intake.dispatcher.isPromptPending(session.id);
      },
    };
    await intake.handleText(message, "steer this", handle);

    expect(released).toBe(true);
    expect(promptPendingAtRelease).toBe(true);
    expect(intake.dispatcher.isPromptPending(session.id)).toBe(true);
    slow.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);
  });

  it("does not fall back when a steer fails for a non-race reason", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };
    MockAgentRunner.nextFollowUp = () => {
      throw new Error("session disposed");
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow");
    await waitFor(() => runners[0]!.isStreaming);

    await expect(intake.handleText(message, "steer this")).rejects.toThrow("session disposed");
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
    expect(replies.at(-1)).toBe("`[queued]` Queued\\. Will run after this turn\\.");

    // Release the turn. The deferred command re-dispatches and replies.
    slow.resolve();
    await waitFor(() => replies.at(-1)!.includes("Switched to"));
    expect(replies.at(-1)).toContain("Switched to `poe/GPT-4o`");
  });

  it("does not start a binding-authorized queued command after runtime shutdown", async () => {
    const cfg = makeConfig();
    cfg.favorites = ["poe/GPT-4o"];
    const { intake, runtimeHost } = makeHarness(cfg);
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
    expect(replies.at(-1)).toBe("`[queued]` Queued\\. Will run after this turn\\.");

    const shutdown = runtimeHost.disposeAll();
    slow.resolve();
    await shutdown;

    expect(replies.some((reply) => reply.includes("Switched to"))).toBe(false);
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
    expect(replies.at(-1)).toBe("`[ok]` Cancelled\\.");
    expect(runners[0]!.isStreaming).toBe(false);

    slow.resolve();
    await flushMicrotasks();
  });

  it("replies with recovery instructions when the runner is wedged", async () => {
    const { intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => { await pending.promise; };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    // Simulate the abort cascade having given up on this runner.
    runners[0]!.markAbortTimedOut();
    expect(runners[0]!.isAbortTimedOut).toBe(true);

    // A second /cancel no longer lies with "Nothing to cancel.";
    // it reports the wedged state and points to recovery commands.
    await intake.handleText(message, "/cancel");
    await flushMicrotasks();
    expect(replies.at(-1)).toContain("wedged after a previous abort timed out");
    expect(replies.at(-1)).toContain("/new or /archive");

    // A new user message while wedged is not silently queued/dropped.
    await intake.handleText(message, "what about now");
    await flushMicrotasks();
    expect(replies.at(-1)).toBe("`[error]` A previous turn is wedged after a failed abort\\. Use /new or /archive to recover\\.");

    pending.resolve();
    await flushMicrotasks();
  });

  it("runs /archive directly when a wedged runtime cannot drain its prompt queue", async () => {
    const { runtimeHost, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => { await pending.promise; };

    await intake.handleText(message, "/new");
    const sessionId = intake.lifecycle.inspect(message.surface!)!.id;
    const runner = runners[0]!;
    await intake.handleText(message, "slow turn");
    await waitFor(() => runner.isPrompting);

    // `isPrompting` stays true when pi's abort promise never resolves. This
    // was previously treated as an ordinary busy runtime, so /archive joined
    // the stuck queue instead of letting lifecycle disposal fence it off.
    runner.markAbortTimedOut();
    expect(runner.isAbortTimedOut).toBe(true);
    expect(runner.isPrompting).toBe(true);

    // A queue-timing command that cannot repair the runtime must not receive
    // a false queued acknowledgement.
    await intake.handleText(message, "/compact");
    expect(replies.at(-1)).toBe("`[error]` A previous turn is wedged after a failed abort\\. Use /new or /archive to recover\\.");

    await intake.handleText(message, "/archive");

    expect(replies.at(-1)).toBe("`[ok]` Conversation archived\\.");
    expect(runner.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeHost.hasRunner(sessionId)).toBe(false);
    expect(intake.lifecycle.inspect(message.surface!)).toBeNull();

    // The original prompt can settle late, but its stale queue cannot revive
    // the archived runtime or append a delayed command reply.
    pending.resolve();
    await flushMicrotasks();
    expect(runtimeHost.hasRunner(sessionId)).toBe(false);
  });

  it("orphans a later-deferred command when an earlier /new swaps the runner", async () => {
    // When /new queues before /model, /new swaps out S1's runner before the
    // deferred /model continuation runs. The isCurrent() guard then drops
    // /model — no "Switched to" reply arrives.
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
    await waitFor(() => replies.at(-1)!.includes("Created new conversation"));

    // /new swapped the runner; the stale deferred /model never executed.
    expect(replies.some((r) => r.startsWith("Switched to"))).toBe(false);
  });

  it("preserves deferred command arrival order across same-binding runtime invalidation", async () => {
    // /model invalidates S1's runtime but keeps the binding authoritative.
    // The later /new therefore remains serialized behind it and executes next;
    // acknowledged lifecycle commands must not disappear with model work.
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
    await waitFor(() => replies.filter((r) => r.includes("Switched to")).length === 1);
    await waitFor(() => replies.filter((r) => r.includes("Created new conversation")).length === 2);

    expect(runners[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(replies.some((r) => r.includes("Switched to `poe/GPT-4o`"))).toBe(true);
    expect(replies.findIndex((r) => r.includes("Switched to"))).toBeLessThan(
      replies.findLastIndex((r) => r.includes("Created new conversation")),
    );
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

    // Surface preference persistence rejects; modelHandler's try/catch
    // converts it to a canned reply.
    intake.lifecycle.setSurfacePreferences = async (_surface, _patch) => {
      throw new Error("provider key rejected");
    };

    await intake.handleText(message, "/model 1");
    await flushMicrotasks();
    expect(replies.at(-1)).toBe("`[queued]` Queued\\. Will run after this turn\\.");

    slow.resolve();
    await waitFor(() => replies.at(-1)!.includes("Failed"));

    // The canned error reply arrives after the turn settles.
    expect(replies.at(-1)).toBe("`[error]` Failed to switch model\\. Please try again\\.");
  });

  it("shares per-Conversation ordering between /queue and scheduled dispatch", async () => {
    // Telegram `/queue` prompts and scheduler-dispatched prompts must serialize
    // through the same per-Conversation chain so a due scheduled turn cannot
    // start while a queued prompt is in flight.
    const { intake } = makeHarness();
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
    const conversation = intake.lifecycle.inspect(dmSurface(1))!;
    const dispatcher = intake.dispatcher;

    // 1. Start a slow Telegram turn.
    await intake.handleText(message, "first (telegram)");
    await waitFor(() => runners[0]!.isStreaming);

    // 2. Queue a /queue prompt behind it (Telegram path).
    await intake.handleText(message, "/queue second (queued)");
    await flushMicrotasks();

    // 3. Enqueue a scheduled turn on the SAME dispatcher (scheduler path).
    dispatcher.enqueueScheduledTurn(conversation, dmSurface(1), "third (scheduled)");
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

  it("queues a scheduler tick behind an active Telegram turn for the same Conversation", async () => {
    const cfg = makeConfig();
    const { intake, conversationStore } = makeHarness(cfg);
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
    const schedule = store.create({
      surface: dmSurface(1),
      kind: "once",
      prompt: "scheduled while busy",
      nextRunAt: new Date(now - 1000).toISOString(),
    });
    const loop = new SchedulerLoop({
      store,
      lifecycle: intake.lifecycle,
      conversationCatalog: conversationStore,
      internalSessionStore: new InternalSessionStore(cfg.goblinHome),
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
    expect(store.getForSurface(dmSurface(1), schedule.id)!.lastRun).toBeUndefined();

    pending.resolve();
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 2);

    expect(order).toEqual(["[prepared] active telegram turn", "scheduled while busy"]);
    expect(store.getForSurface(dmSurface(1), schedule.id)!.lastRun?.outcome).toBe("ok");
  });

  it("aborts a scheduled turn whose runner was swapped before it started", async () => {
    // Stale-runner guard on the scheduled-turn path: enqueue a scheduled turn
    // behind a slow in-flight turn, then dispose the runner (as /new would)
    // before the queued scheduled turn starts. The isCurrent() guard must
    // abort the scheduled turn without producing side effects — the scheduled
    // prompt never reaches the disposed runner.
    const { intake, runtimeHost } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const pending = deferred();
    MockAgentRunner.nextPrompt = async () => {
      await pending.promise; // keep the first turn in flight
    };

    await intake.handleText(message, "/new");
    const conversation = intake.lifecycle.inspect(dmSurface(1))!;
    const dispatcher = intake.dispatcher;
    const firstRunner = runners[0]!;

    // Start a slow turn, then enqueue a scheduled turn behind it.
    await intake.handleText(message, "slow");
    await waitFor(() => firstRunner.isStreaming);
    dispatcher.enqueueScheduledTurn(conversation, dmSurface(1), "scheduled prompt");
    await flushMicrotasks();

    // Swap the runner out (as /new does) before the scheduled turn starts.
    await dispatcher.disposeRunner(conversation.id);
    expect(runtimeHost.hasRunner(conversation.id)).toBe(false);

    // Release the in-flight turn. The queued scheduled turn wakes, sees its
    // runner is no longer current, and aborts.
    pending.resolve();
    await flushMicrotasks();

    // The scheduled prompt never ran on the disposed runner.
    expect(firstRunner.prompt).toHaveBeenCalledTimes(1);
    expect(firstRunner.prompt.mock.calls[0]![0]).toBe("[prepared] slow");
    // No new runner was created for the scheduled turn (isCurrent() aborted).
    expect(dispatcher.hasRunner(conversation.id)).toBe(false);
  });

  it("disposeRunner clears runner and queues without enumerating subagents", async () => {
    const cfg = makeConfig();
    const subagentRunner = new SubagentRunner(cfg);

    const { runtimeHost, intake } = makeHarness(cfg, subagentRunner);
    const dispatcher = intake.dispatcher;
    const runner = new MockAgentRunner({ sessionId: "sess-1" });
    registerTestRunner(runtimeHost, "sess-1", runner as unknown as AgentRunner);

    const cancelBySession = mock(async (_sessionId: string) => {});
    subagentRunner.cancelBySession = cancelBySession as unknown as SubagentRunner["cancelBySession"];

    await dispatcher.disposeRunner("sess-1");

    expect(cancelBySession).not.toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeHost.hasRunner("sess-1")).toBe(false);
  });

  it("disposeRunner rethrows when runner.dispose throws (including falsy values)", async () => {
    const cfg = makeConfig();
    const subagentRunner = new SubagentRunner(cfg);

    const { runtimeHost, intake } = makeHarness(cfg, subagentRunner);
    const dispatcher = intake.dispatcher;

    // Falsy throw — `if (disposeErr)` alone would swallow this.
    const falsyRunner = new MockAgentRunner({ sessionId: "sess-falsy" });
    falsyRunner.dispose.mockImplementation(() => {
      throw null;
    });
    registerTestRunner(runtimeHost, "sess-falsy", falsyRunner as unknown as AgentRunner);

    await expect(dispatcher.disposeRunner("sess-falsy")).rejects.toBeNull();
    expect(runtimeHost.hasRunner("sess-falsy")).toBe(false);

    // Real error — must also rethrow.
    const errorRunner = new MockAgentRunner({ sessionId: "sess-err" });
    const disposeErr = new Error("dispose blew up");
    errorRunner.dispose.mockImplementation(() => {
      throw disposeErr;
    });
    registerTestRunner(runtimeHost, "sess-err", errorRunner as unknown as AgentRunner);

    await expect(dispatcher.disposeRunner("sess-err")).rejects.toBe(disposeErr);
    expect(runtimeHost.hasRunner("sess-err")).toBe(false);
  });

  it("saves the voice file and prompts with transcript + saved-file note for a personal environment", async () => {
    const cfg = makeConfig();
    cfg.groqApiKey = "groq-key";
    const { intake, cfg: harnessCfg } = makeHarness(cfg);
    const replies: string[] = [];
    const message = makeMessage(replies);
    installVoiceFetch({ groqText: "take out the trash" });

    await intake.handleText(message, "/new");
    await intake.handleVoice(message, fakeApi(), { fileId: "v1", mimeType: "audio/ogg" });
    await waitFor(() => runners[0]!.prompt.mock.calls.length === 1);

    const promptArg = runners[0]!.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("[Voice message transcript]\ntake out the trash");
    expect(promptArg).toMatch(/\[Voice file `attachments\/voice-\d+\.oga` saved\.\]/);
    expect(replies.some((r) => r.includes("Saved attachments/voice") && r.includes("oga"))).toBe(true);

    expect(readdirSync(attachmentsPath(harnessCfg.goblinHome)).some((n) => /voice-\d+\.oga$/.test(n))).toBe(true);
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
    expect(promptArg).toMatch(/\[Voice file `voice-\d+\.oga` saved\.\]/);
    expect(replies.some((r) => r.includes("Saved voice") && r.includes("oga") && !r.includes("attachments/"))).toBe(true);
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
    const { intake, cfg: harnessCfg } = makeHarness(cfg);
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

    // The error reply is recorded as an assistant entry so the context window
    // stays honest about what the bot said.
    const conversationId = intake.lifecycle.inspect(dmSurface(1))!.id;
    const lines = readTranscriptLines(harnessCfg.goblinHome, conversationId);
    const lastEntry = lines.at(-1);
    expect(lastEntry).toEqual({
      ts: expect.any(String),
      role: "assistant",
      content: "[system] Sorry, I couldn't transcribe that voice message.",
      sourceSurfaceId: "tg:v1:dm:1",
    });
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

  it("serializes a runner-disposing command behind in-flight voice work", async () => {
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

    // Queue the runner swap behind the in-flight transcription.
    await intake.handleText(message, "/new");

    pending.resolve();
    await waitFor(() => staleRunner.prompt.mock.calls.length === 1);
    await waitFor(() => staleRunner.dispose.mock.calls.length === 1);

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).toHaveBeenCalledTimes(1);
    expect(replies.some((r) => r.includes("transcrib") || r.includes("No speech") || r.includes("Saved"))).toBe(true);
  });

  it("serializes a project runner swap behind in-flight voice work", async () => {
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
    const staleRunner = runners.at(-1)!;

    // Queue the runner swap behind the in-flight transcription.
    await intake.handleText(message, "/new");

    pending.resolve();
    await waitFor(() => staleRunner.prompt.mock.calls.length === 1);
    await waitFor(() => staleRunner.dispose.mock.calls.length === 1);

    expect(staleRunner.dispose).toHaveBeenCalledTimes(1);
    expect(staleRunner.prompt).toHaveBeenCalledTimes(1);
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
      await waitFor(() => results.length === 1);

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
      await waitFor(() => captured !== undefined);

      expect(captured).toBe("raw guest text");
      expect(results[0]!.type).toBe("article");
    });

    it("replies with the fallback when agent output is empty", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      // No onTextDelta calls — sink.text stays empty.
      MockAgentRunner.nextPrompt = async () => {};

      await intake.handleGuestMessage(message, "hi");
      await waitFor(() => results.length === 1);

      expect(results).toHaveLength(1);
      const article = results[0] as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toBe("(no response)");
    });

    it("installs cold admission before release and classifies a concurrent pre-stream guest busy", async () => {
      const { intake } = makeHarness();
      const pending = deferred();
      MockAgentRunner.nextPrompt = async (_content, buffer) => {
        (buffer as GuestReplySink).onTextDelta("first done");
        await pending.promise;
      };
      let releases = 0;
      const handle: UpdateHandle = {
        releaseRuntimeAdmission: () => { releases += 1; },
      };
      const firstGuest = makeGuestMessage();

      const first = intake.handleGuestMessage(firstGuest.message, "first", handle);
      await waitFor(() => releases === 1);
      expect(releases).toBe(1);
      expect(firstGuest.results).toHaveLength(0);

      const secondGuest = makeGuestMessage();
      await intake.handleGuestMessage(secondGuest.message, "second");
      expect(secondGuest.results).toHaveLength(1);
      const busy = secondGuest.results[0] as {
        type: "article";
        input_message_content: { message_text: string };
      };
      expect(busy.input_message_content.message_text).toContain("already thinking");

      pending.resolve();
      await first;
      await waitFor(() => firstGuest.results.length === 1);
      expect(runners).toHaveLength(1);
      expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
    });

    it("sends a busy fallback without prompting when the runner is streaming", async () => {
      const { intake } = makeHarness();
      const pending = deferred();
      MockAgentRunner.nextPrompt = async () => { await pending.promise; };

      // First summon starts a streaming turn. Don't await it — it stays open.
      const first = intake.handleGuestMessage(makeGuestMessage().message, "first");
      await waitFor(() => runners[0]?.isStreaming ?? false);

      // Second summon while busy: must not prompt, must reply busy fallback.
      const { message: message2, results: results2 } = makeGuestMessage();
      await intake.handleGuestMessage(message2, "second");

      expect(runners[0]!.prompt).toHaveBeenCalledTimes(1);
      expect(results2).toHaveLength(1);
      const article = results2[0] as { type: "article"; input_message_content: { message_text: string } };
      expect(article.input_message_content.message_text).toContain("already thinking");

      pending.resolve();
      await first;
      await waitFor(() => !(runners[0]?.isStreaming ?? true));
      await flushMicrotasks();
    });

    it("releases a closed admission classification without replying", async () => {
      const { intake, runtimeHost } = makeHarness();
      runtimeHost.closeAdmission();
      const guest = makeGuestMessage();
      let releases = 0;
      const handle: UpdateHandle = {
        releaseRuntimeAdmission: () => { releases += 1; },
      };

      await intake.handleGuestMessage(guest.message, "closed", handle);

      expect(releases).toBe(1);
      expect(guest.results).toHaveLength(0);
      expect(runners).toHaveLength(0);
    });

    it("releases a fenced classification without replying", async () => {
      const { intake, runtimeHost } = makeHarness();
      const conversation = await intake.lifecycle.resolveOrStart(guestSurface(99));
      runtimeHost.registerInternalRuntime(
        conversation.id,
        new MockAgentRunner({
          sessionId: conversation.id,
          memoryContext: { kind: "internal", caller: { kind: "internal" } },
        }) as unknown as AgentRunner,
      );
      const guest = makeGuestMessage();
      let releases = 0;
      const handle: UpdateHandle = {
        releaseRuntimeAdmission: () => { releases += 1; },
      };

      await intake.handleGuestMessage(guest.message, "fenced", handle);

      expect(releases).toBe(1);
      expect(guest.results).toHaveLength(0);
    });

    it("replies with the error fallback when prompt rejects", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      MockAgentRunner.nextPrompt = async () => { throw new Error("model down"); };

      await intake.handleGuestMessage(message, "hi");
      await waitFor(() => results.length === 1);

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
      await waitFor(() => runners[0]?.prompt.mock.calls.length === 1);
      await waitFor(() => !(runners[0]?.isStreaming ?? true));
      expect(results).toHaveLength(0);
    });

    it("keeps unresolved delivery update-owned while runtime shutdown completes", async () => {
      const { intake, runtimeHost } = makeHarness();
      const deliveryStarted = deferred();
      const deliveryDone = deferred();
      const results: InlineQueryResult[] = [];
      const message: GuestMessage = {
        surface: guestSurface(99),
        replyVia: async (result) => {
          results.push(result);
          deliveryStarted.resolve();
          await deliveryDone.promise;
        },
      };
      MockAgentRunner.nextPrompt = async (_content, buffer) => {
        (buffer as GuestReplySink).onTextDelta("delivery pending");
      };

      const handler = intake.handleGuestMessage(message, "hi");
      await deliveryStarted.promise;
      await runtimeHost.disposeAll();

      let handlerSettled = false;
      void handler.then(() => { handlerSettled = true; });
      await Promise.resolve();
      expect(handlerSettled).toBe(false);
      expect(results).toHaveLength(1);

      deliveryDone.resolve();
      await handler;
      expect(handlerSettled).toBe(true);
    });

    it("swallows a replyVia rejection on the error-fallback path too", async () => {
      const { intake } = makeHarness();
      const { message, results, rejectNext } = makeGuestMessage();
      rejectNext(new Error("expired"));
      MockAgentRunner.nextPrompt = async () => { throw new Error("turn failed"); };

      await expect(intake.handleGuestMessage(message, "hi")).resolves.toBeUndefined();
      await waitFor(() => runners[0]?.prompt.mock.calls.length === 1);
      await waitFor(() => !(runners[0]?.isStreaming ?? true));
      expect(results).toHaveLength(0);
    });

    it("auto-creates a guest Conversation keyed on the foreign chat id", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage(7777);
      MockAgentRunner.nextPrompt = async () => {};

      await intake.handleGuestMessage(message, "first");
      await waitFor(() => results.length === 1);

      // A guest binding for chat 7777 now exists.
      expect(intake.lifecycle.inspect(guestSurface(7777))).not.toBeNull();
      // And NOT a DM binding for the same id.
      expect(intake.lifecycle.inspect(dmSurface(7777))).toBeNull();
      expect(results).toHaveLength(1);
    });

    it("reuses the same guest Conversation on a second summon from the same chat", async () => {
      const { intake, conversationStore } = makeHarness();
      MockAgentRunner.nextPrompt = async (_c, buffer) => {
        (buffer as GuestReplySink).onTextDelta("ack");
      };

      const firstGuest = makeGuestMessage(7777);
      await intake.handleGuestMessage(firstGuest.message, "first");
      await waitFor(() => firstGuest.results.length === 1);
      const firstConversation = intake.lifecycle.inspect(guestSurface(7777));
      expect(firstConversation).not.toBeNull();

      const secondGuest = makeGuestMessage(7777);
      await intake.handleGuestMessage(secondGuest.message, "second");
      await waitFor(() => secondGuest.results.length === 1);
      const secondConversation = intake.lifecycle.inspect(guestSurface(7777));

      expect(secondConversation!.id).toBe(firstConversation!.id);
      // Only one Conversation was ever created.
      const storedConversations = conversationStore.list();
      expect(storedConversations).toHaveLength(1);
      expect(storedConversations[0]?.id).toBe(firstConversation!.id);
    });

    it("each InlineQueryResult article has a unique id and a title", async () => {
      const { intake } = makeHarness();
      const { message, results } = makeGuestMessage();
      MockAgentRunner.nextPrompt = async (_c, buffer) => {
        (buffer as GuestReplySink).onTextDelta("x");
      };

      await intake.handleGuestMessage(message, "a");
      await waitFor(() => results.length === 1);
      const second = makeGuestMessage();
      await intake.handleGuestMessage(second.message, "b");
      await waitFor(() => second.results.length === 1);

      results.push(...second.results);
      const ids = results.map((r) => (r as { id: string }).id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of results) {
        expect((r as { title: string }).title).toBe("Goblin");
      }
    });
  });
});

describe("createMessageBuffer factory", () => {
  it("creates a Conversation-scoped MetricsStore for an active Conversation", async () => {
    const cfg = makeConfig();
    const bot = fakeBot();
    const intake = createTestIntake({
      cfg,
      bot,
      subagentRunner: new SubagentRunner(cfg),
      memoryStore: new MemoryStore(cfg.goblinHome),
      createAgentRunner: (opts) => {
        const runner = new MockAgentRunner(opts);
        runners.push(runner);
        return runner as unknown as AgentRunner;
      },
    });

    const replies: string[] = [];
    const message = makeMessage(replies);
    await intake.handleText(message, "/new");

    const conversation = intake.lifecycle.inspect(dmSurface(1));
    expect(conversation).not.toBeNull();

    MockAgentRunner.nextPrompt = async (_content, buffer) => {
      (buffer as { onStatusUpdate: (text: string) => void }).onStatusUpdate("thinking");
      (buffer as { onTextDelta: (text: string) => void }).onTextDelta("hello");
      await (buffer as { flushResponse: (force?: boolean) => Promise<void> }).flushResponse(true);
    };

    await intake.handleText(message, "hi");
    await waitFor(() => {
      try {
        return readFileSync(metricsPath(cfg.goblinHome, conversation!.id), "utf-8").trim() !== "";
      } catch {
        return false;
      }
    });

    const raw = readFileSync(metricsPath(cfg.goblinHome, conversation!.id), "utf-8").trim();
    const events = raw.split("\n").map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === "telegram" && e.op === "sendMessage" && e.channel === "status")).toBe(true);
  });

  it("operates without a MetricsStore when no Conversation exists", async () => {
    const cfg = makeConfig();
    const bot = fakeBot();
    const intake = createTestIntake({
      cfg,
      bot,
      subagentRunner: new SubagentRunner(cfg),
      memoryStore: new MemoryStore(cfg.goblinHome),
    });

    const replies: string[] = [];
    const message = makeMessage(replies);
    await intake.handleText(message, "/unknown");
    // Unknown command with no active Conversation returns a prompt without creating metrics.
    expect(replies.length).toBe(1);
  });

  it("createMessageBuffer with no Conversation yields a buffer with no metrics", () => {
    const cfg = makeConfig();
    const bot = fakeBot();
    const intake = createTestIntake({
      cfg,
      bot,
      subagentRunner: new SubagentRunner(cfg),
      memoryStore: new MemoryStore(cfg.goblinHome),
    });

    const surface = dmSurface(1);
    const buffer = intake.dispatcher.createMessageBuffer(surface, undefined) as unknown as MessageBuffer;
    expect(buffer._state().metrics).toBeUndefined();
  });

  it("queues /resume behind a streaming turn and moves the binding after", async () => {
    const { cfg, intake } = makeHarness();
    const replies: string[] = [];
    const message = makeMessage(replies);
    const slow = deferred();
    MockAgentRunner.nextPrompt = async () => {
      if (runners[0]!.prompt.mock.calls.length === 1) await slow.promise;
    };

    await intake.handleText(message, "/new");
    await intake.handleText(message, "slow turn");
    await waitFor(() => runners[0]!.isStreaming);

    const store = new ConversationStore(cfg.goblinHome);
    const target = store.create(personalEnvironment());

    await intake.handleText(message, `/resume ${target.id}`);
    await flushMicrotasks();

    expect(replies.at(-1)).toBe("`[queued]` Queued\\. Will run after this turn\\.");

    slow.resolve();
    await waitFor(() => replies.at(-1)!.includes("Resumed conversation"));

    expect(intake.lifecycle.inspect(dmSurface(1))?.id).toBe(target.id);
    expect(existsSync(join(cfg.goblinHome, "state/sessions", target.id))).toBe(true);
  });
});
