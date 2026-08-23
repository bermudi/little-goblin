import { join } from "node:path";
import type { MemoryScope } from "./scope.ts";

/**
 * Pure path utilities for the curated memory store filesystem layout.
 */

/**
 * Path to the memory directory at $GOBLIN_HOME/state/memory/.
 */
export function memoryDir(home: string): string {
  return join(home, "state", "memory");
}

export function memoryDbPath(home: string): string {
  return join(memoryDir(home), "memory.sqlite");
}

export function dreamsDir(home: string): string {
  return join(memoryDir(home), "dreams");
}

export function quarantinePath(home: string): string {
  return join(memoryDir(home), "quarantine.jsonl");
}

export function quarantineRotatedPath(home: string, date: string, sequence = 0): string {
  return sequence === 0
    ? join(memoryDir(home), `quarantine-${date}.jsonl`)
    : join(memoryDir(home), `quarantine-${date}-${sequence}.jsonl`);
}

export function dreamDiaryPath(home: string, date: string): string {
  return join(dreamsDir(home), `${date}.md`);
}

/**
 * Path to the durable directory for one Telegram topic scope.
 *
 * Callers that need to inspect the scope container use this helper rather
 * than reconstructing `$GOBLIN_HOME/state/memory/topics/...` inline.
 */
export function topicScopeDir(home: string, chatId: number, topicId: number): string {
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
