import { log } from "../log.ts";
import type { MemoryDatabase } from "./db.ts";

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  object: string;
  usage: { total_tokens: number };
}

function hashText(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function env(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

export interface EmbeddingStatus {
  model: string;
  degraded: boolean;
  lastError?: string;
}

interface EmbeddingProviderState {
  degraded: boolean;
  degradedUntil: number;
  errorCount: number;
  lastError: string;
}

/**
 * OpenAI embedding provider with SQLite caching.
 *
 * - API key from GOBLIN_MEMORY_EMBEDDING_API_KEY, fallback OPENAI_API_KEY.
 * - Optional base URL from GOBLIN_MEMORY_EMBEDDING_BASE_URL, fallback OPENAI_BASE_URL.
 * - Model from GOBLIN_MEMORY_EMBEDDING_MODEL, default text-embedding-3-small.
 * - Degraded state with a cooldown after network/auth failures.
 *
 * Embeddings are cached in memory_embeddings keyed by the entry's id (foreign
 * key to memory_entries.id). Duplicate text hashes share the same vector but
 * get a row per entry_id so vector search can join cleanly.
 */
export class EmbeddingProvider {
  private db: MemoryDatabase;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private cooldownSeconds: number;
  private state: EmbeddingProviderState;
  private fetchedCache: Map<string, Float32Array>;

  constructor(db: MemoryDatabase, apiKey?: string) {
    this.db = db;
    this.apiKey = env("GOBLIN_MEMORY_EMBEDDING_API_KEY") ?? apiKey ?? env("OPENAI_API_KEY");
    this.baseUrl = env("GOBLIN_MEMORY_EMBEDDING_BASE_URL", env("OPENAI_BASE_URL", "https://api.openai.com"))!;
    this.model = env("GOBLIN_MEMORY_EMBEDDING_MODEL", "text-embedding-3-small")!;
    this.cooldownSeconds = Number(env("GOBLIN_MEMORY_EMBEDDING_COOLDOWN_SECONDS", "60"));
    this.state = { degraded: false, degradedUntil: 0, errorCount: 0, lastError: "" };
    this.fetchedCache = new Map();
  }

  get modelName(): string {
    return this.model;
  }

  status(): EmbeddingStatus {
    return {
      model: this.model,
      degraded: this.isDegraded(),
      lastError: this.state.lastError || undefined,
    };
  }

  isDegraded(): boolean {
    if (this.state.degraded && Date.now() >= this.state.degradedUntil) {
      this.state.degraded = false;
    }
    return this.state.degraded;
  }

  async embedQuery(
    text: string,
    model?: string,
  ): Promise<{ embedding: Float32Array | null; degraded: boolean }> {
    const results = await this.embedBatch([text], model);
    return { embedding: results[0]?.embedding ?? null, degraded: this.isDegraded() };
  }

  /**
   * Embed a batch of arbitrary texts. Returns embeddings by hash but does NOT
   * persist them under an entry id — use embedEntries for stored entries.
   */
  async embedBatch(
    texts: string[],
    model: string = this.model,
  ): Promise<Array<{ hash: string; embedding: Float32Array | null }>> {
    if (this.isDegraded()) {
      return texts.map((text) => ({ hash: hashText(text), embedding: null }));
    }
    if (!this.apiKey) {
      this.markDegraded("missing embedding API key");
      return texts.map((text) => ({ hash: hashText(text), embedding: null }));
    }

    const inputs = texts.map((text) => ({ text, hash: hashText(text) }));
    const unique = new Map<string, string>();
    for (const { text, hash } of inputs) {
      if (!unique.has(hash)) unique.set(hash, text);
    }

    const cache = this.loadCache(Array.from(unique.keys()), model, "openai");
    const toFetch: string[] = [];
    for (const [hash, text] of unique.entries()) {
      if (cache.has(hash)) continue;
      const fetchedKey = `${model}:${hash}`;
      const cached = this.fetchedCache.get(fetchedKey);
      if (cached) {
        cache.set(hash, cached);
      } else {
        toFetch.push(text);
      }
    }

    if (toFetch.length > 0) {
      try {
        const fetched = await this.fetchEmbeddings(toFetch, model);
        for (const [hash, embedding] of fetched.entries()) {
          cache.set(hash, embedding);
          this.fetchedCache.set(`${model}:${hash}`, embedding);
        }
      } catch (err) {
        this.markDegraded(err instanceof Error ? err.message : String(err));
        // Return null for any text that was not already cached.
      }
    }

    return inputs.map(({ hash }) => ({ hash, embedding: cache.get(hash) ?? null }));
  }

  /**
   * Embed and persist one memory entry.
   */
  async embedEntry(entryId: string, text: string): Promise<Float32Array | null> {
    const results = await this.embedEntries([{ entryId, text }]);
    return results.get(entryId) ?? null;
  }

  /**
   * Embed and persist a batch of memory entries. Returns a map of entryId to
   * embedding. Skips unchanged entries (same hash and model as the existing row)
   * without a network call.
   */
  async embedEntries(
    requests: { entryId: string; text: string }[],
    opts: { skipMeta?: boolean } = {},
  ): Promise<Map<string, Float32Array | null>> {
    const result = new Map<string, Float32Array | null>();
    if (requests.length === 0) return result;

    // Skip entries whose cached hash and model already match.
    const toEmbed: { entryId: string; text: string; hash: string }[] = [];
    const existingHashQuery = this.db.database.query<
      { hash: string; model: string; provider: string },
      { $entryId: string }
    >("SELECT hash, model, provider FROM memory_embeddings WHERE entry_id = $entryId");
    for (const req of requests) {
      const hash = hashText(req.text);
      const existing = existingHashQuery.get({ $entryId: req.entryId });
      if (
        existing &&
        existing.hash === hash &&
        existing.model === this.model &&
        existing.provider === "openai"
      ) {
        const cached = this.loadCache([hash], this.model, "openai").get(hash);
        result.set(req.entryId, cached ?? null);
        continue;
      }
      toEmbed.push({ entryId: req.entryId, text: req.text, hash });
    }

    if (toEmbed.length === 0) return result;

    const uniqueTexts = Array.from(new Set(toEmbed.map((r) => r.text)));
    const batch = await this.embedBatch(uniqueTexts);
    const byText = new Map<string, Float32Array | null>();
    for (const item of batch) {
      byText.set(uniqueTexts.find((t) => hashText(t) === item.hash) ?? "", item.embedding);
    }

    const model = this.model;
    const provider = "openai";
    const now = Date.now();
    const insert = this.db.database.query(
      `INSERT OR REPLACE INTO memory_embeddings (entry_id, provider, model, hash, embedding, dims, updated_at)
       VALUES ($entry_id, $provider, $model, $hash, $embedding, $dims, $updated_at)`,
    );

    for (const req of toEmbed) {
      const embedding = byText.get(req.text) ?? null;
      result.set(req.entryId, embedding);
      if (embedding === null) continue;
      const bytes = new Uint8Array(embedding.buffer);
      insert.run({
        $entry_id: req.entryId,
        $provider: provider,
        $model: model,
        $hash: req.hash,
        $embedding: bytes,
        $dims: embedding.length,
        $updated_at: now,
      });
    }

    if (!opts.skipMeta) {
      this.db.setMeta("embedding_model", model);
      this.db.setMeta("embedding_provider", provider);
    }

    return result;
  }

  /**
   * Compare the stored embedding model with the configured one. If they
   * differ (or a previous reindex was interrupted), recompute all embeddings.
   * Search continues to use the existing rows during the reindex.
   */
  async reindexIfNeeded(): Promise<void> {
    const storedModel = this.db.getMeta("embedding_model");
    const storedProvider = this.db.getMeta("embedding_provider");
    const reindexing = this.db.getMeta("reindexing") === "true";
    const needsReindex = reindexing || storedModel !== this.model || storedProvider !== "openai";
    if (!needsReindex) return;

    log.info("starting memory embedding reindex", { fromModel: storedModel, toModel: this.model });
    this.db.setMeta("reindexing", "true");

    const rows = this.db.database
      .query<{ id: string; text: string }, []>("SELECT id, text FROM memory_entries ORDER BY created_at")
      .all();

    const batchSize = 64;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      await this.embedEntries(
        chunk.map((r) => ({ entryId: r.id, text: r.text })),
        { skipMeta: true },
      );
    }

    this.db.setMeta("embedding_model", this.model);
    this.db.setMeta("embedding_provider", "openai");
    this.db.setMeta("reindexing", "false");
    log.info("memory embedding reindex complete", { count: rows.length });
  }

  private loadCache(hashes: string[], model?: string, provider?: string): Map<string, Float32Array> {
    const cache = new Map<string, Float32Array>();
    if (hashes.length === 0) return cache;
    const placeholders = hashes.map(() => "?").join(",");
    let sql = `SELECT hash, embedding, dims FROM memory_embeddings WHERE hash IN (${placeholders})`;
    const params: (string | number)[] = [...hashes];
    if (model !== undefined) {
      sql += " AND model = ?";
      params.push(model);
    }
    if (provider !== undefined) {
      sql += " AND provider = ?";
      params.push(provider);
    }
    const rows = this.db.database
      .query<{ hash: string; embedding: Uint8Array; dims: number }, (string | number)[]>(sql)
      .all(...params);
    for (const row of rows) {
      const bytes = new Uint8Array(row.embedding);
      cache.set(row.hash, new Float32Array(bytes.buffer, bytes.byteOffset, row.dims));
    }
    return cache;
  }

  private async fetchEmbeddings(texts: string[], model: string = this.model): Promise<Map<string, Float32Array>> {
    const result = new Map<string, Float32Array>();
    if (texts.length === 0) return result;

    const controller = new AbortController();
    const timeoutMs = 60_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenAI embeddings API returned ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as EmbeddingResponse;
      for (const item of data.data) {
        const text = texts[item.index];
        if (text === undefined) continue;
        const embedding = new Float32Array(item.embedding);
        result.set(hashText(text), embedding);
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private markDegraded(reason: string): void {
    this.state.degraded = true;
    this.state.degradedUntil = Date.now() + this.cooldownSeconds * 1000;
    this.state.errorCount++;
    this.state.lastError = reason;
    log.warn("embedding provider degraded", { reason, cooldownSeconds: this.cooldownSeconds });
  }
}
