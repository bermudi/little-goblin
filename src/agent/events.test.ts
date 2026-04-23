import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "./events.ts";

describe("appendEvent", () => {
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-events-test-"));
    sessionId = "test-session-123";
    // Create session directory and empty events.jsonl
    const sessionDir = join(tmpDir, "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a single event", () => {
    appendEvent(sessionId, tmpDir, { type: "test", data: "hello" });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("test");
    expect(parsed.data).toBe("hello");
    expect(parsed.ts).toBeDefined();
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves existing ts if already present", () => {
    const customTs = "2024-01-15T10:30:00.000Z";
    appendEvent(sessionId, tmpDir, { type: "test", ts: customTs });

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBe(customTs);
  });

  it("writes 1000 events concurrently without corruption", async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          appendEvent(sessionId, tmpDir, { type: "concurrent", index: i });
          resolve();
        })
      );
    }

    await Promise.all(promises);

    const content = readFileSync(join(tmpDir, "sessions", sessionId, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1000);

    // Verify every line is valid JSON
    const indices = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe("concurrent");
      expect(typeof parsed.index).toBe("number");
      expect(parsed.ts).toBeDefined();
      indices.add(parsed.index);
    }

    // Verify all indices are unique and present
    expect(indices.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(indices.has(i)).toBe(true);
    }
  });

  it("creates file if it does not exist", () => {
    const newSessionId = "new-session-456";
    const sessionDir = join(tmpDir, "sessions", newSessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Don't create events.jsonl

    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(false);

    appendEvent(newSessionId, tmpDir, { type: "first" });

    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
    const content = readFileSync(join(sessionDir, "events.jsonl"), "utf-8");
    expect(content.trim()).not.toBe("");
  });
});
