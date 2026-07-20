import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { MetricsStore, readMetricsSummary } from "../metrics/store.ts";

const DELIMITER = "\n§\n";

// Pin the global budget for these tests so overflow behavior is deterministic.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "5000";

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
});
