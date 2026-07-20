/**
 * Delta sync of session transcript files into the SQLite memory store.
 *
 * Transcript entries are chunked into snippets, embedded, and inserted with
 * `entry_kind = "transcript"` and `scope = "transcript/<sessionId>"`. The
 * `memory_sources` table tracks file hashes/mtimes so only changed files are
 * reindexed.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { log } from "../log.ts";
import { sessionsDir } from "../sessions/paths.ts";
import { loadState } from "../sessions/state.ts";
import { chunkTranscriptEntry, readTranscriptEntries } from "../sessions/transcript.ts";
import type { MemoryStore } from "./store.ts";

function hashBuffer(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

function fileHash(filePath: string): string {
  return hashBuffer(readFileSync(filePath));
}

function fileStat(filePath: string) {
  const s = statSync(filePath);
  return { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
}

interface TranscriptFile {
  sessionId: string;
  path: string;
}

function discoverTranscripts(home: string): TranscriptFile[] {
  const dir = sessionsDir(home);
  const result: TranscriptFile[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip internal non-chat sessions (e.g. the dreaming extractor) so their
      // synthetic transcripts are not re-indexed as user conversation data.
      const state = loadState(home, entry.name);
      if (state?.chatId === 0) continue;
      const transcriptFile = join(dir, entry.name, "transcript.jsonl");
      result.push({ sessionId: entry.name, path: transcriptFile });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return result;
}

function scopeForSession(sessionId: string): string {
  return `transcript/${sessionId}`;
}

export interface TranscriptSyncResult {
  /** Number of transcript files indexed or re-indexed. */
  indexed: number;
  /** Number of sessions removed because their transcript file is gone. */
  removed: number;
  /** Number of transcript entries inserted (chunks). */
  inserted: number;
}

export class TranscriptIndexer {
  private home: string;
  private store: MemoryStore;

  constructor(home: string, store: MemoryStore) {
    this.home = home;
    this.store = store;
  }

  /**
   * Sync all session transcript files with the memory store. Only files whose
   * mtime, size, or hash changed are re-indexed. Removed sessions have their
   * transcript entries purged. The pass is bounded to `maxDurationMs` so a
   * large backlog does not stall the scheduler tick.
   */
  async sync(maxDurationMs: number = Number.POSITIVE_INFINITY): Promise<TranscriptSyncResult> {
    const db = this.store.db.database;
    const seenPaths = new Set<string>();
    let indexed = 0;
    let removed = 0;
    let inserted = 0;
    const startMs = Date.now();
    const elapsed = () => Date.now() - startMs;

    const transcriptFiles = discoverTranscripts(this.home);
    for (const tf of transcriptFiles) {
      if (elapsed() > maxDurationMs) {
        log.warn("transcript sync exceeded time budget; resuming on next tick", {
          indexed,
          inserted,
          maxDurationMs,
        });
        return { indexed, removed, inserted };
      }
      seenPaths.add(tf.path);
      let stats: { mtimeMs: number; size: number };
      try {
        stats = fileStat(tf.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Session directory exists but transcript not yet written; skip.
          continue;
        }
        throw err;
      }

      const existing = db
        .query<{ hash: string | null; mtime: number; size: number }, { $path: string }>(
          "SELECT hash, mtime, size FROM memory_sources WHERE path = $path AND source = 'transcript'",
        )
        .get({ $path: tf.path });

      // Skip unchanged files by metadata to avoid re-reading.
      if (
        existing &&
        existing.hash &&
        existing.mtime === stats.mtimeMs &&
        existing.size === stats.size
      ) {
        continue;
      }

      try {
        const hash = fileHash(tf.path);
        if (existing && existing.hash === hash && existing.mtime === stats.mtimeMs && existing.size === stats.size) {
          // Hash matches despite mtime/size drift (unlikely); update source row.
          db.query(
            "INSERT OR REPLACE INTO memory_sources (path, source, hash, mtime, size, updated_at) VALUES ($path, 'transcript', $hash, $mtime, $size, $updated_at)",
          ).run({
            $path: tf.path,
            $hash: hash,
            $mtime: stats.mtimeMs,
            $size: stats.size,
            $updated_at: Date.now(),
          });
          continue;
        }

        const chatId = (() => {
          const state = loadState(this.home, tf.sessionId);
          return state !== null ? String(state.chatId) : null;
        })();

        const chunks: Array<{
          text: string;
          createdAt: number;
          updatedAt: number;
          sourceSession: string;
          sourceRole: string;
        }> = [];
        for (const { entry } of readTranscriptEntries(this.home, tf.sessionId)) {
          if (entry === null) continue;
          const rawChunks = chunkTranscriptEntry(entry, { sessionId: tf.sessionId });
          for (const chunk of rawChunks) {
            chunks.push({
              text: chunk.text,
              createdAt: chunk.createdAt,
              updatedAt: chunk.updatedAt,
              sourceSession: chunk.sessionId,
              sourceRole: chunk.role,
            });
          }
        }

        if (chunks.length > 0) {
          const ids = await this.store.syncTranscriptChunks(tf.path, tf.sessionId, chatId, chunks, {
            hash,
            mtime: stats.mtimeMs,
            size: stats.size,
          });
          inserted += ids.length;
        } else {
          // Still record the file metadata so unchanged files are skipped later.
          db.query(
            "INSERT OR REPLACE INTO memory_sources (path, source, hash, mtime, size, updated_at) VALUES ($path, 'transcript', $hash, $mtime, $size, $updated_at)",
          ).run({
            $path: tf.path,
            $hash: hash,
            $mtime: stats.mtimeMs,
            $size: stats.size,
            $updated_at: Date.now(),
          });
        }

        indexed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Session or transcript file removed after discovery; skip on this tick.
          continue;
        }
        throw err;
      }
    }

    // Purge transcripts for sessions that no longer exist.
    if (elapsed() > maxDurationMs) {
      log.warn("transcript sync exceeded time budget before purge; resuming on next tick", {
        indexed,
        inserted,
        maxDurationMs,
      });
      return { indexed, removed, inserted };
    }
    const knownSources = db
      .query<{ path: string }, Record<string, never>>("SELECT path FROM memory_sources WHERE source = 'transcript'")
      .all({});
    for (const { path } of knownSources) {
      if (elapsed() > maxDurationMs) {
        log.warn("transcript sync exceeded time budget during purge; resuming on next tick", {
          indexed,
          inserted,
          removed,
          maxDurationMs,
        });
        return { indexed, removed, inserted };
      }
      if (!seenPaths.has(path)) {
        const sessionId = relative(sessionsDir(this.home), path).split("/")[0];
        if (sessionId) {
          this.deleteScopeEntries(scopeForSession(sessionId));
          removed++;
        }
        db.query("DELETE FROM memory_sources WHERE path = $path").run({ $path: path });
      }
    }

    this.store.db.setMeta("last_transcript_sync", String(Date.now()));
    log.info("transcript sync complete", { indexed, removed, inserted });
    return { indexed, removed, inserted };
  }

  private deleteScopeEntries(scope: string): void {
    const db = this.store.db.database;
    const ids = db
      .query<{ id: string }, { $scope: string }>("SELECT id FROM memory_entries WHERE scope = $scope")
      .all({ $scope: scope })
      .map((r) => r.id);
    for (const id of ids) {
      db.query("DELETE FROM memory_entry_tags WHERE entry_id = $entry_id").run({ $entry_id: id });
      db.query("DELETE FROM memory_embeddings WHERE entry_id = $entry_id").run({ $entry_id: id });
      db.query("DELETE FROM memory_index_fts WHERE entry_id = $entry_id").run({ $entry_id: id });
      db.query("DELETE FROM memory_entries WHERE id = $entry_id").run({ $entry_id: id });
    }
  }
}
