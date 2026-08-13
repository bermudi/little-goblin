import type { Bot } from "grammy";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { MemoryStore } from "../memory/mod.ts";
import { MetricsStore } from "../metrics/mod.ts";
import type { ConversationState } from "../sessions/types.ts";
import type { Surface } from "../surface.ts";
import type { TurnSink } from "../orchestration/mod.ts";
import { MessageBuffer, createTextToSpeechTool } from "./mod.ts";
import { createSendDocumentTool, createSendPhotoTool, createSendVoiceTool } from "./tools.ts";
import { isPrivateChat } from "./delivery.ts";

export interface TelegramRuntimeAdapters {
  readonly createMessageBuffer: (surface: Surface, conversation?: ConversationState) => TurnSink;
  readonly createBetaTools: (surface: Surface) => ToolDefinition[];
}

/** Telegram-owned factories injected into the transport-neutral runtime kernel. */
export function createTelegramRuntimeAdapters(options: {
  readonly cfg: Config;
  readonly bot: Bot;
  readonly memoryStore: MemoryStore;
  readonly createMessageBuffer?: (surface: Surface, conversation?: ConversationState) => TurnSink;
}): TelegramRuntimeAdapters {
  const createMessageBuffer = options.createMessageBuffer ?? ((surface: Surface, conversation?: ConversationState): TurnSink => {
    const metrics = conversation ? new MetricsStore(options.cfg.goblinHome, conversation.id) : undefined;
    return new MessageBuffer(options.bot, surface, {
      visibility: options.cfg.toolVisibility,
      metrics,
      drafts: isPrivateChat(surface),
      onTopicNotFound:
        surface.kind === "topic"
          ? async () => {
              await options.memoryStore.archiveOrphan(surface.chatId, surface.topicId);
            }
          : undefined,
    });
  });

  const createBetaTools = (surface: Surface) => {
    if (surface.kind === "guest") {
      return [createTextToSpeechTool()];
    }
    return [
      createSendVoiceTool(options.bot, surface),
      createSendPhotoTool(options.bot, surface),
      createSendDocumentTool(options.bot, surface),
      createTextToSpeechTool(),
    ].filter((tool): tool is NonNullable<typeof tool> => tool !== null);
  };

  return { createMessageBuffer, createBetaTools };
}
