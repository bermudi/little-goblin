import { join } from "node:path";
import type { MemoryScope } from "./scope.ts";

/**
 * Pure path utilities for the curated memory store filesystem layout.
 */

/**
 * Path to the memory directory at $GOBLIN_HOME/memory/.
 */
export function memoryDir(home: string): string {
  return join(home, "memory");
}

function topicScopeDir(home: string, chatId: number, topicId: number): string {
  return join(memoryDir(home), "topics", String(chatId), String(topicId));
}

export function scopeMemoryPath(home: string, scope: MemoryScope): string {
  if (scope === "general") return join(memoryDir(home), "general", "memory.md");
  if ("topic" in scope) {
    return join(topicScopeDir(home, scope.topic.chatId, scope.topic.topicId), "memory.md");
  }
  return join(memoryDir(home), "agents", scope.agent.name, "memory.md");
}

export function userPath(home: string): string {
  return join(memoryDir(home), "user.md");
}

export function archiveTopicPath(home: string, chatId: number, topicId: number): string {
  return join(memoryDir(home), "archive", "topics", String(chatId), String(topicId));
}
