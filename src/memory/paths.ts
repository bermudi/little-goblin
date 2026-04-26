import { join } from "node:path";

/**
 * Pure path utilities for the curated memory store filesystem layout.
 */

export type MemoryTarget = "memory" | "user";

/**
 * Path to the memory directory at $GOBLIN_HOME/memory/.
 */
export function memoryDir(home: string): string {
  return join(home, "memory");
}

/**
 * Path to the memory file for a given target.
 * - "memory" → memory.md
 * - "user"   → user.md
 */
export function memoryFilePath(home: string, target: MemoryTarget): string {
  return join(memoryDir(home), target === "memory" ? "memory.md" : "user.md");
}
