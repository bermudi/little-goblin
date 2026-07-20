import { mkdirSync } from "node:fs";
import { log } from "../log.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { MemoryDatabase } from "./db.ts";
import { EmbeddingProvider } from "./embeddings.ts";
import { MemoryBudget, MemoryOverflowError } from "./budget.ts";
import { deriveConceptTags } from "./concept-vocabulary.ts";
import { memoryDbPath, memoryDir } from "./paths.ts";
import { scopeTag, type MemoryScope } from "./scope.ts";

const DESCRIPTION_CAP = 200;
const DELIMITER = "\n§\n";

export type StoreResult = { ok: true } | { ok: false; error: string };

export interface ParsedMemory {
  description?: string;
  body: string;
}

export interface ScopeEntry {
  entry_id: string;
  scope: string;
  entry_kind: "memory" | "user";
  text: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  origin: string;
  tags: string[];
}

export interface ScopeIndexEntry {
  scope: string;
  description: string | null;
  entry_count: number;
  total_chars: number;
}

export interface ScopeIndex {
  general: ScopeIndexEntry[];
  topics: ScopeIndexEntry[];
  agents: ScopeIndexEntry[];
}

export interface MemoryIndex {
  general: { description?: string } | null;
  topics: Array<{ chatId: number; topicId: number; name?: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
}

type StoreScope = MemoryScope | "user" | "memory";

interface EntryRow {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  origin: string;
  recallCount: number;
  promotedAt: number | null;
}

function normalizeScope(scope: StoreScope): MemoryScope | "user" {
  return scope === "memory" ? "general" : scope;
}

function scopeToTag(scope: MemoryScope | "user"): string {
  if (scope === "user" || scope === "general") return scope;
  if ("topic" in scope) {
    return `topics/${scope.topic.chatId}/${scope.topic.topicId}`;
  }
  return `agents/${scope.agent.name}`;
}

function entryKind(scope: MemoryScope | "user"): "memory" | "user" {
  return scope === "user" ? "user" : "memory";
}

function chatIdForScope(scope: MemoryScope | "user"): string | null {
  if (scope === "user" || scope === "general") return null;
  if ("topic" in scope) return String(scope.topic.chatId);
  return null;
}

export interface MemoryEntryInput {
  id?: string;
  scope: string;
  entryKind: "memory" | "user" | "transcript";
  text: string;
  origin?: string;
  category?: string;
  confidence?: number;
  sourceSession?: string;
  updatedSourceSession?: string;
  sourceRole?: string;
  promotedAt?: number;
  chatId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  displayOrder?: number;
  recallCount?: number;
}

/**
 * SQLite-backed memory store. Replaces the legacy markdown-file store.
 *
 * - All curated entries live in `memory_entries`.
 * - `memory_index_fts` is a contentful FTS5 table maintained manually.
 * - `memory_embeddings` stores OpenAI embeddings per entry.
 * - `memory_entry_tags` stores concept-vocabulary tags per entry.
 * - `memory_scopes` stores per-scope descriptions.
 *
 * Manual writes (`add`/`replace`/`remove`/`rewrite`) are origin "user" and
 * are never eligible for budget compaction. Transcript and dreaming entries
 * use `addEntry` with their own origin.
 */
export class MemoryStore {
  private _db: MemoryDatabase;
  private metrics: MetricsStore | null;
  private embeddings: EmbeddingProvider | null;
  private budget: MemoryBudget;

  constructor(
    homeOrDb: string | MemoryDatabase,
    metrics?: MetricsStore,
    deps?: { embeddings?: EmbeddingProvider; budget?: MemoryBudget },
  ) {
    this.metrics = metrics ?? null;
    this.embeddings = deps?.embeddings ?? null;
    this.budget = deps?.budget ?? new MemoryBudget();
    if (homeOrDb instanceof MemoryDatabase) {
      this._db = homeOrDb;
    } else {
      mkdirSync(memoryDir(homeOrDb), { recursive: true });
      this._db = new MemoryDatabase(memoryDbPath(homeOrDb));
    }
  }

  get db(): MemoryDatabase {
    return this._db;
  }

  get embeddingProvider(): EmbeddingProvider | null {
    return this.embeddings;
  }

  read(scope: StoreScope): ParsedMemory {
    const normalized = normalizeScope(scope);
    const tag = scopeToTag(normalized);
    const description = this.readDescription(tag);
    const rows = this.db.database
      .query<{ text: string }, { $scope: string; $entry_kind: string }>(
        "SELECT text FROM memory_entries WHERE scope = $scope AND entry_kind = $entry_kind ORDER BY display_order, created_at, id",
      )
      .all({ $scope: tag, $entry_kind: entryKind(normalized) });
    return { description: description ?? undefined, body: rows.map((r) => r.text).join(DELIMITER) };
  }

  readBody(scope: StoreScope): string {
    return this.read(scope).body;
  }

  readEntries(scope: StoreScope): ScopeEntry[] {
    const normalized = normalizeScope(scope);
    const tag = scopeToTag(normalized);
    const kind = entryKind(normalized);
    const description = this.readDescription(tag);

    const rows = this.db.database
      .query<
        { id: string; scope: string; entry_kind: string; text: string; created_at: number; updated_at: number; origin: string },
        { $scope: string; $entry_kind: string }
      >(
        "SELECT id, scope, entry_kind, text, created_at, updated_at, origin FROM memory_entries WHERE scope = $scope AND entry_kind = $entry_kind ORDER BY created_at, id",
      )
      .all({ $scope: tag, $entry_kind: kind });

    if (rows.length === 0) return [];

    const entryIds = rows.map((r) => r.id);
    const placeholders = entryIds.map(() => "?").join(",");
    const tagRows = this.db.database
      .query<{ entry_id: string; tag: string }, string[]>(
        `SELECT entry_id, tag FROM memory_entry_tags WHERE entry_id IN (${placeholders})`,
      )
      .all(...entryIds);

    const tagsById = new Map<string, string[]>();
    for (const { entry_id, tag: t } of tagRows) {
      const list = tagsById.get(entry_id) ?? [];
      list.push(t);
      tagsById.set(entry_id, list);
    }

    return rows.map((r) => ({
      entry_id: r.id,
      scope: r.scope,
      entry_kind: r.entry_kind as "memory" | "user",
      text: r.text,
      description,
      created_at: r.created_at,
      updated_at: r.updated_at,
      origin: r.origin,
      tags: tagsById.get(r.id) ?? [],
    }));
  }

  async add(scope: StoreScope, content: string): Promise<StoreResult> {
    return this.mutate(scope, "add", content, (current) => ({
      description: current.description,
      body: current.body.length === 0 ? content : current.body + DELIMITER + content,
    }));
  }

  async replace(scope: StoreScope, oldText: string, content: string): Promise<StoreResult> {
    return this.mutate(scope, "replace", content, (current) => {
      const match = findUnique(current.body, oldText);
      if (!match.ok) return match;
      return {
        description: current.description,
        body: current.body.slice(0, match.index) + content + current.body.slice(match.index + oldText.length),
      };
    });
  }

  async remove(scope: StoreScope, oldText: string): Promise<StoreResult> {
    return this.mutate(scope, "remove", oldText, (current) => {
      const match = findUnique(current.body, oldText);
      if (!match.ok) return match;
      return {
        description: current.description,
        body: removeEnclosingEntry(current.body, match.index, oldText.length),
      };
    });
  }

  async rewrite(scope: StoreScope, body: string): Promise<StoreResult> {
    return this.mutate(scope, "rewrite", body, (current) => ({ description: current.description, body }));
  }

  async consolidate(scope: StoreScope, fn: (currentBody: string) => string): Promise<StoreResult> {
    return this.mutate(scope, "rewrite", "", (current) => ({
      description: current.description,
      body: fn(current.body),
    }));
  }

  /**
   * Insert a single entry with full metadata control. Used by transcript
   * indexing, dreaming, and migration.
   */
  async addEntry(input: MemoryEntryInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    this.db.database.exec("BEGIN");
    try {
      const currentChars = this.budget.currentChars(this.db);
      this.budget.enforce(this.db, currentChars + input.text.length);
      this.addEntryInTransaction({ ...input, id, createdAt, updatedAt });
      this.db.database.exec("COMMIT");
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      throw err;
    }
    await this.embeddings?.embedEntry(id, input.text);
    return id;
  }

  /**
   * Insert multiple entries in a single transaction. Useful for transcript sync
   * and bulk migration. Embeddings are fetched after the transaction commits.
   */
  async updateEntry(
    id: string,
    input: {
      text: string;
      origin?: string;
      category?: string;
      confidence?: number;
      sourceSession?: string;
      updatedSourceSession?: string;
      sourceRole?: string;
      promotedAt?: number;
      recallCount?: number;
      updatedAt?: number;
    },
  ): Promise<StoreResult> {
    this.db.database.exec("BEGIN");
    try {
      const existing = this.db.database
        .query<
          {
            scope: string;
            entry_kind: string;
            text: string;
            chat_id: string | null;
            category: string | null;
            confidence: number | null;
            source_session: string | null;
            updated_source_session: string | null;
            source_role: string | null;
            origin: string;
            promoted_at: number | null;
            recall_count: number;
          },
          { $id: string }
        >(
          `SELECT scope, entry_kind, text, chat_id, category, confidence,
                  source_session, updated_source_session, source_role, origin,
                  promoted_at, recall_count
           FROM memory_entries WHERE id = $id`,
        )
        .get({ $id: id });
      if (existing === null) {
        this.db.database.exec("ROLLBACK");
        return { ok: false, error: `entry not found: ${id}` };
      }

      const now = Date.now();
      const textDelta = input.text.length - existing.text.length;
      if (existing.entry_kind !== "transcript" && textDelta > 0) {
        const current = this.budget.currentChars(this.db);
        this.budget.enforce(this.db, current + textDelta, [id]);
      }

      // Remove the stale vector and index data before updating the row. The
      // embedding will be recomputed after the transaction commits.
      this.db.database.query("DELETE FROM memory_embeddings WHERE entry_id = $id").run({ $id: id });
      this.db.database.query("DELETE FROM memory_index_fts WHERE entry_id = $id").run({ $id: id });
      this.db.database.query("DELETE FROM memory_entry_tags WHERE entry_id = $id").run({ $id: id });

      this.db.database
        .query(
          `UPDATE memory_entries
           SET text=$text, updated_at=$updated_at, origin=$origin,
               category=$category, confidence=$confidence,
               source_session=$source_session, updated_source_session=$updated_source_session,
               source_role=$source_role, promoted_at=$promoted_at,
               recall_count=$recall_count
           WHERE id=$id`,
        )
        .run({
          $id: id,
          $text: input.text,
          $updated_at: input.updatedAt ?? now,
          $origin: input.origin ?? existing.origin,
          $category: input.category ?? existing.category,
          $confidence: input.confidence ?? existing.confidence,
          $source_session: input.sourceSession ?? existing.source_session,
          $updated_source_session: input.updatedSourceSession ?? existing.updated_source_session,
          $source_role: input.sourceRole ?? existing.source_role,
          $promoted_at: input.promotedAt ?? existing.promoted_at,
          $recall_count: input.recallCount ?? existing.recall_count,
        });

      this.insertIndexAndTags(id, existing.scope, existing.entry_kind, input.text, existing.chat_id);

      this.db.database.exec("COMMIT");
      await this.embeddings?.embedEntry(id, input.text);
      return { ok: true };
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      if (err instanceof MemoryOverflowError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  async addEntries(inputs: MemoryEntryInput[]): Promise<string[]> {
    const ids: string[] = [];
    if (inputs.length === 0) return ids;
    const now = Date.now();
    const curatedInputs = inputs.filter((i) => i.entryKind === "memory" || i.entryKind === "user");
    const curatedChars = curatedInputs.reduce((sum, i) => sum + i.text.length, 0);
    this.db.database.exec("BEGIN");
    try {
      // Only enforce the curated-memory budget when adding user/dreaming entries.
      // Transcript chunks are not subject to the global character budget.
      if (curatedChars > 0) {
        const currentChars = this.budget.currentChars(this.db);
        this.budget.enforce(this.db, currentChars + curatedChars);
      }
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        const createdAt = input.createdAt ?? now + i;
        const updatedAt = input.updatedAt ?? now;
        const id = crypto.randomUUID();
        this.addEntryInTransaction({ ...input, id, createdAt, updatedAt });
        ids.push(id);
      }
      this.db.database.exec("COMMIT");
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      throw err;
    }
    await this.embeddings?.embedEntries(
      inputs.map((input, i) => ({ entryId: ids[i]!, text: input.text })),
    );
    return ids;
  }

  /**
   * Atomically replace all transcript chunks for a session scope and record
   * the synced file metadata. Does not enforce the curated-memory budget.
   */
  async syncTranscriptChunks(
    filePath: string,
    sessionId: string,
    chatId: string | null,
    chunks: Array<{
      text: string;
      createdAt: number;
      updatedAt: number;
      sourceSession?: string;
      sourceRole?: string;
    }>,
    fileMeta: { hash: string; mtime: number; size: number },
  ): Promise<string[]> {
    const scope = `transcript/${sessionId}`;
    const ids: string[] = [];
    this.db.database.exec("BEGIN");
    try {
      const existingIds = this.db.database
        .query<{ id: string }, { $scope: string }>("SELECT id FROM memory_entries WHERE scope = $scope")
        .all({ $scope: scope })
        .map((r) => r.id);
      for (const id of existingIds) {
        this.deleteRow(id);
      }

      for (const chunk of chunks) {
        const id = crypto.randomUUID();
        this.addEntryInTransaction({
          id,
          scope,
          entryKind: "transcript",
          text: chunk.text,
          origin: "transcript",
          createdAt: chunk.createdAt,
          updatedAt: chunk.updatedAt,
          sourceSession: chunk.sourceSession,
          sourceRole: chunk.sourceRole,
          chatId,
        });
        ids.push(id);
      }

      this.db.database
        .query(
          "INSERT OR REPLACE INTO memory_sources (path, source, hash, mtime, size, updated_at) VALUES ($path, 'transcript', $hash, $mtime, $size, $updated_at)",
        )
        .run({
          $path: filePath,
          $hash: fileMeta.hash,
          $mtime: fileMeta.mtime,
          $size: fileMeta.size,
          $updated_at: Date.now(),
        });

      this.db.database.exec("COMMIT");
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      throw err;
    }

    await this.embeddings?.embedEntries(ids.map((id, i) => ({ entryId: id, text: chunks[i]!.text })));
    return ids;
  }

  /**
   * Bulk import entries without budget enforcement. Used by migration from
   * legacy markdown files. Descriptions are written to memory_scopes when
   * provided. Embeddings are fetched after the transaction commits.
   */
  async importEntries(inputs: Array<MemoryEntryInput & { description?: string }>): Promise<string[]> {
    const ids: string[] = [];
    if (inputs.length === 0) return ids;
    const now = Date.now();
    const toEmbed: { entryId: string; text: string }[] = [];
    this.db.database.exec("BEGIN");
    try {
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]!;
        const createdAt = input.createdAt ?? now + i;
        const updatedAt = input.updatedAt ?? now;
        const hasText = input.text.trim().length > 0;
        if (hasText) {
          const id = crypto.randomUUID();
          this.addEntryInTransaction({ ...input, id, createdAt, updatedAt });
          ids.push(id);
          toEmbed.push({ entryId: id, text: input.text });
        }
        if (input.description !== undefined && input.description.length > 0) {
          this.db.database
            .query("INSERT OR REPLACE INTO memory_scopes (scope, description, updated_at) VALUES ($scope, $description, $updated_at)")
            .run({ $scope: input.scope, $description: input.description, $updated_at: updatedAt });
        }
      }
      this.db.database.exec("COMMIT");
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      throw err;
    }
    await this.embeddings?.embedEntries(toEmbed);
    return ids;
  }

  async setDescription(scope: StoreScope, description: string): Promise<StoreResult> {
    const normalized = normalizeScope(scope);
    const tag = scopeToTag(normalized);
    if (tag.startsWith("archive/") || this.isArchived(tag)) {
      return { ok: false, error: "cannot mutate archived scope" };
    }
    const trimmed = description.trim();
    if (trimmed.includes("\n")) {
      return { ok: false, error: "description must be a single line" };
    }
    if (trimmed.length > DESCRIPTION_CAP) {
      return {
        ok: false,
        error: `description would be ${trimmed.length} chars (cap ${DESCRIPTION_CAP}, overflow ${trimmed.length - DESCRIPTION_CAP})`,
      };
    }
    this.db.database
      .query(
        "INSERT OR REPLACE INTO memory_scopes (scope, description, updated_at) VALUES ($scope, $description, $updated_at)",
      )
      .run({ $scope: tag, $description: trimmed.length === 0 ? null : trimmed, $updated_at: Date.now() });
    return { ok: true };
  }

  recordSafetyReject(scope: MemoryScope | "user"): void {
    this.metrics?.incrementCounter("memory_write_safety_reject_total", scopeTag(scope));
  }

  async listIndex(opts: {
    chatId?: number;
    includeAgents: boolean;
    getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  }): Promise<MemoryIndex> {
    const topics: MemoryIndex["topics"] = [];
    const agents: MemoryIndex["agents"] = [];

    const entryRows = this.db.database
      .query<{ scope: string }, Record<string, never>>("SELECT DISTINCT scope FROM memory_entries")
      .all({});

    const scopeRows = this.db.database
      .query<{ scope: string; description: string | null }, Record<string, never>>(
        "SELECT scope, description FROM memory_scopes WHERE description IS NOT NULL",
      )
      .all({});

    const scopeMap = new Map<string, string | null>();
    for (const row of scopeRows) scopeMap.set(row.scope, row.description);
    for (const row of entryRows) if (!scopeMap.has(row.scope)) scopeMap.set(row.scope, null);

    for (const [tag, description] of scopeMap.entries()) {
      if (tag.startsWith("archive/")) continue;
      if (tag.startsWith("topics/")) {
        const parts = tag.split("/");
        if (parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
          const chatId = Number.parseInt(parts[1], 10);
          const topicId = Number.parseInt(parts[2], 10);
          if (Number.isFinite(chatId) && Number.isFinite(topicId)) {
            if (opts.chatId !== undefined && chatId !== opts.chatId) continue;
            let name: string | undefined;
            if (description === null && opts.getTopicName) {
              try {
                name = (await opts.getTopicName(chatId, topicId)) ?? undefined;
              } catch {
                name = undefined;
              }
            }
            topics.push({ chatId, topicId, name, description: description ?? undefined });
          }
        }
      }
      if (opts.includeAgents && tag.startsWith("agents/")) {
        const name = tag.slice("agents/".length);
        agents.push({ name, description: description ?? undefined });
      }
    }

    topics.sort((a, b) => a.chatId - b.chatId || a.topicId - b.topicId);
    agents.sort((a, b) => a.name.localeCompare(b.name));

    const generalParsed = this.read("general");
    const general =
      generalParsed.description === undefined && generalParsed.body.length === 0
        ? null
        : { description: generalParsed.description };

    return { general, topics, agents };
  }

  /**
   * List all curated scopes with entry counts and total character usage.
   * Excludes archived scopes and, optionally, scopes from other chats.
   */
  async listScopeIndex(opts: {
    chatId?: number;
    includeAgents: boolean;
    getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  }): Promise<ScopeIndex> {
    const rows = this.db.database
      .query<{ scope: string; entry_count: number; total_chars: number }, Record<string, never>>(
        `SELECT scope, COUNT(*) AS entry_count, COALESCE(SUM(LENGTH(text)), 0) AS total_chars
         FROM memory_entries
         WHERE entry_kind IN ('memory', 'user')
         GROUP BY scope`,
      )
      .all({});

    const scopeRows = this.db.database
      .query<{ scope: string; description: string | null }, Record<string, never>>(
        "SELECT scope, description FROM memory_scopes WHERE description IS NOT NULL",
      )
      .all({});

    const counts = new Map<string, { entry_count: number; total_chars: number }>();
    for (const row of rows) counts.set(row.scope, { entry_count: row.entry_count, total_chars: row.total_chars });

    const descriptions = new Map<string, string | null>();
    for (const row of scopeRows) descriptions.set(row.scope, row.description);

    // Include scopes that have descriptions even if they currently have no entries.
    const scopes = new Set<string>([...counts.keys(), ...descriptions.keys()]);

    const index: ScopeIndex = { general: [], topics: [], agents: [] };

    for (const scope of scopes) {
      if (scope.startsWith("archive/")) continue;

      const count = counts.get(scope) ?? { entry_count: 0, total_chars: 0 };
      const entry: ScopeIndexEntry = {
        scope,
        description: descriptions.get(scope) ?? null,
        entry_count: count.entry_count,
        total_chars: count.total_chars,
      };

      if (scope.startsWith("topics/")) {
        const parts = scope.split("/");
        if (parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
          const chatId = Number.parseInt(parts[1], 10);
          const topicId = Number.parseInt(parts[2], 10);
          if (Number.isFinite(chatId) && Number.isFinite(topicId)) {
            if (opts.chatId !== undefined && chatId !== opts.chatId) continue;
            let name: string | undefined;
            if (entry.description === null && opts.getTopicName) {
              try {
                name = (await opts.getTopicName(chatId, topicId)) ?? undefined;
              } catch {
                name = undefined;
              }
            }
            if (name !== undefined && entry.description === null) {
              entry.description = name;
            }
            index.topics.push(entry);
          }
        }
      } else if (opts.includeAgents && scope.startsWith("agents/")) {
        index.agents.push(entry);
      } else if (scope === "user" || scope === "general") {
        index.general.push(entry);
      }
    }

    index.general.sort((a, b) => a.scope.localeCompare(b.scope));
    index.topics.sort((a, b) => a.scope.localeCompare(b.scope));
    index.agents.sort((a, b) => a.scope.localeCompare(b.scope));

    return index;
  }

  close(): void {
    this.db.close();
  }

  currentBudgetUsage(): { current: number; budget: number } {
    return this.budget.usage(this.db);
  }

  /**
   * Compact the curated memory store down to the global budget by evicting
   * low-recall dreaming entries. Returns the ids that were removed and the
   * characters freed.
   */
  compact(): { deletedIds: string[]; freed: number; stillOver: boolean } {
    const current = this.budget.currentChars(this.db);
    const needed = Math.max(0, current - this.budget.budgetChars);
    return this.budget.compact(this.db, needed);
  }

  getEntryCount(): number {
    const row = this.db.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_entries").get();
    return row?.count ?? 0;
  }

  /**
   * Return the most recent `updated_at` timestamp for each of the given scope
   * tags. Scopes with no entries are omitted.
   */
  getScopesLastUpdated(scopes: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (scopes.length === 0) return map;
    const placeholders = scopes.map(() => "?").join(",");
    const rows = this.db.database
      .query<{ scope: string; updated_at: number | null }, string[]>(
        `SELECT scope, MAX(updated_at) AS updated_at FROM memory_entries WHERE scope IN (${placeholders}) GROUP BY scope`,
      )
      .all(...scopes);
    for (const row of rows) {
      if (row.updated_at !== null) {
        map.set(row.scope, row.updated_at);
      }
    }
    return map;
  }

  async archiveOrphan(chatId: number, topicId: number): Promise<boolean> {
    const oldScope = `topics/${chatId}/${topicId}`;
    const newScope = `archive/topics/${chatId}/${topicId}`;

    const exists = this.db.database
      .query<{ count: number }, { $scope: string }>("SELECT COUNT(*) as count FROM memory_entries WHERE scope = $scope")
      .get({ $scope: oldScope });
    if (!exists || exists.count === 0) return false;

    this.db.database.exec("BEGIN");
    try {
      this.db.database.query("UPDATE memory_entries SET scope = $new WHERE scope = $old").run({ $new: newScope, $old: oldScope });
      this.db.database.query("UPDATE memory_index_fts SET scope = $new WHERE scope = $old").run({ $new: newScope, $old: oldScope });
      this.db.database.query("UPDATE memory_scopes SET scope = $new WHERE scope = $old").run({ $new: newScope, $old: oldScope });
      this.db.database.exec("COMMIT");
      this.metrics?.incrementCounter("memory_archive_orphan_total", `topics/${chatId}/${topicId}`);
      return true;
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      log.warn("archiveOrphan failed", { chatId, topicId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private readDescription(scope: string): string | null {
    const row = this.db.database
      .query<{ description: string | null }, { $scope: string }>("SELECT description FROM memory_scopes WHERE scope = $scope")
      .get({ $scope: scope });
    return row?.description ?? null;
  }

  private isArchived(tag: string): boolean {
    const archiveTag = `archive/${tag}`;
    const entry = this.db.database
      .query<{ count: number }, { $scope: string }>("SELECT COUNT(*) as count FROM memory_entries WHERE scope = $scope")
      .get({ $scope: archiveTag });
    const scope = this.db.database
      .query<{ count: number }, { $scope: string }>("SELECT COUNT(*) as count FROM memory_scopes WHERE scope = $scope")
      .get({ $scope: archiveTag });
    return (entry?.count ?? 0) > 0 || (scope?.count ?? 0) > 0;
  }

  private async mutate(
    inputScope: StoreScope,
    action: "add" | "replace" | "remove" | "rewrite",
    _content: string,
    op: (current: ParsedMemory) => ParsedMemory | StoreResult,
  ): Promise<StoreResult> {
    const normalized = normalizeScope(inputScope);
    const tag = scopeToTag(normalized);
    const kind = entryKind(normalized);
    const chatId = chatIdForScope(normalized);

    if (tag.startsWith("archive/") || this.isArchived(tag)) {
      return { ok: false, error: "cannot mutate archived scope" };
    }

    const oldRows = this.loadRows(tag, kind);
    const description = this.readDescription(tag);
    const current: ParsedMemory = {
      description: description ?? undefined,
      body: oldRows.map((r) => r.text).join(DELIMITER),
    };
    const next = op(current);
    if ("ok" in next) {
      return next as StoreResult;
    }

    const trimmed = next.body.replace(/\n*$/, "");
    const newTexts = trimmed.length === 0 ? [] : trimmed.split(DELIMITER);
    const newTextLengthSum = newTexts.reduce((sum, text) => sum + text.length, 0);
    const oldTextLengthSum = oldRows.reduce((sum, row) => sum + row.text.length, 0);
    const netDelta = newTextLengthSum - oldTextLengthSum;

    // Map new texts to existing rows when the text is identical. Unmatched old
    // rows are deleted; new/changed rows are inserted. This preserves origin,
    // recall_count, promoted_at, and embeddings for entries that survive.
    const oldByText = new Map<string, EntryRow[]>();
    for (const row of oldRows) {
      const list = oldByText.get(row.text) ?? [];
      list.push(row);
      oldByText.set(row.text, list);
    }

    const matchedOldIds = new Set<string>();
    const toKeep: { row: EntryRow; index: number }[] = [];
    const toInsert: { text: string; index: number }[] = [];

    for (const [i, text] of newTexts.entries()) {
      const candidates = oldByText.get(text);
      if (candidates && candidates.length > 0) {
        const reused = candidates.shift()!;
        matchedOldIds.add(reused.id);
        toKeep.push({ row: reused, index: i });
      } else {
        toInsert.push({ text, index: i });
      }
    }

    const toDelete = oldRows.filter((r) => !matchedOldIds.has(r.id));
    const now = Date.now();
    const baseTime = now;

    const toEmbed: { entryId: string; text: string }[] = [];

    this.db.database.exec("BEGIN");
    try {
      // Enforce the global budget before applying mutations. Compaction will
      // evict other dreaming entries to make room; the projected total is the
      // current size plus the net change in body text from this mutation. Rows
      // that survive this mutation (toKeep) and rows it is deleting (toDelete)
      // must not be compacted away: deleting them is already part of netDelta
      // and counting them as freed would double-count the room they create.
      const currentChars = this.budget.currentChars(this.db);
      const idsToPreserve = [
        ...toKeep.map(({ row }) => row.id),
        ...toDelete.map((row) => row.id),
      ];
      this.budget.enforce(this.db, currentChars + netDelta, idsToPreserve);

      for (const row of toDelete) {
        this.deleteRow(row.id);
      }

      for (const { row, index } of toKeep) {
        this.db.database
          .query("UPDATE memory_entries SET display_order = $display_order WHERE id = $id")
          .run({ $id: row.id, $display_order: baseTime + index });
      }

      for (const { text, index } of toInsert) {
        const id = crypto.randomUUID();
        const createdAt = baseTime + index;
        const updatedAt = now;
        this.addEntryInTransaction({
          id,
          scope: tag,
          entryKind: kind,
          text,
          createdAt,
          updatedAt,
          origin: "user",
          recallCount: 0,
          chatId,
        });
        toEmbed.push({ entryId: id, text });
      }

      if (next.description !== undefined) {
        this.db.database
          .query("INSERT OR REPLACE INTO memory_scopes (scope, description, updated_at) VALUES ($scope, $description, $updated_at)")
          .run({ $scope: tag, $description: next.description, $updated_at: Date.now() });
      }

      this.db.database.exec("COMMIT");
      this.metrics?.incrementCounter("memory_write_total", scopeTag(normalized));
      this.metrics?.incrementCounter(`memory_write_${action}_total`, scopeTag(normalized));

      // Embed new/changed entries after the transaction commits. Failures are
      // logged but do not fail the write — FTS still serves search.
      await this.embeddings?.embedEntries(toEmbed);

      return { ok: true };
    } catch (err) {
      this.db.database.exec("ROLLBACK");
      log.error("memory store transaction failed", { action, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof MemoryOverflowError) {
        this.metrics?.incrementCounter("memory_write_overflow_total", scopeTag(normalized));
        return { ok: false, error: err.message };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private loadRows(tag: string, kind: "memory" | "user"): EntryRow[] {
    return this.db.database
      .query<
        { id: string; text: string; created_at: number; updated_at: number; origin: string; recall_count: number; promoted_at: number | null },
        { $scope: string; $entry_kind: string }
      >(
        "SELECT id, text, created_at, updated_at, origin, recall_count, promoted_at FROM memory_entries WHERE scope = $scope AND entry_kind = $entry_kind ORDER BY display_order, created_at, id",
      )
      .all({ $scope: tag, $entry_kind: kind })
      .map((r) => ({
        id: r.id,
        text: r.text,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        origin: r.origin,
        recallCount: r.recall_count,
        promotedAt: r.promoted_at,
      }));
  }

  private deleteRow(entryId: string): void {
    this.db.database.query("DELETE FROM memory_entry_tags WHERE entry_id = $entry_id").run({ $entry_id: entryId });
    this.db.database.query("DELETE FROM memory_embeddings WHERE entry_id = $entry_id").run({ $entry_id: entryId });
    this.db.database.query("DELETE FROM memory_index_fts WHERE entry_id = $entry_id").run({ $entry_id: entryId });
    this.db.database.query("DELETE FROM memory_entries WHERE id = $entry_id").run({ $entry_id: entryId });
  }

  private insertIndexAndTags(entryId: string, scope: string, kind: string, text: string, chatId: string | null): void {
    this.db.database
      .query("INSERT INTO memory_index_fts (text, entry_id, scope, entry_kind, chat_id) VALUES ($text, $entry_id, $scope, $entry_kind, $chat_id)")
      .run({
        $text: text,
        $entry_id: entryId,
        $scope: scope,
        $entry_kind: kind,
        $chat_id: chatId,
      });
    const tags = deriveConceptTags({ path: scope, snippet: text, limit: 8 });
    for (const t of tags) {
      this.db.database.query("INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES ($entry_id, $tag)").run({
        $entry_id: entryId,
        $tag: t,
      });
    }
  }

  private addEntryInTransaction(input: MemoryEntryInput): string {
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const displayOrder = input.displayOrder ?? createdAt;
    this.db.database
      .query(
        `INSERT INTO memory_entries
         (id, scope, entry_kind, text, created_at, updated_at, display_order, source_session, updated_source_session, source_role, category, confidence, origin, promoted_at, chat_id, recall_count)
         VALUES ($id, $scope, $entry_kind, $text, $created_at, $updated_at, $display_order, $source_session, $updated_source_session, $source_role, $category, $confidence, $origin, $promoted_at, $chat_id, $recall_count)`,
      )
      .run({
        $id: id,
        $scope: input.scope,
        $entry_kind: input.entryKind,
        $text: input.text,
        $created_at: createdAt,
        $updated_at: updatedAt,
        $display_order: displayOrder,
        $source_session: input.sourceSession ?? null,
        $updated_source_session: input.updatedSourceSession ?? null,
        $source_role: input.sourceRole ?? null,
        $category: input.category ?? null,
        $confidence: input.confidence ?? null,
        $origin: input.origin ?? "user",
        $promoted_at: input.promotedAt ?? null,
        $chat_id: input.chatId ?? null,
        $recall_count: input.recallCount ?? 0,
      });
    this.insertIndexAndTags(id, input.scope, input.entryKind, input.text, input.chatId ?? null);
    return id;
  }
}

function findUnique(body: string, needle: string): { ok: true; index: number } | { ok: false; error: string } {
  if (needle.length === 0) return { ok: false, error: "old_text must not be empty" };
  const parts = body.split(needle);
  const count = parts.length - 1;
  if (count === 0) return { ok: false, error: "old_text not found in target" };
  if (count > 1) return { ok: false, error: `old_text matched ${count} locations; must be unique` };
  return { ok: true, index: parts[0]!.length };
}

function removeEnclosingEntry(current: string, index: number, len: number): string {
  const before = current.lastIndexOf(DELIMITER, index);
  const entryStart = before === -1 ? 0 : before + DELIMITER.length;
  const after = current.indexOf(DELIMITER, index + len);
  const entryEnd = after === -1 ? current.length : after;

  if (before !== -1) {
    return current.slice(0, before) + current.slice(entryEnd);
  }
  if (after !== -1) {
    return current.slice(0, entryStart) + current.slice(after + DELIMITER.length);
  }
  return "";
}
