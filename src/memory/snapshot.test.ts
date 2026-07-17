import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.ts";
import { MetricsStore, readMetricsSummary } from "../metrics/mod.ts";
import { formatSnapshot, SNAPSHOT_GUARDRAIL } from "./snapshot.ts";
import { memoryDir, scopeMemoryPath } from "./paths.ts";
import { metricsPath } from "../sessions/paths.ts";
import type { ActiveScope, MemoryScope } from "./scope.ts";
import { formatReflectedEntry, type EntryMetadata } from "./entry.ts";

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
        caller: { kind: "main" },
      }),
    ).resolves.toBeNull();
  });

  it("includes the stale-prone guardrail after the header on every non-null snapshot", async () => {
    await store.add("general", "fact-A");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
      caller: { kind: "main" },
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text.startsWith("[goblin memory snapshot]")).toBe(true);
    // Guardrail appears immediately after the header, before any section.
    const headerEnd = "[goblin memory snapshot]".length;
    const guardrailStart = text.indexOf(SNAPSHOT_GUARDRAIL);
    expect(guardrailStart).toBe(headerEnd + 2); // "\n\n" separator
    expect(guardrailStart).toBeLessThan(text.indexOf("## scope"));
    expect(text).toContain("stale or incomplete");
    expect(text).toContain("override memory");
  });

  it("records a snapshot_built metric event when metrics is provided", async () => {
    await store.add("general", "fact-A");
    const metrics = new MetricsStore(tmp, "abcdef1234");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
      caller: { kind: "main" },
      metrics,
    });

    expect(snap).not.toBeNull();
    const summary = readMetricsSummary(tmp, "abcdef1234")!;
    expect(summary.searchCount).toBe(0);
    expect(summary.lastTurn).toBeNull();

    const raw = readFileSync(metricsPath(tmp, "abcdef1234"), "utf-8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line) as { type: string; name?: string; extra?: Record<string, unknown> });
    const built = events.find((e) => e.type === "event" && e.name === "snapshot_built");
    expect(built).toBeDefined();
    expect(built!.extra!.empty).toBe(false);
    expect(typeof built!.extra!.entryCount).toBe("number");
    expect(built!.extra!.entryCount).toBeGreaterThan(0);
    expect(typeof built!.extra!.charLength).toBe("number");
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
      caller: { kind: "main" },
    });

    expect(snap).not.toBeNull();
    expect(snap!.customType).toBe("goblin.memory.snapshot");
    expect(typeof snap!.content).toBe("string");
    const text = snap!.content;
    expect(text.startsWith("[goblin memory snapshot]")).toBe(true);
    expect(text).toContain("## scope\nTopic");
    expect(text).toContain("## user.md\n(empty)");
    expect(text).toContain("## memory.md\nhealth fact");
    expect(text).toContain("## other scopes\n- topics/-100123/7 — homelab + dotfiles\n- topics/-100123/11 — money goblins");
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
      caller: { kind: "main" },
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## scope\nGeneral");
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
      caller: { kind: "named-subagent", name: "researcher" },
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## scope\nTopic\nAgent: researcher");
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
      caller: { kind: "main" },
      getTopicName: async (_chatId, topicId) => (topicId === 7 ? "IT" : null),
    });

    expect(snap!.content).toContain("- topics/-100123/7 — IT");
  });

  it("falls back to (no description) when getTopicName returns empty string", async () => {
    await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active topic fact");
    await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer topic fact");

    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      caller: { kind: "main" },
      getTopicName: async () => "",
    });

    expect(snap!.content).toContain("- topics/-100123/7 — (no description)");
  });

  it("renders partial-empty placeholders", async () => {
    await store.add("user", "pref-1");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null },
      caller: { kind: "main" },
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## memory.md\n(empty)");
    expect(text).toContain("## user.md\npref-1");
    // General is omitted from other scopes when it has no content
    expect(text).not.toContain("## other scopes");
  });

  it("payload shape matches sendCustomMessage Pick", async () => {
    await store.add("general", "x");
    const snap = await formatSnapshot({
      store,
      activeScope: { chatId: 123, topicScope: "general", namedAgent: null },
      caller: { kind: "main" },
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
      caller: { kind: "main" },
    });

    expect(snap).not.toBeNull();
    const text = snap!.content;
    expect(text).toContain("## other scopes");
    expect(text).toContain("- general — general notes");
  });

  describe("relevant memory (prompt text)", () => {
    const topicScope: ActiveScope = { chatId: -100123, topicScope: { topicId: 42 }, namedAgent: null };

    it("omits ## relevant memory when no prompt text is supplied", async () => {
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer backups note");
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");

      const snap = await formatSnapshot({ store, activeScope: topicScope, caller: { kind: "main" } });

      expect(snap).not.toBeNull();
      expect(snap!.content).not.toContain("## relevant memory");
    });

    it("omits ## relevant memory when prompt text is whitespace-only", async () => {
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer backups note");
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "   ",
      });

      expect(snap).not.toBeNull();
      expect(snap!.content).not.toContain("## relevant memory");
    });

    it("includes ## relevant memory with scope id when the prompt matches another same-chat scope", async () => {
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer backups note");
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "tell me about backups",
      });

      expect(snap).not.toBeNull();
      const text = snap!.content;
      expect(text).toContain("## relevant memory");
      expect(text).toContain("- [topics/-100123/7] peer backups note");
      // Active scope body is still rendered separately.
      expect(text).toContain("## memory.md\nactive note");
    });

    it("places ## relevant memory between ## memory.md and ## other scopes", async () => {
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "peer backups note");
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");
      await store.setDescription({ topic: { chatId: -100123, topicId: 11 } }, "another scope");
      await store.add({ topic: { chatId: -100123, topicId: 11 } }, "other note");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "backups",
      });

      expect(snap).not.toBeNull();
      const text = snap!.content;
      const memIdx = text.indexOf("## memory.md");
      const relIdx = text.indexOf("## relevant memory");
      const otherIdx = text.indexOf("## other scopes");
      expect(relIdx).toBeGreaterThan(memIdx);
      expect(relIdx).toBeLessThan(otherIdx);
    });

    it("bounds relevant memory to 3 entries by default", async () => {
      // Seed 5 same-chat peer topics that all match the query.
      for (let i = 0; i < 5; i++) {
        await store.add({ topic: { chatId: -100123, topicId: 100 + i } }, `backups note ${i}`);
      }
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "backups",
      });

      expect(snap).not.toBeNull();
      const relSection = snap!.content.split("## relevant memory\n")[1]!.split("\n\n")[0]!;
      expect(relSection.split("\n").length).toBe(3);
    });

    it("clamps relevantLimit to a maximum of 5", async () => {
      for (let i = 0; i < 8; i++) {
        await store.add({ topic: { chatId: -100123, topicId: 200 + i } }, `backups note ${i}`);
      }
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "active note");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "backups",
        relevantLimit: 50,
      });

      expect(snap).not.toBeNull();
      const relSection = snap!.content.split("## relevant memory\n")[1]!.split("\n\n")[0]!;
      expect(relSection.split("\n").length).toBe(5);
    });

    it("deduplicates entries that verbatim-match the active ## memory.md body", async () => {
      // The active scope and a peer scope share the same entry text.
      await store.add({ topic: { chatId: -100123, topicId: 42 } }, "backups run nightly");
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "backups run nightly");
      await store.add({ topic: { chatId: -100123, topicId: 8 } }, "backups run weekly");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "backups",
      });

      expect(snap).not.toBeNull();
      const relSection = snap!.content.split("## relevant memory\n")[1]!.split("\n\n")[0]!;
      // The peer verbatim-duplicate is dropped; the distinct weekly entry stays.
      expect(relSection).toContain("topics/-100123/8");
      expect(relSection).not.toContain("topics/-100123/7");
    });

    it("deduplicates a reflected active-scope entry against its stripped peer form", async () => {
      // Active scope holds a reflected entry whose body text matches a peer
      // scope's plain entry. Without metadata stripping, the raw active entry
      // ("<!-- memory: ... -->\nbackups run nightly") would fail the verbatim
      // check against the stripped search text ("backups run nightly") and
      // reappear under `## relevant memory`.
      const activeScope: MemoryScope = { topic: { chatId: -100123, topicId: 42 } };
      const meta: EntryMetadata = {
        category: "decision",
        confidence: 0.9,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-02T00:00:00Z",
        source_session: "s_test",
        source_role: "user",
      };
      const activePath = scopeMemoryPath(tmp, activeScope);
      mkdirSync(dirname(activePath), { recursive: true });
      writeFileSync(activePath, formatReflectedEntry(meta, "backups run nightly"), "utf-8");
      // Peer scope holds the same body as a plain entry.
      await store.add({ topic: { chatId: -100123, topicId: 7 } }, "backups run nightly");
      await store.add({ topic: { chatId: -100123, topicId: 8 } }, "backups run weekly");

      const snap = await formatSnapshot({
        store,
        activeScope: topicScope,
        caller: { kind: "main" },
        promptText: "backups",
      });

      expect(snap).not.toBeNull();
      const relSection = snap!.content.split("## relevant memory\n")[1]!.split("\n\n")[0]!;
      // The reflected active entry is deduplicated against the active body;
      // the distinct weekly entry still appears.
      expect(relSection).toContain("topics/-100123/8");
      expect(relSection).not.toContain("backups run nightly");
    });
  });
});
