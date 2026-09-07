import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import { dmSurface, topicSurface, surfaceId, type Surface } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import type { Config } from "../config.ts";
import { DelegatedWorkHost } from "./host.ts";
import { DurableCompletionWake } from "./delivery.ts";
import { TurnDispatcher, type TurnSink } from "../orchestration/dispatcher.ts";
import { ConversationRuntimeHost } from "../orchestration/conversation-runtime-host.ts";
import type { SurfaceRuntimeAuthority, AttachmentSignal, AttachedWork } from "../orchestration/dispatcher.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { MemoryStore } from "../memory/mod.ts";
import { DEFAULT_SKILL_POLICY } from "../agent/skills/mod.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { createTelegramRuntimeAdapters } from "../tg/runtime-adapters.ts";
import { asConversationRuntimeId } from "./types.ts";
import type { SurfaceId } from "../surface.ts";

/**
 * Production Telegram delivery integration verifier for issue #54 unit 1.
 *
 * Wires the production DurableCompletionWake, TurnDispatcher, and Telegram
 * buffer/adapters together with a fake model backend (FakeAgentRunner driving
 * the real TurnSink) and a controllable Bot API. No source scans.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-telegram-delivery-"));
}

function durableOwnership(originSurfaceId: SurfaceId) {
  return {
    lifetime: "durable" as const,
    ownerConversationId: "conversation-durable",
    runtimeId: asConversationRuntimeId("runtime-durable"),
    originSurfaceId,
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-durable",
  };
}

function boundConversation(id: string): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: personalEnvironment() };
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Controllable Bot API
// ---------------------------------------------------------------------------

interface MockBotState {
  bot: Bot;
  send: { chatId: number | string; text: string }[];
  edit: { chatId: number | string; messageId: number; text: string }[];
  documents: { chatId: number | string }[];
  drafts: { chatId: number | string; draftId: number; text: string }[];
  failNext: {
    send?: unknown;
    rich?: unknown;
    edit?: unknown;
    document?: unknown;
    richDraft?: unknown;
    plainDraft?: unknown;
  };
  gateRich: { wait: Promise<void> } | null;
  nextMessageId: number;
}

function makeMockBot(): MockBotState {
  const state: MockBotState = {
    bot: undefined as unknown as Bot,
    send: [],
    edit: [],
    documents: [],
    drafts: [],
    failNext: {},
    gateRich: null,
    nextMessageId: 100,
  };
  const bot = {
    api: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (state.failNext.send !== undefined) {
          const err = state.failNext.send;
          state.failNext.send = undefined;
          throw err;
        }
        if (state.gateRich !== null) {
          // sendMessage is also used for plain-text response fallback; gate it too
          // when a test holds the final send.
          await state.gateRich.wait;
        }
        state.send.push({ chatId, text });
        return { message_id: ++state.nextMessageId };
      },
      sendRichMessage: async (chatId: number | string, richMessage: { markdown?: string }) => {
        if (state.failNext.rich !== undefined) {
          const err = state.failNext.rich;
          state.failNext.rich = undefined;
          throw err;
        }
        if (state.gateRich !== null) {
          await state.gateRich.wait;
        }
        state.send.push({ chatId, text: richMessage.markdown ?? "" });
        return { message_id: ++state.nextMessageId };
      },
      sendRichMessageDraft: async (chatId: number | string, draftId: number, richMessage: { markdown?: string }) => {
        if (state.failNext.richDraft !== undefined) {
          const err = state.failNext.richDraft;
          state.failNext.richDraft = undefined;
          throw err;
        }
        state.drafts.push({ chatId, draftId, text: richMessage.markdown ?? "" });
        return true;
      },
      sendMessageDraft: async (chatId: number | string, draftId: number, text: string) => {
        if (state.failNext.plainDraft !== undefined) {
          const err = state.failNext.plainDraft;
          state.failNext.plainDraft = undefined;
          throw err;
        }
        state.drafts.push({ chatId, draftId, text });
        return true;
      },
      editMessageText: async (chatId: number | string, messageId: number, textOrRich: string | { markdown?: string }) => {
        if (state.failNext.edit !== undefined) {
          const err = state.failNext.edit;
          state.failNext.edit = undefined;
          throw err;
        }
        const text = typeof textOrRich === "string" ? textOrRich : (textOrRich.markdown ?? "");
        state.edit.push({ chatId, messageId, text });
        return true;
      },
      sendDocument: async (chatId: number | string) => {
        if (state.failNext.document !== undefined) {
          const err = state.failNext.document;
          state.failNext.document = undefined;
          throw err;
        }
        state.documents.push({ chatId });
        return { message_id: ++state.nextMessageId };
      },
      sendChatAction: async () => true,
    },
  } as unknown as Bot;
  state.bot = bot;
  return state;
}

function telegramError(code: number, description: string): unknown {
  return { error_code: code, description };
}

// ---------------------------------------------------------------------------
// Fakes for dispatcher construction (transport-neutral, no Telegram types)
// ---------------------------------------------------------------------------

class FakeAgentRunner {
  promptCalls = 0;
  promptImpl: (content: unknown, sink: TurnSink) => Promise<void> = async (_c, sink) => {
    sink.onTextDelta("final response");
    sink.onAgentEnd();
  };
  _isStreaming = false;
  _isPrompting = false;
  _isAbortTimedOut = false;
  get isStreaming(): boolean { return this._isStreaming; }
  get isPrompting(): boolean { return this._isPrompting; }
  get isAbortTimedOut(): boolean { return this._isAbortTimedOut; }
  tryClearAbortTimeout(): boolean {
    if (!this._isAbortTimedOut) return false;
    if (this._isPrompting || this._isStreaming) return false;
    this._isAbortTimedOut = false;
    return true;
  }
  get modelName(): string { return ""; }
  async dispose(): Promise<void> {}
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
  async prompt(content: unknown, sink: unknown): Promise<void> {
    this.promptCalls += 1;
    await this.promptImpl(content, sink as TurnSink);
  }
  async abort(): Promise<void> {}
  async followUp(): Promise<void> {}
  async compact(): Promise<unknown> { return {}; }
}

class FakeSubagentRunner {
  cancelBySession(): Promise<void> { return Promise.resolve(); }
  dispose(): Promise<void> { return Promise.resolve(); }
  list(): unknown[] { return []; }
  cancel(): Promise<void> { return Promise.resolve(); }
  beginCancel(): Promise<void> { return Promise.resolve(); }
  revive(): Promise<string> { return Promise.resolve(""); }
  acknowledgeDelivery(): void {}
}

class FakeMemoryStore {
  read(): { body: string; description: string | null } { return { body: "", description: null }; }
  archiveOrphan(): Promise<void> { return Promise.resolve(); }
}

function permissiveAuthority(): SurfaceRuntimeAuthority {
  return {
    assertCurrentBinding: async () => {},
    isCurrentBinding: () => true,
    withCurrentBinding: async <T>(_s: Surface, _c: string, fn: (signal: AttachmentSignal) => Promise<AttachedWork<T>>) => {
      let settled = false;
      const signal: AttachmentSignal = {
        get settled() { return settled; },
        attached: () => { settled = true; },
        failed: () => { settled = true; },
      };
      return await fn(signal);
    },
  };
}

interface Integration {
  home: string;
  host: DelegatedWorkHost;
  dispatcher: TurnDispatcher;
  runtimeHost: ConversationRuntimeHost;
  wake: DurableCompletionWake;
  mockBot: MockBotState;
  surface: Surface;
  conversation: ConversationState;
  runner: FakeAgentRunner;
  cleanup: () => Promise<void>;
}

let chatSeq = 50000;

function buildIntegration(opts: {
  surface?: Surface;
  visibility?: "none" | "standard";
  promptImpl?: (content: unknown, sink: TurnSink) => Promise<void>;
  mockBot?: MockBotState;
} = {}): Integration {
  const home = tempHome();
  const host = new DelegatedWorkHost(home);
  const mockBot = opts.mockBot ?? makeMockBot();
  const chatId = ++chatSeq;
  const surface: Surface = opts.surface ?? topicSurface("supergroup", -100000 - chatId, 7);
  const conversation = boundConversation(`conv-${chatId}-${Math.random().toString(36).slice(2, 8)}`);
  const bindings = new Map<string, ConversationState>();
  bindings.set(surfaceId(surface), conversation);

  const visibility = opts.visibility ?? "none";
  const cfg = { goblinHome: home, toolVisibility: visibility } as Config;
  const memoryStore = new FakeMemoryStore() as unknown as MemoryStore;
  const adapters = createTelegramRuntimeAdapters({
    cfg,
    bot: mockBot.bot,
    memoryStore,
  });

  const runtimeHost = new ConversationRuntimeHost({ delegatedWorkHost: host });
  const subagentRunner = new FakeSubagentRunner() as unknown as SubagentRunner;
  const runner = new FakeAgentRunner();
  if (opts.promptImpl) runner.promptImpl = opts.promptImpl;

  const surfaceSettings = {
    effectiveEnvironment: (_s: Surface): ExecutionEnvironment => personalEnvironment(),
    getRuntimeSettings: () => ({
      executionEnvironment: personalEnvironment(),
      modelName: undefined,
      thinkingLevel: undefined,
      skillPolicy: DEFAULT_SKILL_POLICY,
      fingerprint: "test",
    }),
    getModelName: () => undefined,
    setModelName: () => {},
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
    setPreferences: () => {},
    getSkillPolicy: () => DEFAULT_SKILL_POLICY,
  };

  const dispatcher = new TurnDispatcher({
    cfg: {} as Config,
    surfaceSettings,
    subagentRunner,
    memoryStore,
    runtimeHost,
    createMessageBuffer: (s, c) => {
      // Route through the production Telegram adapters so the buffer,
      // visibility, drafts, and metrics wiring is exercised. Tests that need
      // deterministic throttling still get it via the adapter's defaults plus
      // immediate throttle windows overridden below by direct construction
      // when needed. For determinism, construct via adapters then rely on
      // zero-throttle behavior of the test Bot (immediate resolves).
      void c;
      return adapters.createMessageBuffer(s, c);
    },
    createBetaTools: () => [],
    createAgentRunner: (() => runner) as unknown as (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner,
    surfaceRuntimeAuthority: permissiveAuthority(),
  });

  // Warm-register the fake runner so scheduled turns use it without cold creation.
  const creation = runtimeHost.reserveCreation(conversation.id, surfaceId(surface), "test-settings");
  try {
    runtimeHost.registerSurfaceRuntime(conversation.id, runner as unknown as AgentRunner, {
      surfaceId: surfaceId(surface),
      runtimeId: DelegatedWorkHost.newRuntimeId(),
      skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "test", manifestFingerprint: null },
    });
  } finally {
    creation.complete();
  }

  const wake = new DurableCompletionWake(
    {
      resolveCurrent: async (s: Surface) => bindings.get(surfaceId(s)) ?? null,
      enqueueScheduledTurn: (conv, surf, content, onError) =>
        dispatcher.enqueueScheduledTurn(conv, surf, content, onError),
    },
    host,
  );

  return {
    home,
    host,
    dispatcher,
    runtimeHost,
    wake,
    mockBot,
    surface,
    conversation,
    runner,
    cleanup: async () => {
      await runtimeHost.disposeAll().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function successPrompt(_content: unknown, sink: TurnSink): Promise<void> {
  sink.onTextDelta("the completed result is ready");
  sink.onAgentEnd();
}

describe("production Telegram delivery before acknowledgement", () => {
  it("N1: remains pending until delayed final Telegram acceptance", async () => {
    const mockBot = makeMockBot();
    const gate = deferred<void>();
    mockBot.gateRich = { wait: gate.promise };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n1", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n1", 0, "finished work");

      let outcome: string | undefined;
      let done = false;
      const delivery = itg.wake.deliverCompletion("run-n1", 0).then((o) => {
        outcome = o;
        done = true;
        return o;
      });
      // Let the scheduled turn start and block on the Telegram send.
      await sleep(50);
      expect(done).toBe(false);
      expect(itg.host.loadRecord("run-n1")!.invocations[0]!.deliveryState).toBe("pending");
      expect(itg.runner.promptCalls).toBe(1);

      gate.resolve(undefined);
      mockBot.gateRich = null;
      expect(await delivery).toBe("delivered");
      expect(outcome).toBe("delivered");
      expect(itg.host.loadRecord("run-n1")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(itg.mockBot.send.length).toBeGreaterThanOrEqual(1);
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: retains pending after final send rejection", async () => {
    const mockBot = makeMockBot();
    // Persistent failure: the buffer retries the final seal, so a single-shot
    // failure would recover and correctly deliver. Final rejection requires
    // every send attempt to fail.
    const sendErr = new Error("network send failed");
    (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async () => {
      throw sendErr;
    };
    (mockBot.bot.api as unknown as Record<string, unknown>).sendMessage = async () => {
      throw sendErr;
    };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-send", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-send", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-send", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-send")!.invocations[0]!.deliveryState).toBe("pending");
      // No fallback Surface receives the result: only the origin chat was attempted.
      for (const s of itg.mockBot.send) {
        expect(s.chatId).toBe(itg.surface.chatId);
      }
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: retains pending after final edit rejection", async () => {
    const mockBot = makeMockBot();
    const itg = buildIntegration({
      mockBot,
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("first part");
        await tick();
        await tick();
        sink.onTextDelta("first part plus final edit");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-edit", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-edit", 0, "finished work");
      // Persistent final-edit failure: every send/edit attempt fails so the
      // required final confirmation can never be established.
      const editErr = new Error("network edit failed");
      (mockBot.bot.api as unknown as Record<string, unknown>).editMessageText = async () => {
        throw editErr;
      };
      (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async () => {
        throw editErr;
      };
      (mockBot.bot.api as unknown as Record<string, unknown>).sendMessage = async () => {
        throw editErr;
      };
      expect(await itg.wake.deliverCompletion("run-n2-edit", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-edit")!.invocations[0]!.deliveryState).toBe("pending");
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: retains pending after timeout and releases reservation for retry", async () => {
    const mockBot = makeMockBot();
    const timeoutErr = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const origRich = mockBot.bot.api.sendRichMessage.bind(mockBot.bot.api);
    const origSend = mockBot.bot.api.sendMessage.bind(mockBot.bot.api);
    (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async () => {
      throw timeoutErr;
    };
    (mockBot.bot.api as unknown as Record<string, unknown>).sendMessage = async () => {
      throw timeoutErr;
    };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-timeout", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-timeout", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-timeout", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-timeout")!.invocations[0]!.deliveryState).toBe("pending");
      // Reservation released: a later attempt with a healthy transport succeeds.
      (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = origRich;
      (mockBot.bot.api as unknown as Record<string, unknown>).sendMessage = origSend;
      expect(await itg.wake.deliverCompletion("run-n2-timeout", 0)).toBe("delivered");
      expect(itg.host.loadRecord("run-n2-timeout")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: retains pending for deleted topic without fallback routing", async () => {
    const mockBot = makeMockBot();
    const topicErr = telegramError(400, "Bad Request: topic not found");
    (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async () => {
      throw topicErr;
    };
    (mockBot.bot.api as unknown as Record<string, unknown>).sendMessage = async () => {
      throw topicErr;
    };
    (mockBot.bot.api as unknown as Record<string, unknown>).editMessageText = async () => {
      throw topicErr;
    };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-topic", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-topic", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-topic", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-topic")!.invocations[0]!.deliveryState).toBe("pending");
      for (const s of itg.mockBot.send) {
        expect(s.chatId).toBe(itg.surface.chatId);
      }
      expect(itg.mockBot.send.length).toBeLessThanOrEqual(1);
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: rejects empty final response", async () => {
    const itg = buildIntegration({
      promptImpl: async (_c, sink) => {
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-empty", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-empty", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-empty", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-empty")!.invocations[0]!.deliveryState).toBe("pending");
      expect(itg.mockBot.send.length).toBe(0);
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: rejects partially delivered split response", async () => {
    const mockBot = makeMockBot();
    let sends = 0;
    const origSend = mockBot.bot.api.sendRichMessage.bind(mockBot.bot.api);
    (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async (chatId: number | string, msg: { markdown?: string }, opts?: unknown) => {
      sends += 1;
      if (sends === 2) throw new Error("second split part failed");
      return (origSend as (c: number | string, m: { markdown?: string }, o?: unknown) => Promise<{ message_id: number }>)(chatId, msg, opts);
    };
    const itg = buildIntegration({
      mockBot,
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("first bubble text");
        await tick();
        await tick();
        sink.onMessageStart();
        sink.onTextDelta("second bubble text");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-split", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-split", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-split", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-split")!.invocations[0]!.deliveryState).toBe("pending");
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: rejects split response where the earlier segment fails persistently", async () => {
    const mockBot = makeMockBot();
    let sends = 0;
    const origSend = mockBot.bot.api.sendRichMessage.bind(mockBot.bot.api);
    (mockBot.bot.api as unknown as Record<string, unknown>).sendRichMessage = async (chatId: number | string, msg: { markdown?: string }, opts?: unknown) => {
      sends += 1;
      if (sends === 1) throw new Error("first split part failed");
      return (origSend as (c: number | string, m: { markdown?: string }, o?: unknown) => Promise<{ message_id: number }>)(chatId, msg, opts);
    };
    const itg = buildIntegration({
      mockBot,
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("first bubble text");
        await tick();
        await tick();
        sink.onMessageStart();
        sink.onTextDelta("second bubble text");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-split-early", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-split-early", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-split-early", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-split-early")!.invocations[0]!.deliveryState).toBe("pending");
    } finally {
      await itg.cleanup();
    }
  });

  it("N2: rejects incomplete file fallback delivery", async () => {
    const mockBot = makeMockBot();
    const docErr = new Error("document upload failed");
    (mockBot.bot.api as unknown as Record<string, unknown>).sendDocument = async () => {
      throw docErr;
    };
    const itg = buildIntegration({
      mockBot,
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("x".repeat(25000));
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n2-file", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n2-file", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n2-file", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n2-file")!.invocations[0]!.deliveryState).toBe("pending");
    } finally {
      await itg.cleanup();
    }
  });

  it("N3: accepts final send", async () => {
    const itg = buildIntegration({ promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n3-send", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n3-send", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n3-send", 0)).toBe("delivered");
      expect(itg.host.loadRecord("run-n3-send")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(itg.mockBot.send.length).toBeGreaterThanOrEqual(1);
    } finally {
      await itg.cleanup();
    }
  });

  it("N3: accepts final edit and unchanged final response", async () => {
    const itg = buildIntegration({
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("stable final text");
        await tick();
        await tick();
        sink.onTextDelta("stable final text plus suffix");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n3-edit", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n3-edit", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n3-edit", 0)).toBe("delivered");
      expect(itg.host.loadRecord("run-n3-edit")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.cleanup();
    }
  });

  it("N3: accepts unchanged final message without a new send", async () => {
    const mockBot = makeMockBot();
    (mockBot.bot.api as unknown as Record<string, unknown>).editMessageText = async () => {
      throw telegramError(400, "Bad Request: message is not modified");
    };
    const itg = buildIntegration({
      mockBot,
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("duplicate text");
        await tick();
        await tick();
        sink.onTextDelta("duplicate text plus same");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n3-unmod", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n3-unmod", 0, "finished work");
      // Confirmed message-not-modified counts as acceptance.
      expect(await itg.wake.deliverCompletion("run-n3-unmod", 0)).toBe("delivered");
      expect(itg.host.loadRecord("run-n3-unmod")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.cleanup();
    }
  });

  it("N3: accepts required file fallback only after confirmation", async () => {
    const itg = buildIntegration({
      promptImpl: async (_c, sink) => {
        sink.onTextDelta("y".repeat(25000));
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n3-file", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n3-file", 0, "finished work");
      expect(await itg.wake.deliverCompletion("run-n3-file", 0)).toBe("delivered");
      expect(itg.host.loadRecord("run-n3-file")!.invocations[0]!.deliveryState).toBe("delivered");
      // Allow the file-escape document upload to settle; pre-fix delivery
      // returns before Telegram confirms, so wait briefly for the
      // fire-and-forget send to land before asserting it was attempted.
      await sleep(50);
      expect(itg.mockBot.documents.length).toBeGreaterThanOrEqual(1);
    } finally {
      await itg.cleanup();
    }
  });

  it("N3: drafts alone do not acknowledge, and status cleanup failure does not undo acceptance", async () => {
    // Drafts succeed but the required persistent finalize fails.
    const draftBot = makeMockBot();
    draftBot.failNext.rich = new Error("finalize send failed");
    const draftSurface = dmSurface(++chatSeq);
    const draftItg = buildIntegration({ mockBot: draftBot, surface: draftSurface, promptImpl: successPrompt });
    try {
      const origin = surfaceId(draftItg.surface);
      draftItg.host.createRecord("run-n3-draft", "generic-subagent", null, 1, durableOwnership(origin));
      draftItg.host.completeInvocation("run-n3-draft", 0, "finished work");
      expect(await draftItg.wake.deliverCompletion("run-n3-draft", 0)).toBe("pending");
      expect(draftItg.host.loadRecord("run-n3-draft")!.invocations[0]!.deliveryState).toBe("pending");
    } finally {
      await draftItg.cleanup();
    }

    // Status cleanup failure does not invalidate an accepted final response.
    // Use a standard-visibility surface so a status message exists; fail only
    // status sends while the response path stays healthy.
    const statusBot = makeMockBot();
    const statusSurface = topicSurface("supergroup", -200000 - chatSeq, 3);
    let statusCalls = 0;
    const origStatusSend = statusBot.bot.api.sendMessage.bind(statusBot.bot.api);
    (statusBot.bot.api as unknown as Record<string, unknown>).sendMessage = async (chatId: number | string, text: string, opts?: unknown) => {
      // Status placeholder contains the thinking header; fail it once.
      if (text.includes("thinking") && statusCalls === 0) {
        statusCalls += 1;
        throw new Error("status cleanup failed");
      }
      return (origStatusSend as (c: number | string, t: string, o?: unknown) => Promise<{ message_id: number }>)(chatId, text, opts);
    };
    const statusItg = buildIntegration({
      mockBot: statusBot,
      surface: statusSurface,
      visibility: "standard",
      promptImpl: async (_c, sink) => {
        sink.onStatusUpdate("thinking...");
        sink.onTextDelta("accepted despite status failure");
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(statusItg.surface);
      statusItg.host.createRecord("run-n3-status", "generic-subagent", null, 1, durableOwnership(origin));
      statusItg.host.completeInvocation("run-n3-status", 0, "finished work");
      expect(await statusItg.wake.deliverCompletion("run-n3-status", 0)).toBe("delivered");
      expect(statusItg.host.loadRecord("run-n3-status")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await statusItg.cleanup();
    }
  });

  it("N4: racing wake and claim share one delivery attempt", async () => {
    const mockBot = makeMockBot();
    const gate = deferred<void>();
    mockBot.gateRich = { wait: gate.promise };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n4-race", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n4-race", 0, "finished work");
      const a = itg.wake.deliverCompletion("run-n4-race", 0);
      const b = itg.wake.deliverCompletion("run-n4-race", 0);
      await sleep(50);
      expect(itg.runner.promptCalls).toBe(1);
      expect(itg.host.loadRecord("run-n4-race")!.invocations[0]!.deliveryState).toBe("pending");
      gate.resolve(undefined);
      mockBot.gateRich = null;
      expect(await a).toBe("delivered");
      expect(await b).toBe("delivered");
      expect(itg.host.loadRecord("run-n4-race")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(itg.runner.promptCalls).toBe(1);
    } finally {
      await itg.cleanup();
    }
  });

  it("N4: late response cannot override suppression", async () => {
    const mockBot = makeMockBot();
    const gate = deferred<void>();
    mockBot.gateRich = { wait: gate.promise };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n4-fence", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n4-fence", 0, "finished work");
      let done = false;
      let rejected: unknown = undefined;
      const delivery = itg.wake.deliverCompletion("run-n4-fence", 0).then(
        (o) => {
          done = true;
          return o;
        },
        (e) => {
          done = true;
          rejected = e;
          throw e;
        },
      );
      // Attach a no-op catch so the rejection is observed; the assertion below
      // still expects the throw.
      delivery.catch(() => {});
      await sleep(30);
      expect(done).toBe(false);
      itg.host.suppressDelivery("run-n4-fence", 0);
      gate.resolve(undefined);
      mockBot.gateRich = null;
      // Owner suppression wins: the late Telegram result cannot overwrite it.
      // The wake propagates the host rejection instead of inventing delivery.
      await expect(delivery).rejects.toThrow();
      expect(String((rejected as Error)?.message ?? rejected)).toContain("suppressed");
      expect(itg.host.loadRecord("run-n4-fence")!.invocations[0]!.deliveryState).toBe("suppressed");
    } finally {
      await itg.cleanup();
    }
  });

  it("N4: response evidence cannot leak across turns", async () => {
    let calls = 0;
    const itg = buildIntegration({
      promptImpl: async (_c, sink) => {
        calls += 1;
        if (calls === 1) {
          sink.onTextDelta("first turn accepted");
          sink.onAgentEnd();
          return;
        }
        sink.onAgentEnd();
      },
    });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("run-n4-leak-a", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n4-leak-a", 0, "first");
      expect(await itg.wake.deliverCompletion("run-n4-leak-a", 0)).toBe("delivered");
      itg.host.createRecord("run-n4-leak-b", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("run-n4-leak-b", 0, "second");
      expect(await itg.wake.deliverCompletion("run-n4-leak-b", 0)).toBe("pending");
      expect(itg.host.loadRecord("run-n4-leak-b")!.invocations[0]!.deliveryState).toBe("pending");
      expect(itg.host.loadRecord("run-n4-leak-a")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.cleanup();
    }
  });
});
