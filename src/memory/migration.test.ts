import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { migrateFromMarkdown } from "./migration.ts";

// Keep the global budget high so migration never hits a cap.
process.env.GOBLIN_MEMORY_BUDGET_CHARS = "1000000";

function writeMarkdown(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf-8");
}

function memoryRootFor(home: string): string {
  return join(home, "state", "memory");
}

describe("migrateFromMarkdown", () => {
  it("returns true and imports general, user, topic, and agent markdown files", async () => {
    const home = mkdtempSync(join(tmpdir(), "goblin-migration-"));
    const store = new MemoryStore(home);
    const root = memoryRootFor(home);
    try {
      mkdirSync(join(root, "general"), { recursive: true });
      writeMarkdown(join(root, "general", "memory.md"), "general one\n§\ngeneral two");

      mkdirSync(join(root, "topics", "-100", "42"), { recursive: true });
      writeMarkdown(join(root, "topics", "-100", "42", "memory.md"), "topic alpha\n§\ntopic beta");

      mkdirSync(join(root, "agents", "scribe"), { recursive: true });
      writeMarkdown(join(root, "agents", "scribe", "memory.md"), "agent note");

      writeMarkdown(join(root, "user.md"), "user one\n§\nuser two");

      const migrated = await migrateFromMarkdown(home, store);
      expect(migrated).toBe(true);

      expect(store.readBody("general")).toBe("general one\n§\ngeneral two");
      expect(store.readBody("user")).toBe("user one\n§\nuser two");
      expect(store.readBody({ topic: { chatId: -100, topicId: 42 } })).toBe(
        "topic alpha\n§\ntopic beta",
      );
      expect(store.readBody({ agent: { name: "scribe" } })).toBe("agent note");
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("imports frontmatter description", async () => {
    const home = mkdtempSync(join(tmpdir(), "goblin-migration-desc-"));
    const store = new MemoryStore(home);
    const root = memoryRootFor(home);
    try {
      mkdirSync(join(root, "general"), { recursive: true });
      writeMarkdown(
        join(root, "general", "memory.md"),
        "---\ndescription: general notes\n---\nentry one",
      );

      mkdirSync(join(root, "agents", "critic"), { recursive: true });
      writeMarkdown(
        join(root, "agents", "critic", "memory.md"),
        "---\ndescription: critical agent\n---\nentry two",
      );

      expect(await migrateFromMarkdown(home, store)).toBe(true);

      expect(store.read("general")).toEqual({ description: "general notes", body: "entry one" });
      expect(store.read({ agent: { name: "critic" } })).toEqual({
        description: "critical agent",
        body: "entry two",
      });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("parses escaped quotes and backslashes in descriptions", async () => {
    const home = mkdtempSync(join(tmpdir(), "goblin-migration-esc-"));
    const store = new MemoryStore(home);
    const root = memoryRootFor(home);
    try {
      mkdirSync(join(root, "general"), { recursive: true });
      // File content is a JSON string literal: "He said \"hello\" \\back"
      writeMarkdown(
        join(root, "general", "memory.md"),
        `---\ndescription: "He said \\"hello\\" \\\\back"\n---\nlegacy note`,
      );

      expect(await migrateFromMarkdown(home, store)).toBe(true);

      const expected = 'He said "hello" \\back';
      expect(store.read("general")).toEqual({ description: expected, body: "legacy note" });
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second migration returns false", async () => {
    const home = mkdtempSync(join(tmpdir(), "goblin-migration-idem-"));
    const store = new MemoryStore(home);
    const root = memoryRootFor(home);
    try {
      mkdirSync(join(root, "general"), { recursive: true });
      writeMarkdown(join(root, "general", "memory.md"), "only entry");

      expect(await migrateFromMarkdown(home, store)).toBe(true);
      expect(store.getEntryCount()).toBe(1);
      expect(store.db.getMeta("migrated_at")).toBeDefined();

      expect(await migrateFromMarkdown(home, store)).toBe(false);
      expect(store.getEntryCount()).toBe(1);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("imports archived topics into the archive scope and excludes them from the index", async () => {
    const home = mkdtempSync(join(tmpdir(), "goblin-migration-archive-"));
    const store = new MemoryStore(home);
    const root = memoryRootFor(home);
    try {
      mkdirSync(join(root, "archive", "topics", "-100", "5"), { recursive: true });
      writeMarkdown(
        join(root, "archive", "topics", "-100", "5", "memory.md"),
        "---\ndescription: archived topic\n---\narchived entry",
      );

      mkdirSync(join(root, "topics", "-100", "42"), { recursive: true });
      writeMarkdown(join(root, "topics", "-100", "42", "memory.md"), "active entry");

      expect(await migrateFromMarkdown(home, store)).toBe(true);

      const archiveRows = store.db.database
        .query<{ text: string }, { $scope: string }>(
          "SELECT text FROM memory_entries WHERE scope = $scope ORDER BY created_at",
        )
        .all({ $scope: "archive/topics/-100/5" });
      expect(archiveRows.map((r) => r.text)).toEqual(["archived entry"]);

      const archiveDescription = store.db.database
        .query<{ description: string }, { $scope: string }>(
          "SELECT description FROM memory_scopes WHERE scope = $scope",
        )
        .get({ $scope: "archive/topics/-100/5" });
      expect(archiveDescription?.description).toBe("archived topic");

      const index = await store.listIndex({ chatId: -100, includeAgents: false });
      expect(index.topics).toEqual([{ chatId: -100, topicId: 42, description: undefined }]);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
