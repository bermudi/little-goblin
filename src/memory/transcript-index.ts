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
import { statePath } from "../sessions/paths.ts";
import { extractEntryText, type TranscriptEntry } from "../sessions/transcript.ts";
import type { MemoryStore } from "./store.ts";

const DEFAULT_MAX_CHUNK_CHARS = 500;

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

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
}

function extractChatId(home: string, sessionId: string): string | null {
  try {
    const state = readJsonFile(statePath(home, sessionId)) as Record<string, unknown> | undefined;
    if (state && typeof state.chatId === "number") {
      return String(state.chatId);
    }
  } catch {
    // Fall through to null.
  }
  return null;
}

/**
 * Chunk a transcript entry's text into bounded snippets (max 500 chars by
 * default). Keeps message-level granularity when the message fits; splits by
 * sentences and, only as a last resort, by words for very long messages.
 */
export function chunkTranscriptEntry(entry: TranscriptEntry, maxChars = DEFAULT_MAX_CHUNK_CHARS): string[] {
  const text = extractEntryText(entry.content).trim();
  if (text.replace(/\s/g, "").length < 8) return [];
  if (text.length <= maxChars) return [text];

  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // Flush any pending smaller chunk first.
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      // Split the oversized sentence by words with a rough overlap.
      const words = sentence.split(/\s+/);
      let piece = "";
      for (const word of words) {
        if (piece.length + word.length + 1 > maxChars && piece.length > 0) {
          chunks.push(piece.trim());
          piece = "";
        }
        piece = piece.length === 0 ? word : `${piece} ${word}`;
      }
      if (piece.length > 0) chunks.push(piece.trim());
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current = current.length === 0 ? sentence : `${current} ${sentence}`;
  }
  if (current.length > 0) chunks.push(current.trim());
  return chunks;
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
      const chatId = extractChatId(home, entry.name);
      if (chatId === "0") continue;
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

        const chatId = extractChatId(this.home, tf.sessionId);

        const chunks: Array<{
          text: string;
          createdAt: number;
          updatedAt: number;
          sourceSession: string;
          sourceRole: string;
        }> = [];
        const raw = readFileSync(tf.path, "utf-8");
        const lines = raw.split("\n");
        const timestampBase = stats.mtimeMs;
        let lineIndex = 0;
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let entry: TranscriptEntry;
          try {
            entry = JSON.parse(line) as TranscriptEntry;
          } catch {
            lineIndex++;
            continue;
          }
          const displayText = extractEntryText(entry.content).trim();
          if (displayText.replace(/\s/g, "").length < 8) {
            lineIndex++;
            continue;
          }
          const entryTime = typeof entry.timestamp === "number" ? entry.timestamp * 1000 : timestampBase;
          const ts = typeof entry.ts === "string" ? entry.ts : new Date(entryTime).toISOString();
          const role = entry.role ?? "unknown";
          const prefix = `[${ts}] [${role}] [${tf.sessionId}] `;
          const available = Math.max(8, DEFAULT_MAX_CHUNK_CHARS - prefix.length);
          const rawChunks = chunkTranscriptEntry(entry, available);
          for (const chunk of rawChunks) {
            chunks.push({
              text: `${prefix}${chunk}`,
              createdAt: entryTime + lineIndex,
              updatedAt: entryTime,
              sourceSession: tf.sessionId,
              sourceRole: role,
            });
          }
          lineIndex++;
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
