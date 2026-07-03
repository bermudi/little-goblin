import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import {
  createMemoryReadIndexTool,
  createMemoryReadTool,
  createMemoryWriteTool,
} from "./tool.ts";
import { memoryDir, scopeMemoryPath, userPath } from "./paths.ts";
import type { ActiveScope } from "./scope.ts";

// Context param is typed by pi-coding-agent but unused in these tests.
// We cast an empty object to satisfy the type system without coupling to pi internals.
const NULL_CTX = {} as Parameters<ReturnType<typeof createMemoryWriteTool>["execute"]>[4];
const TOPIC_SCOPE: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: null,
};
const NAMED_AGENT_SCOPE: ActiveScope = {
  chatId: -100,
  topicScope: { topicId: 42 },
  namedAgent: { name: "researcher" },
};

function textOf(result: Awaited<ReturnType<ReturnType<typeof createMemoryWriteTool>["execute"]>>): string {
  const content = result.content[0];
  expect(content?.type).toBe("text");
  return content?.type === "text" ? content.text : "";
}

function jsonOf<T>(result: Awaited<ReturnType<ReturnType<typeof createMemoryReadTool>["execute"]>>): T {
  return JSON.parse(textOf(result)) as T;
}

describe("memory tool", () => {
  let tmp: string;
  let store: MemoryStore;
  let readTool: ReturnType<typeof createMemoryReadTool>;
  let readIndexTool: ReturnType<typeof createMemoryReadIndexTool>;
  let writeTool: ReturnType<typeof createMemoryWriteTool>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-tool-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
    readTool = createMemoryReadTool({ store, activeScope: TOPIC_SCOPE });
    readIndexTool = createMemoryReadIndexTool({
      store,
      activeScope: TOPIC_SCOPE,
      includeAgents: true,
    });
    writeTool = createMemoryWriteTool({ store, activeScope: TOPIC_SCOPE });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes the split canonical names and metadata", () => {
    expect(readTool.name).toBe("memory_read");
    expect(readIndexTool.name).toBe("memory_read_index");
    expect(writeTool.name).toBe("memory_write");
    expect(readTool.parameters).toBeDefined();
    expect(readIndexTool.parameters).toBeDefined();
    expect(writeTool.parameters).toBeDefined();
  });

  it("write schema has no scope key", () => {
    const properties = (writeTool.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain("scope");
  });

  it("uses the same write schema for named and unnamed callers", () => {
    const namedWriteTool = createMemoryWriteTool({ store, activeScope: NAMED_AGENT_SCOPE });
    expect(namedWriteTool.parameters).toEqual(writeTool.parameters);
  });

  it("target=memory from a topic-bound scope writes to that topic", async () => {
    const r = await writeTool.execute(
      "call-1",
      { action: "add", target: "memory", content: "alpha" },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(textOf(r)).toContain("added");
    expect(store.readBody({ topic: { chatId: -100, topicId: 42 } })).toBe("alpha");
    expect(store.readBody("general")).toBe("");
  });

  it("target=agent is rejected for callers without namedAgent", async () => {
    await expect(
      writeTool.execute(
        "call-agent",
        { action: "add", target: "agent", content: "alpha" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/named subagents/);
    expect(store.readBody({ agent: { name: "researcher" } })).toBe("");
  });

  it("target=agent writes named-agent persona memory", async () => {
    const namedWriteTool = createMemoryWriteTool({ store, activeScope: NAMED_AGENT_SCOPE });
    await namedWriteTool.execute(
      "call-named-agent",
      { action: "add", target: "agent", content: "persona fact" },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(store.readBody({ agent: { name: "researcher" } })).toBe("persona fact");
    expect(store.readBody({ topic: { chatId: -100, topicId: 42 } })).toBe("");
  });

  it("memory_read with target=agent honors scope discriminator to read other agent persona", async () => {
    // Setup: create another agent's persona memory
    await store.add({ agent: { name: "coder" } }, "coder persona content");

    // Read via target=agent with scope specifying the other agent
    const r = await readTool.execute(
      "call-read-other-agent",
      { target: "agent", scope: { agent: { name: "coder" } } },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(jsonOf<{ body: string }>(r).body).toBe("coder persona content");
  });

  it("memory_read can read another topic in the same chat without writing", async () => {
    await store.add({ topic: { chatId: -100, topicId: 7 } }, "peer fact");
    const before = readFileSync(scopeMemoryPath(tmp, { topic: { chatId: -100, topicId: 7 } }), "utf-8");
    const r = await readTool.execute(
      "call-read-topic",
      { target: "memory", scope: { topic: { chatId: -100, topicId: 7 } } },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(jsonOf<{ body: string }>(r).body).toBe("peer fact");
    expect(readFileSync(scopeMemoryPath(tmp, { topic: { chatId: -100, topicId: 7 } }), "utf-8")).toBe(before);
  });

  it("memory_read_index returns only active-chat topics by default, all chats when all_chats: true", async () => {
    await store.setDescription({ topic: { chatId: -100, topicId: 7 } }, "same chat");
    await store.setDescription({ topic: { chatId: -200, topicId: 9 } }, "other chat");
    await store.setDescription({ agent: { name: "researcher" } }, "research persona");

    // Default call returns only active chat topics
    const current = jsonOf<{ topics: Array<{ chatId: number; topicId: number; description?: string }>; agents: unknown[] }>(
      await readIndexTool.execute("call-index", {}, undefined, undefined, NULL_CTX),
    );
    expect(current.topics).toEqual([{ chatId: -100, topicId: 7, description: "same chat" }]);
    expect(current.agents).toEqual([{ name: "researcher", description: "research persona" }]);

    // all_chats:true returns topics from all chats
    const allChats = jsonOf<{ topics: Array<{ chatId: number; topicId: number; description?: string }> }>(
      await readIndexTool.execute("call-index-all", { all_chats: true }, undefined, undefined, NULL_CTX),
    );
    expect(allChats.topics).toEqual([
      { chatId: -200, topicId: 9, description: "other chat" },
      { chatId: -100, topicId: 7, description: "same chat" },
    ]);
  });

  it("memory_read_index omits agents when includeAgents=false", async () => {
    await store.setDescription({ agent: { name: "researcher" } }, "research persona");
    const tool = createMemoryReadIndexTool({
      store,
      activeScope: { chatId: -100, topicScope: { topicId: 42 }, namedAgent: null },
      includeAgents: false,
    });
    const index = jsonOf<{ agents: unknown[] }>(
      await tool.execute("call-index-no-agents", {}, undefined, undefined, NULL_CTX),
    );
    expect(index.agents).toEqual([]);
  });

  it("rejects replace with no old_text and does not write", async () => {
    await store.add("user", "x");
    const before = readFileSync(userPath(tmp), "utf-8");
    await expect(
      writeTool.execute(
        "call-2",
        { action: "replace", target: "user", content: "y" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/old_text/);
    expect(readFileSync(userPath(tmp), "utf-8")).toBe(before);
  });

  it("rejects add with no content", async () => {
    await expect(
      writeTool.execute(
        "call-3",
        { action: "add", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/content/);
  });

  it("rejects add with empty content", async () => {
    await expect(
      writeTool.execute(
        "call-3-empty",
        { action: "add", target: "memory", content: "" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects remove with no old_text", async () => {
    await expect(
      writeTool.execute(
        "call-4",
        { action: "remove", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/old_text/);
  });

  it("validates required args for rewrite and set_description", async () => {
    await expect(
      writeTool.execute(
        "call-rewrite",
        { action: "rewrite", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/content/);
    await expect(
      writeTool.execute(
        "call-description",
        { action: "set_description", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/description/);
  });

  it("rejects set_description over 200 chars", async () => {
    await expect(
      writeTool.execute(
        "call-long-description",
        { action: "set_description", target: "memory", description: "a".repeat(201) },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/cap 200/);
  });

  it("propagates overflow errors as thrown errors; store unchanged", async () => {
    writeFileSync(userPath(tmp), "a".repeat(1999), "utf-8");
    const before = readFileSync(userPath(tmp), "utf-8");
    await expect(
      writeTool.execute(
        "call-5",
        { action: "add", target: "user", content: "bbb" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/cap|overflow/i);
    expect(readFileSync(userPath(tmp), "utf-8")).toBe(before);
  });

  it("propagates ambiguous-replace errors; store unchanged", async () => {
    const active = { topic: { chatId: -100, topicId: 42 } };
    await store.add(active, "alpha");
    await store.add(active, "alpha");
    const before = store.read(active);
    await expect(
      writeTool.execute(
        "call-6",
        {
          action: "replace",
          target: "memory",
          old_text: "alpha",
          content: "replacement content",
        },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/unique/);
    expect(store.read(active)).toEqual(before);
  });

  it("rejects cross-chat memory_read scope access", async () => {
    await store.add({ topic: { chatId: -999, topicId: 7 } }, "other chat fact");
    await expect(
      readTool.execute(
        "call-cross-chat",
        { target: "memory", scope: { topic: { chatId: -999, topicId: 7 } } },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/active chat/);
  });

  it("remove action success path deletes entry from memory", async () => {
    const active = { topic: { chatId: -100, topicId: 42 } };
    await store.add(active, "keep this");
    await store.add(active, "remove this");
    const r = await writeTool.execute(
      "call-remove",
      { action: "remove", target: "memory", old_text: "remove this" },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(textOf(r)).toContain("removed");
    expect(store.readBody(active)).toBe("keep this");
  });

  it("rewrite action success path replaces entire body", async () => {
    const active = { topic: { chatId: -100, topicId: 42 } };
    await store.add(active, "old content alpha");
    await store.add(active, "old content bravo");
    const r = await writeTool.execute(
      "call-rewrite",
      { action: "rewrite", target: "memory", content: "brand new content" },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(textOf(r)).toContain("rewrote");
    expect(store.readBody(active)).toBe("brand new content");
  });

  describe("safety filter on explicit writes", () => {
    it("rejects add with a token and does not write or commit", async () => {
      const target = { topic: { chatId: -100, topicId: 42 } };
      await expect(
        writeTool.execute(
          "call-unsafe-add",
          { action: "add", target: "memory", content: "Bearer abcdefghijklmnop1234567890" },
          undefined,
          undefined,
          NULL_CTX,
        ),
      ).rejects.toThrow(/safety filter/);
      expect(store.readBody(target)).toBe("");
    });

    it("rejects replace with a password and does not modify the existing entry", async () => {
      const target = { topic: { chatId: -100, topicId: 42 } };
      await store.add(target, "safe existing entry");
      const before = store.readBody(target);
      await expect(
        writeTool.execute(
          "call-unsafe-replace",
          {
            action: "replace",
            target: "memory",
            old_text: "safe existing entry",
            content: "password: hunter2",
          },
          undefined,
          undefined,
          NULL_CTX,
        ),
      ).rejects.toThrow(/safety filter/);
      expect(store.readBody(target)).toBe(before);
    });

    it("rejects rewrite with a token and leaves user.md unchanged", async () => {
      writeFileSync(userPath(tmp), "original user content", "utf-8");
      const before = readFileSync(userPath(tmp), "utf-8");
      await expect(
        writeTool.execute(
          "call-unsafe-rewrite",
          { action: "rewrite", target: "user", content: "password: hunter2" },
          undefined,
          undefined,
          NULL_CTX,
        ),
      ).rejects.toThrow(/safety filter/);
      expect(readFileSync(userPath(tmp), "utf-8")).toBe(before);
    });

    it("rejects set_description with a token and does not update frontmatter", async () => {
      const target = { topic: { chatId: -100, topicId: 42 } };
      await store.setDescription(target, "safe description");
      const before = store.read(target);
      await expect(
        writeTool.execute(
          "call-unsafe-description",
          {
            action: "set_description",
            target: "memory",
            description: "api_key: abc123def456",
          },
          undefined,
          undefined,
          NULL_CTX,
        ),
      ).rejects.toThrow(/safety filter/);
      expect(store.read(target)).toEqual(before);
    });

    it("accepts a safe add and persists it", async () => {
      const target = { topic: { chatId: -100, topicId: 42 } };
      const r = await writeTool.execute(
        "call-safe-add",
        { action: "add", target: "memory", content: "User prefers terse summaries." },
        undefined,
        undefined,
        NULL_CTX,
      );
      expect(textOf(r)).toContain("added");
      expect(store.readBody(target)).toBe("User prefers terse summaries.");
    });
  });
});
