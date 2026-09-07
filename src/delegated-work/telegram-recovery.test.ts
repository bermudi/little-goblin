import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import { dmSurface, guestSurface, topicSurface, surfaceId, type Surface } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import type { Config } from "../config.ts";
import { DelegatedWorkHost } from "./host.ts";
import { DurableCompletionWake } from "./delivery.ts";
import { PendingCompletionClaim } from "./claim.ts";
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
 * Production Telegram recovery verifier for issue #54 unit 2.
 *
 * Exercises retry eligibility across failed delivery and restart through the
 * production wake, dispatcher, and Telegram buffer/adapters with a fake model
 * backend and controllable Bot API. A FakeRail-only test is insufficient.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-telegram-recovery-"));
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
    gateRich: null,
    nextMessageId: 100,
  };
  const bot = {
    api: {
      sendMessage: async (chatId: number | string, text: string) => {
        if (state.gateRich !== null) {
          await state.gateRich.wait;
        }
        state.send.push({ chatId, text });
        return { message_id: ++state.nextMessageId };
      },
      sendRichMessage: async (chatId: number | string, richMessage: { markdown?: string }) => {
        if (state.gateRich !== null) {
          await state.gateRich.wait;
        }
        state.send.push({ chatId, text: richMessage.markdown ?? "" });
        return { message_id: ++state.nextMessageId };
      },
      sendRichMessageDraft: async (chatId: number | string, draftId: number, richMessage: { markdown?: string }) => {
        state.drafts.push({ chatId, draftId, text: richMessage.markdown ?? "" });
        return true;
      },
      sendMessageDraft: async (chatId: number | string, draftId: number, text: string) => {
        state.drafts.push({ chatId, draftId, text });
        return true;
      },
      editMessageText: async (chatId: number | string, messageId: number, textOrRich: string | { markdown?: string }) => {
        const text = typeof textOrRich === "string" ? textOrRich : (textOrRich.markdown ?? "");
        state.edit.push({ chatId, messageId, text });
        return true;
      },
      sendDocument: async (chatId: number | string) => {
        state.documents.push({ chatId });
        return { message_id: ++state.nextMessageId };
      },
      sendChatAction: async () => true,
    },
  } as unknown as Bot;
  state.bot = bot;
  return state;
}

/** Replace every persistent response write with a terminal failure. */
function failAllPersistentWrites(mockBot: MockBotState, err: unknown): void {
  const api = mockBot.bot.api as unknown as Record<string, unknown>;
  api["sendRichMessage"] = async () => { throw err; };
  api["sendMessage"] = async () => { throw err; };
  api["editMessageText"] = async () => { throw err; };
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
  ownedHome: boolean;
  host: DelegatedWorkHost;
  dispatcher: TurnDispatcher;
  runtimeHost: ConversationRuntimeHost;
  wake: DurableCompletionWake;
  claim: PendingCompletionClaim;
  bindings: Map<string, ConversationState>;
  mockBot: MockBotState;
  surface: Surface;
  conversation: ConversationState;
  runner: FakeAgentRunner;
  disposeRuntimes: () => Promise<void>;
}

let chatSeq = 60000;

function buildIntegration(opts: {
  home?: string;
  surface?: Surface;
  visibility?: "none" | "standard";
  promptImpl?: (content: unknown, sink: TurnSink) => Promise<void>;
  mockBot?: MockBotState;
} = {}): Integration {
  const home = opts.home ?? tempHome();
  const ownedHome = opts.home === undefined;
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
      void c;
      return adapters.createMessageBuffer(s, c);
    },
    createBetaTools: () => [],
    createAgentRunner: (() => runner) as unknown as (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner,
    surfaceRuntimeAuthority: permissiveAuthority(),
  });

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
  const claim = new PendingCompletionClaim(wake, host);

  return {
    home,
    ownedHome,
    host,
    dispatcher,
    runtimeHost,
    wake,
    claim,
    bindings,
    mockBot,
    surface,
    conversation,
    runner,
    disposeRuntimes: async () => {
      await runtimeHost.disposeAll().catch(() => {});
      if (ownedHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

async function successPrompt(_content: unknown, sink: TurnSink): Promise<void> {
  sink.onTextDelta("the completed result is ready");
  sink.onAgentEnd();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

describe("production Telegram recovery across failed delivery and restart", () => {
  it("R1: rejected production response remains pending on disk and recovers after restart on exact origin", async () => {
    const home = tempHome();
    const surface = topicSurface("supergroup", -100000 - ++chatSeq, 7);
    const origin = surfaceId(surface);
    const failBot = makeMockBot();
    failAllPersistentWrites(failBot, new Error("network send failed"));
    const failing = buildIntegration({ home, surface, mockBot: failBot, promptImpl: successPrompt });
    try {
      failing.host.createRecord("rec-r1", "generic-subagent", null, 1, durableOwnership(origin));
      failing.host.completeInvocation("rec-r1", 0, "finished work");
      expect(await failing.wake.deliverCompletion("rec-r1", 0)).toBe("pending");
      expect(failing.host.loadRecord("rec-r1")!.invocations[0]!.deliveryState).toBe("pending");
      for (const s of failing.mockBot.send) {
        expect(s.chatId).toBe(surface.chatId);
      }

      // The rejection left the on-disk invocation pending: a reconstructed
      // host over the same store still sees it pending for the exact origin.
      const restarted = new DelegatedWorkHost(home);
      expect(restarted.loadRecord("rec-r1")!.invocations[0]!.deliveryState).toBe("pending");
      expect(restarted.listRecordIds()).toContain("rec-r1");
    } finally {
      await failing.disposeRuntimes();
    }

    // Process restart: fresh services over the same home deliver and
    // acknowledge the retained completion through the exact origin only.
    const healthyBot = makeMockBot();
    const healthy = buildIntegration({ home, surface, mockBot: healthyBot, promptImpl: successPrompt });
    try {
      expect(healthy.claim.listPendingForSurface(origin).map((r) => r.runId)).toEqual(["rec-r1"]);
      expect(await healthy.claim.claimForInteraction(surface)).toBe(1);
      expect(healthy.host.loadRecord("rec-r1")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(healthy.mockBot.send.length).toBeGreaterThanOrEqual(1);
      for (const s of healthy.mockBot.send) {
        expect(s.chatId).toBe(surface.chatId);
      }
    } finally {
      await healthy.disposeRuntimes();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("R1: failed-delivery restart preserves unbound and guest authorization restrictions", async () => {
    const home = tempHome();
    const unbound = dmSurface(++chatSeq);
    const unboundId = surfaceId(unbound);
    const guest = guestSurface(++chatSeq);
    const guestId = surfaceId(guest);
    const healthyBot = makeMockBot();
    const itg = buildIntegration({ home, mockBot: healthyBot, promptImpl: successPrompt });
    // The guest origin is bound (a Conversation exists) to prove the wake
    // still refuses it without a summon; the unbound origin has no binding
    // and the wake must not create a Conversation for it.
    itg.bindings.set(guestId, boundConversation("conversation-guest-r1"));
    const bindingsBefore = itg.bindings.size;
    try {
      itg.host.createRecord("rec-r1-unbound", "generic-subagent", null, 1, durableOwnership(unboundId));
      itg.host.completeInvocation("rec-r1-unbound", 0, "unbound result");
      itg.host.createRecord("rec-r1-guest", "generic-subagent", null, 1, durableOwnership(guestId));
      itg.host.completeInvocation("rec-r1-guest", 0, "guest result");

      expect(await itg.wake.deliverCompletion("rec-r1-unbound", 0)).toBe("pending");
      expect(await itg.wake.deliverCompletion("rec-r1-guest", 0)).toBe("pending");
      expect(itg.mockBot.send.length).toBe(0);
      expect(itg.bindings.size).toBe(bindingsBefore);
      expect(itg.bindings.has(unboundId)).toBe(false);

      // Restart: a reconstructed host still sees both pending.
      const restarted = new DelegatedWorkHost(home);
      expect(restarted.loadRecord("rec-r1-unbound")!.invocations[0]!.deliveryState).toBe("pending");
      expect(restarted.loadRecord("rec-r1-guest")!.invocations[0]!.deliveryState).toBe("pending");

      // Ordinary interaction claims nothing for the unbound origin and the
      // guest path still requires a summon; no fallback send occurs. Guest
      // summon recovery itself rides the same wake acknowledgement path and
      // is covered by the claim suite; here the production boundary must
      // prove the restriction survives restart without sending anywhere.
      const restartedClaim = new PendingCompletionClaim(
        new DurableCompletionWake(
          {
            resolveCurrent: async (s: Surface) => itg.bindings.get(surfaceId(s)) ?? null,
            enqueueScheduledTurn: (conv, surf, content, onError) =>
              itg.dispatcher.enqueueScheduledTurn(conv, surf, content, onError),
          },
          restarted,
        ),
        restarted,
      );
      expect(await restartedClaim.claimForInteraction(unbound)).toBe(0);
      expect(await restartedClaim.claimForInteraction(guest)).toBe(0);
      expect(restarted.loadRecord("rec-r1-unbound")!.invocations[0]!.deliveryState).toBe("pending");
      expect(restarted.loadRecord("rec-r1-guest")!.invocations[0]!.deliveryState).toBe("pending");
      expect(itg.mockBot.send.length).toBe(0);
      expect(itg.bindings.has(unboundId)).toBe(false);
    } finally {
      await itg.disposeRuntimes();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("R2: failed final response releases reservation for later successful claim", async () => {
    const mockBot = makeMockBot();
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("rec-r2", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("rec-r2", 0, "finished work");
      failAllPersistentWrites(mockBot, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      expect(await itg.wake.deliverCompletion("rec-r2", 0)).toBe("pending");
      expect(itg.host.loadRecord("rec-r2")!.invocations[0]!.deliveryState).toBe("pending");

      // Reservation released: a later authorized claim with a healthy
      // transport succeeds without restart.
      const healthyBot = makeMockBot();
      const api = mockBot.bot.api as unknown as Record<string, unknown>;
      const healthyApi = healthyBot.bot.api as unknown as Record<string, unknown>;
      api["sendRichMessage"] = healthyApi["sendRichMessage"];
      api["sendMessage"] = healthyApi["sendMessage"];
      api["editMessageText"] = healthyApi["editMessageText"];
      expect(await itg.claim.claimForInteraction(itg.surface)).toBe(1);
      expect(itg.host.loadRecord("rec-r2")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.disposeRuntimes();
    }
  });

  it("R2: restart rearm racing claim has one active final-delivery attempt", async () => {
    const mockBot = makeMockBot();
    const gate = deferred<void>();
    mockBot.gateRich = { wait: gate.promise };
    const itg = buildIntegration({ mockBot, promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("rec-r2-race", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("rec-r2-race", 0, "finished work");
      const rearm = itg.claim.rearmAtStartup();
      const claim = itg.claim.claimForInteraction(itg.surface);
      await sleep(50);
      // One active attempt while the final Telegram acceptance is delayed.
      expect(itg.runner.promptCalls).toBe(1);
      expect(itg.host.loadRecord("rec-r2-race")!.invocations[0]!.deliveryState).toBe("pending");
      gate.resolve(undefined);
      mockBot.gateRich = null;
      const [rearmed, claimed] = await Promise.all([rearm, claim]);
      expect(rearmed + claimed).toBeGreaterThanOrEqual(1);
      expect(itg.host.loadRecord("rec-r2-race")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(itg.runner.promptCalls).toBe(1);
      expect(itg.mockBot.send.length).toBe(1);
    } finally {
      await itg.disposeRuntimes();
    }
  });

  it("R3: acknowledgement write failure after accepted response propagates and preserves recoverable pending record", async () => {
    const itg = buildIntegration({ promptImpl: successPrompt });
    try {
      const origin = surfaceId(itg.surface);
      itg.host.createRecord("rec-r3-ack", "generic-subagent", null, 1, durableOwnership(origin));
      itg.host.completeInvocation("rec-r3-ack", 0, "finished work");

      const ackErr = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const hostView = itg.host as unknown as {
        acknowledgeDelivery: (runId: string, index: number) => unknown;
      };
      const origAck = hostView.acknowledgeDelivery.bind(itg.host);
      let ackCalls = 0;
      hostView.acknowledgeDelivery = (runId: string, index: number): unknown => {
        ackCalls += 1;
        if (ackCalls === 1) throw ackErr;
        return origAck(runId, index);
      };

      let thrown: unknown;
      try {
        await itg.wake.deliverCompletion("rec-r3-ack", 0);
      } catch (err) {
        thrown = err;
      }
      // The failure propagates with run, invocation, and Surface identity.
      expect(thrown).toBeDefined();
      expect(errorMessage(thrown)).toContain("rec-r3-ack");
      expect(errorMessage(thrown)).toContain("0");
      expect(errorMessage(thrown)).toContain(origin);
      // Telegram accepted the final response, but the persisted state stays
      // pending and recoverable.
      expect(itg.mockBot.send.length).toBeGreaterThanOrEqual(1);
      expect(itg.host.loadRecord("rec-r3-ack")!.invocations[0]!.deliveryState).toBe("pending");
      const restarted = new DelegatedWorkHost(itg.home);
      expect(restarted.loadRecord("rec-r3-ack")!.invocations[0]!.deliveryState).toBe("pending");

      // A later attempt with a healthy store succeeds.
      hostView.acknowledgeDelivery = origAck;
      expect(await itg.wake.deliverCompletion("rec-r3-ack", 0)).toBe("delivered");
      expect(itg.host.loadRecord("rec-r3-ack")!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      await itg.disposeRuntimes();
    }
  });

  it("R3: restart after acceptance before local acknowledgement retries pending rather than inventing delivery", async () => {
    const home = tempHome();
    const surface = topicSurface("supergroup", -100000 - ++chatSeq, 7);
    const origin = surfaceId(surface);
    const first = buildIntegration({ home, surface, promptImpl: successPrompt });
    try {
      first.host.createRecord("rec-r3-dup", "generic-subagent", null, 1, durableOwnership(origin));
      first.host.completeInvocation("rec-r3-dup", 0, "finished work");

      // Telegram accepts, then the acknowledgement write fails: the process
      // "dies" between acceptance and persistence.
      const ackErr = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const hostView = first.host as unknown as {
        acknowledgeDelivery: (runId: string, index: number) => unknown;
      };
      const origAck = hostView.acknowledgeDelivery.bind(first.host);
      hostView.acknowledgeDelivery = (): unknown => { throw ackErr; };
      await expect(first.wake.deliverCompletion("rec-r3-dup", 0)).rejects.toThrow();
      expect(first.mockBot.send.length).toBeGreaterThanOrEqual(1);
      hostView.acknowledgeDelivery = origAck;

      // A reconstructed host still sees pending: nothing invented delivery
      // from execution completion or prior partial output.
      const restarted = new DelegatedWorkHost(home);
      expect(restarted.loadRecord("rec-r3-dup")!.invocations[0]!.deliveryState).toBe("pending");
      expect(restarted.listRecordIds()).toContain("rec-r3-dup");
    } finally {
      await first.disposeRuntimes();
    }

    // Restart: fresh services retry through Telegram (a visible duplicate)
    // and then acknowledge; delivery is not invented without a send.
    const second = buildIntegration({ home, surface, promptImpl: successPrompt });
    try {
      expect(second.host.loadRecord("rec-r3-dup")!.invocations[0]!.deliveryState).toBe("pending");
      expect(await second.wake.deliverCompletion("rec-r3-dup", 0)).toBe("delivered");
      expect(second.host.loadRecord("rec-r3-dup")!.invocations[0]!.deliveryState).toBe("delivered");
      expect(second.mockBot.send.length).toBeGreaterThanOrEqual(1);
      for (const s of second.mockBot.send) {
        expect(s.chatId).toBe(surface.chatId);
      }
    } finally {
      await second.disposeRuntimes();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
