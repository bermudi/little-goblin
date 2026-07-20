/**
 * Bundles the SQLite-backed memory store pieces used by the rest of the app.
 *
 * - One shared `EmbeddingProvider` for cached OpenAI embeddings.
 * - A read-only-ish `MemoryStore` for lookups/intake.
 * - A `TranscriptIndexer` for syncing session transcripts.
 *
 * Callers that mutate memory (AgentRunner, subagent execution) should create
 * their own `MemoryStore` instances using `this.embeddingProvider` so each gets
 * its own SQLite connection while sharing the embedding cache/cooldown state.
 */

import { mkdirSync } from "node:fs";
import { MemoryDatabase } from "./db.ts";
import { EmbeddingProvider } from "./embeddings.ts";
import { MemoryStore } from "./store.ts";
import { TranscriptIndexer } from "./transcript-index.ts";
import { DreamingPipeline } from "./dreaming.ts";
import { migrateFromMarkdown } from "./migration.ts";
import { memoryDbPath, memoryDir } from "./paths.ts";

export class MemoryEngine {
  private readonly home: string;
  readonly readDatabase: MemoryDatabase;
  readonly readStore: MemoryStore;
  readonly embeddingProvider: EmbeddingProvider;
  readonly transcriptIndexer: TranscriptIndexer;
  readonly dreaming: DreamingPipeline;

  constructor(home: string, apiKey?: string) {
    this.home = home;
    mkdirSync(memoryDir(home), { recursive: true });
    this.readDatabase = new MemoryDatabase(memoryDbPath(home));
    this.embeddingProvider = new EmbeddingProvider(this.readDatabase, apiKey);
    this.readStore = new MemoryStore(this.readDatabase, undefined, { embeddings: this.embeddingProvider });
    this.transcriptIndexer = new TranscriptIndexer(home, this.readStore);
    this.dreaming = new DreamingPipeline({ goblinHome: home, store: this.newStore() });
  }

  /**
   * One-shot migration of legacy markdown memory files into SQLite. No-op if
   * already migrated. Run this once at startup before the bot starts serving
   * turns.
   */
  async migrate(): Promise<boolean> {
    return migrateFromMarkdown(this.home, this.readStore);
  }

  /**
   * Sync all session transcripts into the memory store. Returns counts of
   * indexed/removed files and inserted chunks. Run at startup and on a schedule.
   */
  async syncTranscripts(opts?: { maxDurationMs?: number }): Promise<{ indexed: number; removed: number; inserted: number }> {
    return this.transcriptIndexer.sync(opts?.maxDurationMs);
  }

  /**
   * Recompute embeddings if the configured embedding model has changed or a
   * previous reindex was interrupted. Exposed as a startup helper.
   */
  async reindexIfNeeded(): Promise<void> {
    return this.embeddingProvider.reindexIfNeeded();
  }

  /**
   * Create a fresh `MemoryStore` backed by its own SQLite connection but
   * sharing the embedding provider. Use this for each mutator (AgentRunner,
   * subagent turn) to avoid contention on the read-store connection.
   */
  newStore(metrics?: import("../metrics/mod.ts").MetricsStore): MemoryStore {
    return new MemoryStore(this.home, metrics, { embeddings: this.embeddingProvider });
  }
}
