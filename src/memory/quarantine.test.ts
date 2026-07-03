import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { appendQuarantine, quarantinePath, type QuarantineRecord } from "./quarantine.ts";
import { memoryDir } from "./paths.ts";
import { formatSnapshot } from "./snapshot.ts";
import {
  createMemoryReadIndexTool,
  createMemoryReadTool,
} from "./tool.ts";
import type { ActiveScope } from "./scope.ts";

const NULL_CTX = {} as Parameters<ReturnType<typeof createMemoryReadTool>["execute"]>[4];
const TOPIC_SCOPE: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: null,
};

function textOf(result: Awaited<ReturnType<ReturnType<typeof createMemoryReadTool>["execute"]>>): string {
  const content = result.content[0];
  expect(content?.type).toBe("text");
  return content?.type === "text" ? content.text : "";
}

function jsonOf<T>(result: Awaited<ReturnType<ReturnType<typeof createMemoryReadTool>["execute"]>>): T {
  return JSON.parse(textOf(result)) as T;
}

describe("quarantine store", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-quarantine-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends a redacted JSONL record to quarantine.jsonl", () => {
    const record = appendQuarantine({
      goblinHome: tmp,
      sourceSession: "s_1",
      targetScope: "user",
      category: "preference",
      reason: "unsafe",
      content: "password: hunter2",
      timestamp: "2026-07-03T00:00:00.000Z",
    });
    expect(record.timestamp).toBe("2026-07-03T00:00:00.000Z");
    expect(record.sourceSession).toBe("s_1");
    expect(record.targetScope).toBe("user");
    expect(record.category).toBe("preference");
    expect(record.reason).toBe("unsafe");
    expect(record.preview).not.toContain("hunter2");

    const raw = readFileSync(quarantinePath(tmp), "utf-8").trim().split("\n");
    expect(raw.length).toBe(1);
    const parsed = JSON.parse(raw[0]!) as QuarantineRecord;
    expect(parsed.timestamp).toBe("2026-07-03T00:00:00.000Z");
    expect(parsed.sourceSession).toBe("s_1");
    expect(parsed.targetScope).toBe("user");
    expect(parsed.reason).toBe("unsafe");
    expect(parsed.preview).not.toContain("hunter2");
  });

  it("appends multiple records as separate JSONL lines", () => {
    appendQuarantine({
      goblinHome: tmp,
      sourceSession: "s_1",
      targetScope: "user",
      category: null,
      reason: "low_confidence",
      content: "maybe a fact",
    });
    appendQuarantine({
      goblinHome: tmp,
      sourceSession: "s_2",
      targetScope: "topics/-100/42",
      category: "decision",
      reason: "procedural_noise",
      content: "run the tests now",
    });
    const raw = readFileSync(quarantinePath(tmp), "utf-8").trim().split("\n");
    expect(raw.length).toBe(2);
    const r1 = JSON.parse(raw[0]!) as QuarantineRecord;
    const r2 = JSON.parse(raw[1]!) as QuarantineRecord;
    expect(r1.sourceSession).toBe("s_1");
    expect(r2.sourceSession).toBe("s_2");
    expect(r1.reason).toBe("low_confidence");
    expect(r2.reason).toBe("procedural_noise");
  });

  it("redacts long secret-like runs in the preview", () => {
    const record = appendQuarantine({
      goblinHome: tmp,
      sourceSession: "s_1",
      targetScope: "general",
      category: "project_fact",
      reason: "unsafe",
      content: "the key is sk-abcdefghijklmnopqrstuvwxyz1234567890",
    });
    expect(record.preview).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(record.preview).toContain("[redacted:");
  });

  it("defaults timestamp to a valid ISO string when not provided", () => {
    const record = appendQuarantine({
      goblinHome: tmp,
      sourceSession: "s_1",
      targetScope: "user",
      category: null,
      reason: "review",
      content: "some content",
    });
    expect(() => new Date(record.timestamp).toISOString()).not.toThrow();
  });

  describe("snapshots and reads ignore quarantine by construction", () => {
    it("formatSnapshot returns null when only quarantine has content", async () => {
      appendQuarantine({
        goblinHome: tmp,
        sourceSession: "s_1",
        targetScope: "user",
        category: "preference",
        reason: "unsafe",
        content: "password: hunter2",
      });
      const snapshot = await formatSnapshot({
        store,
        activeScope: TOPIC_SCOPE,
        includeAgents: true,
      });
      expect(snapshot).toBeNull();
    });

    it("memory_read_index does not mention quarantine", async () => {
      appendQuarantine({
        goblinHome: tmp,
        sourceSession: "s_1",
        targetScope: "topics/-100/42",
        category: null,
        reason: "low_confidence",
        content: "maybe a fact",
      });
      const readIndexTool = createMemoryReadIndexTool({
        store,
        activeScope: TOPIC_SCOPE,
        includeAgents: true,
      });
      const index = jsonOf<{
        general: unknown;
        topics: unknown[];
        agents: unknown[];
      }>(await readIndexTool.execute("call-idx", {}, undefined, undefined, NULL_CTX));
      const serialized = JSON.stringify(index);
      expect(serialized).not.toContain("quarantine");
      expect(index.topics).toEqual([]);
      expect(index.agents).toEqual([]);
    });

    it("memory_read does not mention quarantine", async () => {
      appendQuarantine({
        goblinHome: tmp,
        sourceSession: "s_1",
        targetScope: "user",
        category: null,
        reason: "review",
        content: "some content",
      });
      const readTool = createMemoryReadTool({ store, activeScope: TOPIC_SCOPE });
      const result = jsonOf<{ body: string; description?: string }>(
        await readTool.execute("call-read", { target: "memory" }, undefined, undefined, NULL_CTX),
      );
      expect(result.body).toBe("");
      expect(JSON.stringify(result)).not.toContain("quarantine");
    });
  });
});
