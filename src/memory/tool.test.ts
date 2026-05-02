import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";
import { createMemoryTool } from "./tool.ts";
import { memoryDir, memoryFilePath } from "./paths.ts";

const NULL_CTX = {} as Parameters<ReturnType<typeof createMemoryTool>["execute"]>[4];

describe("memory tool", () => {
  let tmp: string;
  let store: MemoryStore;
  let tool: ReturnType<typeof createMemoryTool>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-memory-tool-"));
    mkdirSync(memoryDir(tmp), { recursive: true });
    store = new MemoryStore(tmp);
    tool = createMemoryTool(store);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes the canonical name and metadata", () => {
    expect(tool.name).toBe("memory");
    expect(tool.label).toBeDefined();
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
  });

  it("add happy path returns a success message and updates the store", async () => {
    const r = await tool.execute(
      "call-1",
      { action: "add", target: "memory", content: "alpha" },
      undefined,
      undefined,
      NULL_CTX,
    );
    expect(r.content[0]?.type).toBe("text");
    if (r.content[0]?.type === "text") {
      expect(r.content[0].text).toContain("memory.md");
      expect(r.content[0].text).toContain("added");
    }
    expect(store.readBody("memory")).toBe("alpha");
  });

  it("rejects replace with no old_text and does not write", async () => {
    store.add("user", "x");
    const before = readFileSync(memoryFilePath(tmp, "user"), "utf-8");
    await expect(
      tool.execute(
        "call-2",
        { action: "replace", target: "user", content: "y" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/old_text/);
    expect(readFileSync(memoryFilePath(tmp, "user"), "utf-8")).toBe(before);
  });

  it("rejects add with no content", async () => {
    await expect(
      tool.execute(
        "call-3",
        { action: "add", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/content/);
  });

  it("rejects remove with no old_text", async () => {
    await expect(
      tool.execute(
        "call-4",
        { action: "remove", target: "memory" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/old_text/);
  });

  it("propagates overflow errors as thrown errors; store unchanged", async () => {
    writeFileSync(memoryFilePath(tmp, "user"), "a".repeat(1999), "utf-8");
    const before = readFileSync(memoryFilePath(tmp, "user"), "utf-8");
    await expect(
      tool.execute(
        "call-5",
        { action: "add", target: "user", content: "bb" },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/cap|overflow/i);
    expect(readFileSync(memoryFilePath(tmp, "user"), "utf-8")).toBe(before);
  });

  it("propagates ambiguous-replace errors; store unchanged", async () => {
    store.add("memory", "alpha");
    store.add("memory", "alpha");
    const before = store.read("memory");
    await expect(
      tool.execute(
        "call-6",
        {
          action: "replace",
          target: "memory",
          old_text: "alpha",
          content: "X",
        },
        undefined,
        undefined,
        NULL_CTX,
      ),
    ).rejects.toThrow(/unique/);
    expect(store.read("memory")).toEqual(before);
  });
});
