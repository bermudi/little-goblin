import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { formatSnapshot } from "./snapshot.ts";
import { memoryDir } from "./paths.ts";

describe("formatSnapshot", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-snap-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when all snapshot sources are empty or absent", async () => {
    await expect(
      formatSnapshot({
        store,
        activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
        includeAgents: true,
      }),
    ).resolves.toBeNull();
  });

  it("renders a topic-bound snapshot with peer topics in the index", async () => {
    await store.add({ topic: { chatId: -100123, topicId: 42 } }, "health fact");
    await store.add({ topic: { chatId: -100123, topicId: 7 } }, "it fact");
    await store.setDescription({ topic: { chatId: -100123, topicId: 7 } }, "homelab + dotfiles");
    await store.add({ topic: { chatId: -100123, topicId: 11 } }, "finance fact");
    await store.setDescription({ topic: { chatId: -100123, topicId: 11 } }, "money goblins");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      includeAgents: true,
    });

    expect(snap).not.toBeNull();
    expect(snap!.customType).toBe("goblin.memory.snapshot");
    expect(typeof snap!.content).toBe("string");
    const text = snap!.content;
    expect(text.startsWith("[goblin memory snapshot]")).toBe(true);
    expect(text).toContain("## scope\nTopic: -100123/42");
    expect(text).toContain("## user.md\n(empty)");
    expect(text).toContain("## memory.md\nhealth fact");
    expect(text).toContain("## other scopes\n- general — (no description)\n- topics/-100123/7 — homelab + dotfiles\n- topics/-100123/11 — money goblins");
    expect(text).not.toContain("topics/-100123/42");
    expect(text.indexOf("## scope")).toBeLessThan(text.indexOf("## user.md"));
    expect(text.indexOf("## user.md")).toBeLessThan(text.indexOf("## memory.md"));
  });

  it("renders a DM/general snapshot and lists only current-chat topics", async () => {
    await store.add("general", "general fact");
    await store.add({ topic: { chatId: 123, topicId: 7 } }, "current chat fact");
    await store.setDescription({ topic: { chatId: 123, topicId: 7 } }, "current chat topic");
    await store.add({ topic: { chatId: 456, topicId: 9 } }, "other chat fact");
    await store.setDescription({ topic: { chatId: 456, topicId: 9 } }, "other chat topic");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
      includeAgents: true,
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## scope\nGeneral (DM/supergroup-no-topic)");
    expect(text).toContain("## memory.md\ngeneral fact");
    expect(text).toContain("- topics/123/7 — current chat topic");
    expect(text).not.toContain("topics/456/9");
  });

  it("renders a named-subagent snapshot with persona memory", async () => {
    await store.add("user", "pref-1");
    await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active topic fact");
    await store.add({ agent: { name: "researcher" } }, "persona fact");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: { name: "researcher" } },
      includePersona: { name: "researcher" },
      includeAgents: false, // Named subagents don't see other agents
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## scope\nTopic: -100123/42\nAgent: researcher");
    expect(text).toContain("## user.md\npref-1");
    expect(text).toContain("## memory.md\nactive topic fact");
    expect(text).toContain("## agent persona\npersona fact");
  });

  it("falls back to topic names for undescribed peer topics", async () => {
    await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active topic fact");
    await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer topic fact");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      includeAgents: true,
      getTopicName: async (_chatId, topicId) => (topicId === 7 ? "IT" : null),
    });

    expect(snap!.content).toContain("- topics/-100123/7 — IT");
  });

  it("renders partial-empty placeholders", async () => {
    await store.add("user", "pref-1");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      includeAgents: true,
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## memory.md\n(empty)");
    expect(text).toContain("## user.md\npref-1");
    // General always appears in other scopes when not in general
    expect(text).toContain("## other scopes\n- general — (no description)");
  });

  it("payload shape matches sendCustomMessage Pick", async () => {
    await store.add("general", "x");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
      includeAgents: true,
    });

    expect(snap!.display).toBe(false);
    expect(snap!.details).toBeUndefined();
  });

  it("includes general with its description in other scopes when active scope is a topic", async () => {
    await store.setDescription("general", "general notes");
    await store.add("general", "general content");
    await store.add({ topic: { chatId: -100123, topicId: 42 } }, "topic fact");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      includeAgents: true,
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## other scopes");
    expect(text).toContain("- general — general notes");
  });
});
