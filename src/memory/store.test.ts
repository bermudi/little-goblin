import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { EmbeddingProvider } from "./embeddings.ts";
import { MemoryDatabase } from "./db.ts";
import { MetricsStore, readMetricsSummary } from "../metrics/store.ts";
import { log } from "../log.ts";
import { surfaceId, dmSurface, topicSurface } from "../surface.ts";
import type { TranscriptChunk } from "../sessions/transcript.ts";

const DELIMITER = "\n§\n";

// Pin the global budget for these tests so overflow behavior is deterministic.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "5000";

class ThrowingEmbeddingProvider extends EmbeddingProvider {
  constructor(db: MemoryDatabase, private readonly failure: Error) {
    super(db);
  }

  override async embedEntries(): Promise<Map<string, Float32Array | null>> {
    throw this.failure;
  }
}

describe("MemoryStore", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-"));
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    (store as unknown as { db: { close: () => void } }).db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("read", () => {
    it("returns empty parsed memory when file is absent", () => {
      expect(store.read("general")).toEqual({ body: "" });
      expect(store.read("user")).toEqual({ body: "" });
    });

    it("returns file contents when present", async () => {
      expect((await store.add("general", "hello")).ok).toBe(true);
      expect(store.readBody("general")).toBe("hello");
    });

    it("parses one-line description frontmatter separately from body", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      expect((await store.setDescription(scope, "health notes")).ok).toBe(true);
      expect((await store.add(scope, "alpha")).ok).toBe(true);
      expect(store.read(scope)).toEqual({ description: "health notes", body: "alpha" });
    });
  });

  describe("add", () => {
    it("first add to empty file produces no delimiter", async () => {
      expect((await store.add("general", "hello world")).ok).toBe(true);
      const body = store.readBody("general");
      expect(body).toBe("hello world");
      expect(body.includes(DELIMITER)).toBe(false);
    });

    it("second add produces exactly one delimiter", async () => {
      expect((await store.add("general", "first")).ok).toBe(true);
      expect((await store.add("general", "second")).ok).toBe(true);
      expect(store.readBody("general")).toBe(`first${DELIMITER}second`);
    });

    it("creates scope directories lazily", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      expect((await store.add(scope, "x")).ok).toBe(true);
      expect(store.readBody(scope)).toBe("x");
    });

    it("succeeds when total curated memory is within the global budget", async () => {
      expect((await store.add("user", "a".repeat(5000))).ok).toBe(true);
      expect(store.readBody("user").length).toBe(5000);
    });

    it("rejects when add would exceed the global budget; file unchanged", async () => {
      const initial = "a".repeat(4999);
      expect((await store.add("user", initial)).ok).toBe(true);
      const before = store.read("user");
      const r = await store.add("user", "bb");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("5001");
        expect(r.error).toContain("5000");
        expect(r.error).toContain("1");
      }
      expect(store.read("user")).toEqual(before);
    });

    it("enforces the global budget across scopes", async () => {
      const topic42 = { topic: { chatId: -100, topicId: 42 } };
      const topic7 = { topic: { chatId: -100, topicId: 7 } };
      expect((await store.add(topic42, "m".repeat(4000))).ok).toBe(true);
      expect((await store.add(topic42, "x")).ok).toBe(true);
      // total is now 4001; adding 2000 chars to another scope would exceed 5000
      expect((await store.add(topic7, "y".repeat(2000))).ok).toBe(false);
      expect((await store.add(topic7, "fresh")).ok).toBe(true);
      expect(store.readBody(topic7)).toBe("fresh");
    });
  });

  describe("post-commit embedding failures", () => {
    const failure = new Error("embedding implementation exploded");

    function useThrowingEmbeddings(): void {
      store = new MemoryStore(store.db, undefined, {
        embeddings: new ThrowingEmbeddingProvider(store.db, failure),
      });
    }

    function captureLogsAndTransactions() {
      return {
        warn: spyOn(log, "warn").mockImplementation(() => {}),
        error: spyOn(log, "error").mockImplementation(() => {}),
        exec: spyOn(store.db.database, "exec"),
      };
    }

    it("addEntry returns the durable id and only warns when embedding throws", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        const id = await store.addEntry({
          scope: "general",
          entryKind: "memory",
          text: "durable addEntry text",
        });

        expect(store.readEntries("general")).toEqual([
          expect.objectContaining({ entry_id: id, text: "durable addEntry text" }),
        ]);
        expect(spies.warn).toHaveBeenCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "addEntry", error: failure.message },
        );
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("updateEntry reports success for the durable update and only warns when embedding throws", async () => {
      const id = await store.addEntry({
        scope: "general",
        entryKind: "memory",
        text: "before update",
      });
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        const result = await store.updateEntry(id, { text: "durable updated text" });

        expect(result).toEqual({ ok: true });
        expect(store.readBody("general")).toBe("durable updated text");
        expect(spies.warn).toHaveBeenCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "updateEntry", error: failure.message },
        );
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("mutate reports success for the durable write and does not misreport a transaction failure", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        const result = await store.add("general", "durable manual write");

        expect(result).toEqual({ ok: true });
        expect(store.readBody("general")).toBe("durable manual write");
        expect(spies.warn).toHaveBeenCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "add", error: failure.message },
        );
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("addEntries returns all durable ids when batch embedding throws", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        const ids = await store.addEntries([
          { scope: "general", entryKind: "memory", text: "durable batch one" },
          { scope: "general", entryKind: "memory", text: "durable batch two" },
        ]);

        expect(ids).toHaveLength(2);
        expect(store.readEntries("general").map((entry) => entry.entry_id)).toEqual(ids);
        expect(spies.warn).toHaveBeenCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "addEntries", error: failure.message },
        );
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("importEntries returns durable imported rows when batch embedding throws", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        const ids = await store.importEntries([
          {
            scope: "agents/imported",
            entryKind: "memory",
            text: "durable imported memory",
            description: "imported description",
          },
        ]);

        expect(ids).toHaveLength(1);
        expect(store.read({ agent: { name: "imported" } })).toEqual({
          description: "imported description",
          body: "durable imported memory",
        });
        expect(spies.warn).toHaveBeenCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "importEntries", error: failure.message },
        );
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("syncTranscriptChunks remains successful and idempotent when embedding throws", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      const chunk: TranscriptChunk = {
        text: "durable transcript chunk",
        ts: new Date().toISOString(),
        role: "user",
        sessionId: "embedding-failure-session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      try {
        const firstIds = await store.syncTranscriptChunks(
          "/tmp/embedding-failure.jsonl",
          chunk.sessionId,
          [chunk],
          { hash: "same-hash", mtime: 10, size: 20 },
        );
        const retryIds = await store.syncTranscriptChunks(
          "/tmp/embedding-failure.jsonl",
          chunk.sessionId,
          [chunk],
          { hash: "same-hash", mtime: 10, size: 20 },
        );

        expect(firstIds).toHaveLength(1);
        expect(retryIds).toHaveLength(1);
        expect(store.db.database
          .query<{ text: string }, { $scope: string }>("SELECT text FROM memory_entries WHERE scope = $scope")
          .all({ $scope: `transcript/${chunk.sessionId}` }))
          .toEqual([{ text: chunk.text }]);
        expect(store.db.database
          .query<{ hash: string }, { $path: string }>("SELECT hash FROM memory_sources WHERE path = $path")
          .get({ $path: "/tmp/embedding-failure.jsonl" }))
          .toEqual({ hash: "same-hash" });
        expect(spies.warn).toHaveBeenCalledTimes(2);
        expect(spies.warn).toHaveBeenLastCalledWith(
          "memory embedding failed after commit; write remains durable",
          { operation: "syncTranscriptChunks", error: failure.message },
        );
        expect(spies.exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });

    it("still rolls back and surfaces a true transaction failure before embedding", async () => {
      useThrowingEmbeddings();
      const spies = captureLogsAndTransactions();
      try {
        await expect(store.addEntry({
          scope: "general",
          entryKind: "memory",
          text: "x".repeat(5001),
        })).rejects.toThrow("memory overflow");

        expect(store.readEntries("general")).toEqual([]);
        expect(spies.exec).toHaveBeenCalledWith("ROLLBACK");
        expect(spies.warn).not.toHaveBeenCalled();
        expect(spies.error).not.toHaveBeenCalled();
      } finally {
        spies.warn.mockRestore();
        spies.error.mockRestore();
        spies.exec.mockRestore();
      }
    });
  });

  describe("post-commit metric failures", () => {
    async function expectCommittedMutationWhenCounterFails(failingCounter: string): Promise<void> {
      const metrics = new MetricsStore(tmp, "abcdef1234");
      const metricFailure = new Error(`${failingCounter} exploded`);
      const effects: string[] = [];
      const increment = spyOn(metrics, "incrementCounter").mockImplementation((counter) => {
        effects.push(`metric:${counter}`);
        if (counter === failingCounter) throw metricFailure;
      });
      const embeddings = new EmbeddingProvider(store.db);
      const embedEntries = spyOn(embeddings, "embedEntries").mockImplementation(async () => {
        effects.push("embedding");
        return new Map();
      });
      store = new MemoryStore(store.db, metrics, { embeddings });
      const warn = spyOn(log, "warn").mockImplementation(() => {});
      const exec = spyOn(store.db.database, "exec");

      try {
        const result = await store.add("general", "durable manual write");

        expect(result).toEqual({ ok: true });
        expect(store.readBody("general")).toBe("durable manual write");
        expect(effects).toEqual([
          "metric:memory_write_total",
          "metric:memory_write_add_total",
          "embedding",
        ]);
        expect(embedEntries).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          "memory metric failed after commit; write remains durable",
          {
            operation: "add",
            scope: "general",
            counter: failingCounter,
            error: metricFailure.message,
          },
        );
        expect(exec).not.toHaveBeenCalledWith("ROLLBACK");
      } finally {
        increment.mockRestore();
        embedEntries.mockRestore();
        warn.mockRestore();
        exec.mockRestore();
      }
    }

    it("keeps the durable mutation and runs later side effects when the total counter fails", async () => {
      await expectCommittedMutationWhenCounterFails("memory_write_total");
    });

    it("keeps the durable mutation and runs embedding when the action counter fails", async () => {
      await expectCommittedMutationWhenCounterFails("memory_write_add_total");
    });
  });

  describe("replace", () => {
    beforeEach(async () => {
      await store.add("general", "alpha");
      await store.add("general", "bravo");
      await store.add("general", "charlie");
    });

    it("replaces a unique substring", async () => {
      expect((await store.replace("general", "bravo", "BRAVO!")).ok).toBe(true);
      expect(store.readBody("general")).toBe(`alpha${DELIMITER}BRAVO!${DELIMITER}charlie`);
    });

    it("rejects ambiguous match", async () => {
      await store.add("general", "alpha");
      const r = await store.replace("general", "alpha", "X");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("2");
    });

    it("rejects not-found", async () => {
      const before = store.readBody("general");
      const r = await store.replace("general", "zzz", "X");
      expect(r.ok).toBe(false);
      expect(store.readBody("general")).toBe(before);
    });
  });

  describe("remove", () => {
    beforeEach(async () => {
      await store.add("general", "alpha");
      await store.add("general", "bravo");
      await store.add("general", "charlie");
    });

    it("removes a middle entry along with one delimiter", async () => {
      expect((await store.remove("general", "bravo")).ok).toBe(true);
      expect(store.readBody("general")).toBe(`alpha${DELIMITER}charlie`);
    });

    it("removes the first entry cleanly", async () => {
      expect((await store.remove("general", "alpha")).ok).toBe(true);
      expect(store.readBody("general")).toBe(`bravo${DELIMITER}charlie`);
    });

    it("removes the last entry cleanly", async () => {
      expect((await store.remove("general", "charlie")).ok).toBe(true);
      expect(store.readBody("general")).toBe(`alpha${DELIMITER}bravo`);
    });

    it("removes the sole entry, leaving an empty file", async () => {
      const tmp2 = mkdtempSync(join(tmpdir(), "goblin-memory-"));
      try {
        const s2 = new MemoryStore(tmp2);
        await s2.add("user", "only");
        expect((await s2.remove("user", "only")).ok).toBe(true);
        expect(s2.readBody("user")).toBe("");
        (s2 as unknown as { db: { close: () => void } }).db.close();
      } finally {
        rmSync(tmp2, { recursive: true, force: true });
      }
    });

    it("handles entry containing the section delimiter character", async () => {
      // Regression test: entry content containing '§' should not confuse removal
      await store.add("general", `text with section ${DELIMITER.trim()} inside`);
      expect((await store.remove("general", "bravo")).ok).toBe(true);
      // The entry with the delimiter inside should remain intact
      const body = store.readBody("general");
      expect(body).toContain("text with section");
      expect(body).not.toContain("bravo");
    });

    it("handles entry containing partial delimiter", async () => {
      // Regression test: entry containing just '\n§' or '§\n' should not confuse removal
      await store.add("general", "line1\n§line2");
      expect((await store.remove("general", "bravo")).ok).toBe(true);
      const body = store.readBody("general");
      expect(body).toContain("line1\n§line2");
      expect(body).not.toContain("bravo");
    });
  });

  describe("frontmatter", () => {
    it("setDescription preserves body and empty description removes header", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect((await store.setDescription(scope, "health notes")).ok).toBe(true);
      expect(store.read(scope)).toEqual({ description: "health notes", body: "alpha" });
      expect((await store.setDescription(scope, "")).ok).toBe(true);
      expect(store.read(scope)).toEqual({ body: "alpha" });
    });

    it("round-trips description through add, replace, remove, and rewrite", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.setDescription(scope, "ops notes");
      await store.add(scope, "alpha");
      await store.add(scope, "bravo");
      await store.replace(scope, "bravo", "charlie");
      await store.remove(scope, "alpha");
      await store.rewrite(scope, "delta");
      expect(store.read(scope)).toEqual({ description: "ops notes", body: "delta" });
    });

    it("rejects multiline and overlong descriptions", async () => {
      expect((await store.setDescription("general", "bad\nwolf")).ok).toBe(false);
      expect((await store.setDescription("general", "x".repeat(201))).ok).toBe(false);
    });

    it("excludes frontmatter from body cap calculation", async () => {
      const scope = { agent: { name: "researcher" } };
      expect((await store.setDescription(scope, "x".repeat(200))).ok).toBe(true);
      expect((await store.rewrite(scope, "m".repeat(4000))).ok).toBe(true);
      expect(store.read(scope).body.length).toBe(4000);
    });
  });

  describe("archiveOrphan", () => {
    it("archives a topic scope and excludes it from the index", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect(await store.archiveOrphan(-100, 42)).toBe(true);
      expect(store.read(scope)).toEqual({ body: "" });
      const index = await store.listIndex({ chatId: -100, includeAgents: false });
      expect(index.topics).toEqual([]);
    });

    it("returns false when the source is missing", async () => {
      expect(await store.archiveOrphan(-100, 42)).toBe(false);
    });

    it("overwrites an existing archive destination", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "alpha");
      expect(await store.archiveOrphan(-100, 42)).toBe(true);
      // The SQLite store does not allow public repopulation of an archived
      // topic scope, so the source is empty and a second archive is a no-op.
      expect(await store.archiveOrphan(-100, 42)).toBe(false);
      expect(store.read(scope)).toEqual({ body: "" });
    });

    it("keeps a committed archive successful when best-effort metrics fail", async () => {
      const scope = { topic: { chatId: -100, topicId: 42 } };
      await store.add(scope, "durable archive");
      const metrics = new MetricsStore(tmp, "abcdef1234");
      const metricFailure = new Error("metrics implementation exploded");
      const increment = spyOn(metrics, "incrementCounter").mockImplementation(() => {
        throw metricFailure;
      });
      store = new MemoryStore(store.db, metrics);
      const warn = spyOn(log, "warn").mockImplementation(() => {});
      const exec = spyOn(store.db.database, "exec");
      try {
        expect(await store.archiveOrphan(-100, 42)).toBe(true);

        expect(store.read(scope)).toEqual({ body: "" });
        expect(store.db.database
          .query<{ text: string }, { $scope: string }>("SELECT text FROM memory_entries WHERE scope = $scope")
          .all({ $scope: "archive/topics/-100/42" }))
          .toEqual([{ text: "durable archive" }]);
        expect(exec).not.toHaveBeenCalledWith("ROLLBACK");
        expect(warn).toHaveBeenCalledWith("failed to record memory archive metric", {
          chatId: -100,
          topicId: 42,
          error: metricFailure.message,
        });
      } finally {
        increment.mockRestore();
        warn.mockRestore();
        exec.mockRestore();
      }
    });
  });

  describe("listIndex", () => {
    it("filters topics by chat id and optionally includes agents", async () => {
      await store.setDescription({ topic: { chatId: -100, topicId: 1 } }, "chat A one");
      await store.setDescription({ topic: { chatId: -100, topicId: 2 } }, "chat A two");
      await store.setDescription({ topic: { chatId: -200, topicId: 9 } }, "chat B nine");
      await store.setDescription({ agent: { name: "researcher" } }, "research persona");

      expect(await store.listIndex({ chatId: -100, includeAgents: false })).toEqual({
        general: null,
        topics: [
          { chatId: -100, topicId: 1, description: "chat A one" },
          { chatId: -100, topicId: 2, description: "chat A two" },
        ],
        agents: [],
      });
      expect(await store.listIndex({ includeAgents: true })).toEqual({
        general: null,
        topics: [
          { chatId: -200, topicId: 9, description: "chat B nine" },
          { chatId: -100, topicId: 1, description: "chat A one" },
          { chatId: -100, topicId: 2, description: "chat A two" },
        ],
        agents: [{ name: "researcher", description: "research persona" }],
      });
    });

    it("enriches topic names via getTopicName callback when description is missing", async () => {
      // Set up topics: one with description, one without
      await store.setDescription({ topic: { chatId: -100, topicId: 1 } }, "has description");
      await store.add({ topic: { chatId: -100, topicId: 2 } }, "no description");

      const getTopicName = async (chatId: number, topicId: number): Promise<string | null> => {
        if (chatId === -100 && topicId === 2) return "Fetched Topic Name";
        return null;
      };

      const index = await store.listIndex({ chatId: -100, includeAgents: false, getTopicName });

      expect(index.general).toBeNull();
      expect(index.topics).toEqual([
        { chatId: -100, topicId: 1, description: "has description" },
        { chatId: -100, topicId: 2, name: "Fetched Topic Name", description: undefined },
      ]);
    });

    it("returns general scope description when set", async () => {
      await store.setDescription("general", "general scope description");

      const index = await store.listIndex({ chatId: -100, includeAgents: false });

      expect(index.general).toEqual({ description: "general scope description" });
    });

    it("returns general as null when general scope is empty", async () => {
      // Ensure general is empty (no description, no body)
      const index = await store.listIndex({ chatId: -100, includeAgents: false });

      expect(index.general).toBeNull();
    });

    it("ignores getTopicName when description is already set", async () => {
      await store.setDescription({ topic: { chatId: -100, topicId: 1 } }, "existing description");

      const getTopicName = async (): Promise<string | null> => "Should Not Be Used";

      const index = await store.listIndex({ chatId: -100, includeAgents: false, getTopicName });

      expect(index.general).toBeNull();
      // Should not have name field since description exists
      expect(index.topics[0]).toEqual({
        chatId: -100,
        topicId: 1,
        description: "existing description",
      });
      expect(index.topics[0]?.name).toBeUndefined();
    });

    it("handles getTopicName returning null gracefully", async () => {
      await store.add({ topic: { chatId: -100, topicId: 1 } }, "no description");

      const getTopicName = async (): Promise<string | null> => null;

      const index = await store.listIndex({ chatId: -100, includeAgents: false, getTopicName });

      expect(index.general).toBeNull();
      expect(index.topics[0]).toEqual({
        chatId: -100,
        topicId: 1,
        description: undefined,
      });
      expect(index.topics[0]?.name).toBeUndefined();
    });

    it("handles getTopicName throwing gracefully", async () => {
      await store.add({ topic: { chatId: -100, topicId: 1 } }, "no description");

      const getTopicName = async (): Promise<string | null> => {
        throw new Error("API failure");
      };

      const index = await store.listIndex({ chatId: -100, includeAgents: false, getTopicName });

      expect(index.general).toBeNull();
      // Should still return topic without name
      expect(index.topics[0]).toEqual({
        chatId: -100,
        topicId: 1,
        description: undefined,
      });
    });
  });

  describe("TOCTOU protection", () => {
    it("rejects writes to archived topic scopes (was revived but topic archived)", async () => {
      // Simulate the TOCTOU scenario: subagent revived while topic still exists,
      // but topic gets archived before the subagent writes.
      const scope = { topic: { chatId: -100, topicId: 999 } };

      // 1. Create topic with content
      await store.add(scope, "original content");
      expect(store.readBody(scope)).toBe("original content");

      // 2. Archive the topic (simulating /archive command)
      expect(await store.archiveOrphan(-100, 999)).toBe(true);
      expect(store.read(scope)).toEqual({ body: "" });

      // 3. Try to write to the archived topic (simulating revived subagent writing)
      // This should fail because the topic was archived
      const result = await store.add(scope, "new content after archive");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("archived");
      }

      // 4. Verify the topic scope is still empty and not in the index
      expect(store.read(scope)).toEqual({ body: "" });
      const index = await store.listIndex({ chatId: -100, includeAgents: false });
      expect(index.topics).toEqual([]);
    });

    it("rejects all mutation operations on archived topic scopes", async () => {
      const scope = { topic: { chatId: -100, topicId: 888 } };

      // Setup: create and archive
      await store.add(scope, "alpha");
      await store.add(scope, "bravo");
      await store.setDescription(scope, "test topic");
      expect(await store.archiveOrphan(-100, 888)).toBe(true);

      // All mutation operations should fail
      expect((await store.add(scope, "gamma")).ok).toBe(false);
      expect((await store.replace(scope, "alpha", "ALPHA")).ok).toBe(false);
      expect((await store.remove(scope, "bravo")).ok).toBe(false);
      expect((await store.rewrite(scope, "new")).ok).toBe(false);
      expect((await store.setDescription(scope, "new desc")).ok).toBe(false);
    });

    it("allows writes to new topics (lazy directory creation)", async () => {
      const scope = { topic: { chatId: -100, topicId: 777 } };

      // Writing to a completely new topic should work
      expect((await store.add(scope, "fresh content")).ok).toBe(true);
      expect(store.readBody(scope)).toBe("fresh content");
    });
  });

  describe("concurrent safety", () => {
    it("serializes concurrent writes to the same scope (no data loss)", async () => {
      // Simulate multiple agents writing concurrently to the same scope.
      // Without proper locking, read-modify-write races cause data loss.
      const scope = { topic: { chatId: -100, topicId: 999 } };
      const entries = ["alpha", "bravo", "charlie", "delta", "echo"];

      // Create multiple store instances (simulating different agents/subagents)
      const stores = entries.map(() => new MemoryStore(tmp));

      // All write concurrently to the same scope
      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add(scope, entry))),
      );

      const body = store.readBody(scope);
      const parts = body.split(DELIMITER);

      // All entries should be present (no data lost to race conditions)
      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
      for (const s of stores) {
        (s as unknown as { db: { close: () => void } }).db.close();
      }
    });

    it("serializes concurrent writes to user scope", async () => {
      const entries = ["pref1", "pref2", "pref3", "pref4", "pref5"];
      const stores = entries.map(() => new MemoryStore(tmp));

      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add("user", entry))),
      );

      const body = store.readBody("user");
      const parts = body.split(DELIMITER);

      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
      for (const s of stores) {
        (s as unknown as { db: { close: () => void } }).db.close();
      }
    });

    it("serializes concurrent writes to named agent scope", async () => {
      const scope = { agent: { name: "researcher" } };
      const entries = ["fact1", "fact2", "fact3", "fact4", "fact5"];
      const stores = entries.map(() => new MemoryStore(tmp));

      await Promise.all(
        entries.map((entry, i) => Promise.resolve(stores[i]?.add(scope, entry))),
      );

      const body = store.readBody(scope);
      const parts = body.split(DELIMITER);

      expect(parts.length).toBe(entries.length);
      for (const entry of entries) {
        expect(parts).toContain(entry);
      }
      for (const s of stores) {
        (s as unknown as { db: { close: () => void } }).db.close();
      }
    });

    it("allows concurrent writes to different scopes (independent files)", async () => {
      const scopes = [
        { topic: { chatId: -100, topicId: 1 } },
        { topic: { chatId: -100, topicId: 2 } },
        { topic: { chatId: -200, topicId: 1 } },
        "user" as const,
        { agent: { name: "assistant" } },
      ];
      const stores = scopes.map(() => new MemoryStore(tmp));

      await Promise.all(
        scopes.map((scope, i) => Promise.resolve(stores[i]?.add(scope, `entry-${i}`))),
      );

      // Each scope should have exactly one entry
      for (let i = 0; i < scopes.length; i++) {
        expect(store.readBody(scopes[i] as typeof scopes[number])).toBe(`entry-${i}`);
      }
      for (const s of stores) {
        (s as unknown as { db: { close: () => void } }).db.close();
      }
    });
  });

  describe("metrics", () => {
    it("records write success and overflow counters", async () => {
      const metrics = new MetricsStore(tmp, "abcdef1234");
      const ms = new MemoryStore(tmp, metrics);
      const overflow = await ms.add("general", "x".repeat(5001));
      expect(overflow.ok).toBe(false);
      const success = await ms.add("general", "hello");
      expect(success.ok).toBe(true);
      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryWriteTotal).toBe(1);
      expect(summary.memoryWriteOverflowTotal).toBe(1);
      (ms as unknown as { db: { close: () => void } }).db.close();
    });

    it("preserves the overflow result when overflow telemetry fails", async () => {
      const metrics = new MetricsStore(tmp, "abcdef1234");
      const metricFailure = new Error("metrics disk full");
      const increment = spyOn(metrics, "incrementCounter").mockImplementation(() => {
        throw metricFailure;
      });
      const warn = spyOn(log, "warn").mockImplementation(() => {});
      const ms = new MemoryStore(tmp, metrics);

      try {
        const result = await ms.add("general", "x".repeat(5001));

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("memory overflow");
        expect(warn).toHaveBeenCalledWith(
          "memory overflow metric failed; overflow result preserved",
          {
            operation: "add",
            scope: "general",
            counter: "memory_write_overflow_total",
            error: metricFailure.message,
          },
        );
      } finally {
        increment.mockRestore();
        warn.mockRestore();
        (ms as unknown as { db: { close: () => void } }).db.close();
      }
    });

    it("records safety reject counter", () => {
      const metrics = new MetricsStore(tmp, "abcdef1234");
      const ms = new MemoryStore(tmp, metrics);
      ms.recordSafetyReject("general");
      ms.recordSafetyReject("general");
      const summary = readMetricsSummary(tmp, "abcdef1234")!;
      expect(summary.memoryWriteSafetyRejectTotal).toBe(2);
      (ms as unknown as { db: { close: () => void } }).db.close();
    });
  });

  describe("syncTranscriptChunks", () => {
    const makeChunk = (text: string, sourceSurfaceId?: ReturnType<typeof surfaceId>): TranscriptChunk => ({
      text,
      ts: new Date().toISOString(),
      role: "user",
      sessionId: "test-session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceSurfaceId,
    });

    it("derives per-chunk chat_id from sourceSurfaceId and stores source_surface_id", async () => {
      const sessionId = "mixed-chat-session";
      const surfaceA = surfaceId(topicSurface("private", -100, 1));
      const surfaceB = surfaceId(topicSurface("private", -200, 2));

      await store.syncTranscriptChunks(
        "/tmp/mixed.jsonl",
        sessionId,
        [
          makeChunk("Message from chat A", surfaceA),
          makeChunk("Message from chat B", surfaceB),
        ],
        { hash: "abc", mtime: Date.now(), size: 100 },
      );

      const rows = store.db.database
        .query<{ chat_id: string | null; source_surface_id: string | null; text: string }, { $scope: string }>(
          "SELECT chat_id, source_surface_id, text FROM memory_entries WHERE scope = $scope ORDER BY created_at, id",
        )
        .all({ $scope: `transcript/${sessionId}` })
        .sort((a, b) => (a.chat_id ?? "").localeCompare(b.chat_id ?? ""));

      expect(rows.length).toBe(2);
      expect(rows[0]!.chat_id).toBe("-100");
      expect(rows[0]!.source_surface_id).toBe(surfaceA);
      expect(rows[1]!.chat_id).toBe("-200");
      expect(rows[1]!.source_surface_id).toBe(surfaceB);
    });

    it("stores null chat_id and source_surface_id for missing provenance", async () => {
      const sessionId = "legacy-session";
      await store.syncTranscriptChunks(
        "/tmp/legacy.jsonl",
        sessionId,
        [makeChunk("Legacy message")],
        { hash: "def", mtime: Date.now(), size: 50 },
      );

      const rows = store.db.database
        .query<{ chat_id: string | null; source_surface_id: string | null }, { $scope: string }>(
          "SELECT chat_id, source_surface_id FROM memory_entries WHERE scope = $scope",
        )
        .all({ $scope: `transcript/${sessionId}` });

      expect(rows.length).toBe(1);
      expect(rows[0]!.chat_id).toBeNull();
      expect(rows[0]!.source_surface_id).toBeNull();
    });

    it("atomically replaces all chunks for a scope on reindex", async () => {
      const sessionId = "replace-session";
      const first = surfaceId(dmSurface(111));
      await store.syncTranscriptChunks(
        "/tmp/replace.jsonl",
        sessionId,
        [makeChunk("First version", first)],
        { hash: "v1", mtime: Date.now(), size: 10 },
      );

      const second = surfaceId(dmSurface(222));
      await store.syncTranscriptChunks(
        "/tmp/replace.jsonl",
        sessionId,
        [makeChunk("Second version", second)],
        { hash: "v2", mtime: Date.now() + 1, size: 10 },
      );

      const rows = store.db.database
        .query<{ chat_id: string | null; text: string }, { $scope: string }>(
          "SELECT chat_id, text FROM memory_entries WHERE scope = $scope",
        )
        .all({ $scope: `transcript/${sessionId}` });

      expect(rows.length).toBe(1);
      expect(rows[0]!.text).toContain("Second version");
      expect(rows[0]!.chat_id).toBe("222");
    });
  });

  describe("migrateTranscriptProvenanceIndex", () => {
    it("purges all transcript rows and dependents and records the version", () => {
      const sessionId = "purge-session";
      store.db.database
        .query(
          "INSERT INTO memory_entries (id, scope, entry_kind, text, created_at, updated_at, origin, chat_id, recall_count, display_order) VALUES ($id, $scope, $entry_kind, $text, $created_at, $updated_at, $origin, $chat_id, $recall_count, $display_order)",
        )
        .run({
          $id: "old-transcript-row",
          $scope: `transcript/${sessionId}`,
          $entry_kind: "transcript",
          $text: "old guessed chat row",
          $created_at: Date.now(),
          $updated_at: Date.now(),
          $origin: "transcript",
          $chat_id: "123",
          $recall_count: 0,
          $display_order: 0,
        });
      store.db.database
        .query("INSERT INTO memory_index_fts (text, entry_id, scope, entry_kind, chat_id) VALUES ($text, $entry_id, $scope, $entry_kind, $chat_id)")
        .run({
          $text: "old guessed chat row",
          $entry_id: "old-transcript-row",
          $scope: `transcript/${sessionId}`,
          $entry_kind: "transcript",
          $chat_id: "123",
        });
      store.db.database
        .query("INSERT INTO memory_sources (path, source, hash, mtime, size, updated_at) VALUES ($path, $source, $hash, $mtime, $size, $updated_at)")
        .run({
          $path: "/tmp/purge.jsonl",
          $source: "transcript",
          $hash: "abc",
          $mtime: Date.now(),
          $size: 100,
          $updated_at: Date.now(),
        });
      store.db.database
        .query("INSERT INTO memory_scopes (scope, description, updated_at) VALUES ($scope, $description, $updated_at)")
        .run({ $scope: `transcript/${sessionId}`, $description: "old scope", $updated_at: Date.now() });

      // Add a curated entry that must survive the purge.
      store.db.database
        .query(
          "INSERT INTO memory_entries (id, scope, entry_kind, text, created_at, updated_at, origin, recall_count, display_order) VALUES ($id, $scope, $entry_kind, $text, $created_at, $updated_at, $origin, $recall_count, $display_order)",
        )
        .run({
          $id: "curated-row",
          $scope: "general",
          $entry_kind: "memory",
          $text: "preserved memory",
          $created_at: Date.now(),
          $updated_at: Date.now(),
          $origin: "user",
          $recall_count: 0,
          $display_order: 0,
        });

      expect(store.migrateTranscriptProvenanceIndex()).toBe(true);

      const transcriptRows = store.db.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_entries WHERE entry_kind = 'transcript'")
        .get();
      expect(transcriptRows?.count).toBe(0);

      const ftsRows = store.db.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_index_fts")
        .get();
      expect(ftsRows?.count).toBe(0);

      const sources = store.db.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_sources WHERE source = 'transcript'")
        .get();
      expect(sources?.count).toBe(0);

      const curatedRows = store.db.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_entries WHERE entry_kind = 'memory'")
        .get();
      expect(curatedRows?.count).toBe(1);

      expect(store.db.getMeta("provenance_index_version")).toBe("1");

      // Idempotent: a second call does nothing.
      expect(store.migrateTranscriptProvenanceIndex()).toBe(false);
    });
  });
});
