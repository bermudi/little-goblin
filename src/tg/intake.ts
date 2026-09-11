import type { Bot } from "grammy";
import type { InlineQueryResult } from "@grammyjs/types";
import type { Config } from "../config.ts";
import { MemoryStore } from "../memory/mod.ts";
import { type Surface, type GuestSurface } from "../surface.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import type { McpRunner } from "../mcp/mod.ts";
import type { PendingCompletionClaim } from "../delegated-work/mod.ts";
import type {
  TurnDispatcher,
  PromptContent,
} from "../orchestration/dispatcher.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { ReplyOpts } from "./format.ts";
import type { ScheduleStore } from "../scheduler/store.ts";
import { createAudioHandler } from "./intake-audio.ts";
import { createDocumentHandler } from "./intake-document.ts";
import { createGuestMessageHandler } from "./intake-guest.ts";
import { createPhotoHandler } from "./intake-photo.ts";
import { createTextHandler, type TextIntakeDeps } from "./intake-text.ts";
import { createTopicDescriptionHandler } from "./intake-topic-description.ts";
import { createVoiceHandler } from "./intake-voice.ts";
import { type IntakeDeps } from "./intake-turn.ts";

export type { PromptContent };
export { replyNoActiveSession } from "./intake-text.ts";

export interface TelegramIntakeMessage {
  surface: Surface | null;
  reply: (text: string, opts?: ReplyOpts) => Promise<void>;
  prepare: (content: PromptContent) => PromptContent;
  /**
   * Telegram user id that sent the update (`ctx.from.id`). Threaded through
   * to command dispatch so deployment-wide mutations (e.g. `/mcp
   * enable|disable`) can enforce operator identity even when group @mentions
   * or replies let non-allowlisted users reach the handler.
   */
  invokingUserId?: number;
}

export interface TelegramDocumentInput {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export interface TelegramVoiceInput {
  fileId: string;
  mimeType?: string;
}

export interface TelegramAudioInput {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  performer?: string;
  title?: string;
  caption?: string;
}

/**
 * A guest summon: a validated guest Surface and a one-shot reply callback that
 * encapsulates `ctx.answerGuestQuery`. `guest_query_id` lives entirely inside
 * the closure — the intake MUST NOT name, log, or persist it. See design D5.
 */
export interface GuestMessage {
  surface: GuestSurface;
  replyVia: (result: InlineQueryResult) => Promise<unknown>;
}

export interface TelegramIntakeOptions {
  cfg: Config;
  bot: Bot;
  subagentRunner: SubagentRunner;
  memoryStore: MemoryStore;
  /** Runtime kernel assembled by the composition root. */
  dispatcher: TurnDispatcher;
  lifecycle: ConversationLifecycle;
  /** Shared schedule store for `/schedule`. */
  scheduleStore?: ScheduleStore;
  /** Shared MCP gateway runner for `/mcp`. Optional; absent when MCP is unconfigured. */
  mcpRunner?: McpRunner;
  /**
   * Decision-0036 pending-claim protocol. Ordinary content interactions and
   * authorized guest summons claim retained durable completions for their
   * exact Surface through the composition-wired completion wake.
   */
  pendingClaim: PendingCompletionClaim;
}

export function createTelegramIntake(options: TelegramIntakeOptions) {
  const { cfg, bot, subagentRunner, memoryStore, dispatcher, lifecycle, pendingClaim } = options;

  const deps: IntakeDeps = { cfg, dispatcher, lifecycle, pendingClaim, memoryStore };
  const textDeps: TextIntakeDeps = {
    ...deps,
    bot,
    subagentRunner,
    scheduleStore: options.scheduleStore,
    mcpRunner: options.mcpRunner,
  };

  return {
    handleText: createTextHandler(textDeps),
    handlePhoto: createPhotoHandler(deps),
    handleDocument: createDocumentHandler(deps),
    handleVoice: createVoiceHandler(deps),
    handleAudio: createAudioHandler(deps),
    handleTopicDescription: createTopicDescriptionHandler(deps),
    handleGuestMessage: createGuestMessageHandler(deps),
    dispatcher,
    lifecycle,
  };
}
