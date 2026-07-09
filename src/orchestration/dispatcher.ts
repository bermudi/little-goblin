import type { Bot } from "grammy";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AgentRunner, type TurnCallbacks } from "../agent/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import { SessionManager, type ChatLocator, type SessionState } from "../sessions/mod.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import {
  createSendDocumentTool,
  createSendPhotoTool,
  createSendVoiceTool,
} from "../tg/tools.ts";
import { createTextToSpeechTool } from "../tg/mod.ts";

/** Prompt content accepted by a runner: a string or multimodal parts. */
export type PromptContent = string | (TextContent | ImageContent)[];

/**
 * The opaque sink a turn dispatches through — the subset of `MessageBuffer`
 * that `runner.prompt(content, sink)` consumes. Typed as `TurnCallbacks` so the
 * dispatcher does not depend on the concrete `MessageBuffer` type or on
 * `src/tg/`. The Telegram layer injects a factory that produces real
 * `MessageBuffer` instances; the dispatcher is transport-agnostic at the type
 * level.
 */
export type TurnSink = TurnCallbacks;

function buildGetTopicName(store: MemoryStore): (chatId: number, topicId: number) => Promise<string | null> {
  return async (chatId, topicId) => {
    const { description } = store.read({ topic: { chatId, topicId } });
    return description ?? null;
  };
}

function getBetaTools(
  bot: Bot,
  chatId: number,
  topicId?: number,
): ToolDefinition[] {
  return [
    createSendVoiceTool(bot, chatId, topicId),
    createSendPhotoTool(bot, chatId, topicId),
    createSendDocumentTool(bot, chatId, topicId),
    createTextToSpeechTool(),
  ].filter((t): t is NonNullable<typeof t> => t !== null);
}

export interface TurnDispatcherOptions {
  cfg: Config;
  bot: Bot;
  manager: SessionManager;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  agentRunners: Map<string, AgentRunner>;
  promptQueues?: Map<string, Promise<void>>;
  createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  /**
   * Mandatory factory that builds the turn sink for a locator. The dispatcher
   * never constructs a `MessageBuffer` itself — the Telegram-aware caller
   * (intake) injects this so rendering knowledge stays in `src/tg/`.
   */
  createMessageBuffer: (locator: ChatLocator) => TurnSink;
}

/**
 * Shared turn dispatcher: owns `AgentRunner` creation, per-session fresh-turn
 * queues, turn-sink creation, and runner disposal. Both Telegram intake and the
 * scheduled-turn scheduler dispatch through this so a due scheduled prompt and
 * a Telegram message serialize through the same per-session chain.
 *
 * The stale-runner guard (`isCurrent()`) is the linchpin: when a runner is
 * swapped (by `/new` or `/resume`) before a queued turn starts, the queued work
 * detects it is no longer current and aborts before producing user-visible side
 * effects.
 *
 * Lives in `src/orchestration/` — turn serialization is an orchestration
 * concern, not a Telegram concern. The dispatcher does not import the
 * `MessageBuffer` type; it obtains its turn sink through the injected
 * `createMessageBuffer` factory.
 */
export class TurnDispatcher {
  private readonly runners: Map<string, AgentRunner>;
  private readonly promptQueues: Map<string, Promise<void>>;
  private readonly cfg: Config;
  private readonly bot: Bot;
  private readonly manager: SessionManager;
  private readonly subagentRunner: SubagentRunner;
  private readonly memoryStore: MemoryStore;
  private readonly createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  private readonly createMessageBufferFn: (locator: ChatLocator) => TurnSink;
  private readonly getTopicName: (chatId: number, topicId: number) => Promise<string | null>;

  constructor(options: TurnDispatcherOptions) {
    this.cfg = options.cfg;
    this.bot = options.bot;
    this.manager = options.manager;
    this.subagentRunner = options.subagentRunner;
    this.memoryStore = options.memoryStore;
    this.runners = options.agentRunners;
    this.promptQueues = options.promptQueues ?? new Map<string, Promise<void>>();
    this.createAgentRunner = options.createAgentRunner;
    this.createMessageBufferFn = options.createMessageBuffer;
    this.getTopicName = buildGetTopicName(this.memoryStore);
  }

  /**
   * Return the current runner for a session, or null if none exists. Replaces
   * direct reads of the (now-private) `runners` map.
   */
  getRunner(sessionId: string): AgentRunner | null {
    return this.runners.get(sessionId) ?? null;
  }

  /**
   * True when a runner is currently registered for a session. Replaces direct
   * `runners.has(...)` reads of the (now-private) map.
   */
  hasRunner(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  /**
   * Construct a new `AgentRunner` for a session. `threadId` is the Telegram
   * thread id used to scope beta tools (voice/photo/document); for scheduled
   * turns it is derived from `locator.topicId`.
   */
  createRunner(session: SessionState, locator: ChatLocator, threadId?: number): AgentRunner {
    const chatId = locator.chatId;
    const betaTools = getBetaTools(this.bot, chatId, threadId);
    const runnerOpts: ConstructorParameters<typeof AgentRunner>[0] = {
      cfg: this.cfg,
      sessionId: session.id,
      locator,
      customTools: betaTools,
      subagentRunner: this.subagentRunner,
      getTopicName: this.getTopicName,
      projectDir: this.manager.getProjectDir(locator),
      modelName: session.modelName,
      thinkingLevel: session.thinkingLevel,
      pendingProjectNotice: this.manager.consumeProjectNotice(locator),
    };
    return this.createAgentRunner?.(runnerOpts) ?? new AgentRunner(runnerOpts);
  }

  /**
   * Return the existing runner for a session, creating one if none exists.
   */
  getOrCreateRunner(session: SessionState, locator: ChatLocator, threadId?: number): AgentRunner {
    const existing = this.runners.get(session.id);
    if (existing) return existing;

    const runner = this.createRunner(session, locator, threadId);
    this.runners.set(session.id, runner);
    log.debug("created runner for session", { sessionId: session.id });
    return runner;
  }

  /**
   * Build the turn sink for a locator via the injected factory. Always
   * delegates to `createMessageBufferFn` — there is no fallback, the factory
   * is mandatory at construction.
   */
  createMessageBuffer(locator: ChatLocator): TurnSink {
    return this.createMessageBufferFn(locator);
  }

  /**
   * Enqueue `run` on the per-session promise chain so work serializes. The
   * `isCurrent()` callback lets `run` detect that its runner has been swapped
   * out (by `/new`/`/resume`) and abort before side effects. `onError` handles
   * errors that escape `run`, gated by the same staleness check.
   *
   * This is the single serialization point shared by `/queue`, media prompts,
   * deferred commands, and scheduled turns.
   */
  schedulePrompt(
    session: SessionState,
    runner: AgentRunner,
    run: (isCurrent: () => boolean) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
  ): void {
    const isCurrent = (): boolean => this.runners.get(session.id) === runner;
    const execute = async (): Promise<void> => {
      if (!isCurrent()) return;
      try {
        await run(isCurrent);
      } catch (err) {
        if (!isCurrent()) return;
        try {
          await onError(err);
        } catch (handlerErr) {
          log.error("prompt error handler failed", { error: String(handlerErr), sessionId: session.id });
        }
      }
    };
    const prior = this.promptQueues.get(session.id);
    const current = prior ? prior.then(execute, execute) : execute();
    this.promptQueues.set(session.id, current);
    void current.finally(() => {
      if (this.promptQueues.get(session.id) === current) this.promptQueues.delete(session.id);
    });
  }

  /**
   * Dispose a session's runner and sever its prompt-queue chain so any queued
   * work for the stale runner aborts via the `isCurrent()` guard. Safe to call
   * when no runner exists (no-op).
   */
  disposeRunner(sessionId: string): void {
    this.promptQueues.delete(sessionId);
    const prior = this.runners.get(sessionId);
    if (prior) {
      try {
        prior.dispose();
      } finally {
        this.runners.delete(sessionId);
      }
    } else {
      this.runners.delete(sessionId);
    }
  }

  /**
   * Set a session's runner directly. Used when a command creates a new runner
   * (e.g. `/new`, `/resume`) outside the get-or-create path.
   */
  setRunner(session: SessionState, locator: ChatLocator, threadId?: number): AgentRunner {
    const runner = this.createRunner(session, locator, threadId);
    this.runners.set(session.id, runner);
    log.debug("created runner", { sessionId: session.id });
    return runner;
  }

  /**
   * Enqueue a scheduled prompt as a fresh turn for a session. The scheduler
   * calls this after binding validation passes. No `TelegramIntakeMessage` is
   * involved — scheduled prompts are synthetic and bypass Telegram
   * user-context preparation. The stale-runner guard applies: if the runner is
   * swapped before the queued turn starts, it aborts without side effects.
   */
  enqueueScheduledTurn(
    session: SessionState,
    locator: ChatLocator,
    content: PromptContent,
    onError?: (err: unknown) => void,
  ): void {
    const threadId = locator.topicId;
    const runner = this.getOrCreateRunner(session, locator, threadId);
    const buffer = this.createMessageBuffer(locator);
    this.schedulePrompt(
      session,
      runner,
      async (isCurrent) => {
        if (!isCurrent()) return;
        if (runner.isAbortTimedOut) {
          log.warn("scheduled turn dropped: runner is wedged after abort timed out", {
            sessionId: session.id,
          });
          return;
        }
        await runner.prompt(content, buffer);
      },
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("scheduled turn failed", { error: msg, sessionId: session.id });
        onError?.(err);
      },
    );
  }
}
