/**
 * One-shot migration from legacy markdown memory files into the SQLite-backed
 * memory store. The filesystem enumeration and parsing now live inside
 * {@link MemoryStore.importFromLegacyMarkdown}; this module is a thin
 * compatibility wrapper.
 */

import { MemoryStore } from "./store.ts";

/**
 * Migrate legacy markdown memory files into the SQLite-backed memory store.
 * No-op if the store already has a `migrated_at` meta key. Returns true when
 * migration ran.
 */
export async function migrateFromMarkdown(home: string, store: MemoryStore): Promise<boolean> {
  return store.importFromLegacyMarkdown(home);
}
