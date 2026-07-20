import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { exportToMarkdown } from "./export.ts";

const DELIMITER = "\n§\n";

process.env.GOBLIN_MEMORY_BUDGET_CHARS = "5000";

describe("exportToMarkdown", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-export-"));
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exports entries ordered by display_order", async () => {
    await store.add("general", "first");
    await store.add("general", "second");
    const rewrite = await store.rewrite("general", "second" + DELIMITER + "first");
    expect(rewrite.ok).toBe(true);
    expect(store.readBody("general")).toBe("second" + DELIMITER + "first");

    exportToMarkdown(tmp, store);

    const exported = readFileSync(join(tmp, "state", "memory", "general", "memory.md"), "utf-8");
    expect(exported).toBe("second" + DELIMITER + "first");
  });

  it("exports scope descriptions as YAML frontmatter", async () => {
    const scope = { topic: { chatId: -100, topicId: 7 } };
    await store.setDescription(scope, "health notes");
    await store.add(scope, "alpha");

    exportToMarkdown(tmp, store);

    const exported = readFileSync(join(tmp, "state", "memory", "topics", "-100", "7", "memory.md"), "utf-8");
    expect(exported).toBe('---\ndescription: "health notes"\n---\n\nalpha');
  });

  it("escapes quotes and backslashes in descriptions", async () => {
    const scope = { topic: { chatId: -100, topicId: 7 } };
    await store.setDescription(scope, 'He said "hello" \\back');
    await store.add(scope, "entry");

    exportToMarkdown(tmp, store);

    const exported = readFileSync(join(tmp, "state", "memory", "topics", "-100", "7", "memory.md"), "utf-8");
    expect(exported.startsWith('---\ndescription: "He said \\"hello\\" \\\\back"\n---\n\n')).toBe(true);
    expect(exported.endsWith("entry")).toBe(true);
  });

  it("does not export transcript or archived scopes", async () => {
    await store.add("general", "curated");
    await store.addEntries([
      {
        scope: "transcript/session-1",
        entryKind: "transcript",
        text: "user message",
        origin: "transcript",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    exportToMarkdown(tmp, store);

    expect(existsSync(join(tmp, "state", "memory", "general", "memory.md"))).toBe(true);
    expect(existsSync(join(tmp, "state", "memory", "transcript", "session-1", "memory.md"))).toBe(false);
  });
});
