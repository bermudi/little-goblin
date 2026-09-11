import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDreamingResponse } from "./dreaming-parse.ts";
import { quarantinePath } from "../memory/paths.ts";
import type { QuarantineRecord } from "../memory/quarantine.ts";
import type { TranscriptLine } from "../sessions/transcript.ts";

const CONVERSATION_ID = "session-1";

const sampleLines: TranscriptLine[] = [
  { index: 0, role: "user", text: "hello", ts: "2026-07-01T00:00:00.000Z" },
  { index: 1, role: "assistant", text: "noted", ts: "2026-07-01T00:00:01.000Z" },
];

describe("parseDreamingResponse", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-dreaming-parse-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function parse(raw: string, lines: TranscriptLine[] = sampleLines) {
    return parseDreamingResponse({ raw, conversationId: CONVERSATION_ID, lines, goblinHome: tmpDir });
  }

  function quarantineRecords(): QuarantineRecord[] {
    const path = quarantinePath(tmpDir);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8").trim();
    if (raw.length === 0) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as QuarantineRecord);
  }

  it("accepts valid candidates and defaults absent target to memory", () => {
    const raw = JSON.stringify({
      candidates: [
        { target: "user", category: "fact", confidence: 0.85, text: "User likes tea.", lineRange: [0, 0] },
        { category: "theme", confidence: "0.5", text: "Recurring topic.", lineRange: [1, 1] },
      ],
    });
    const result = parse(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      target: "user",
      category: "fact",
      confidence: 0.85,
      text: "User likes tea.",
      source: { sessionId: CONVERSATION_ID, lineRange: [0, 0], sourceRole: "user" },
    });
    expect(result[1]?.target).toBe("memory");
    expect(result[1]?.confidence).toBe(0.5);
    expect(quarantineRecords()).toHaveLength(0);
  });

  it("unwraps markdown code fences around the JSON payload", () => {
    const inner = JSON.stringify({
      candidates: [{ category: "fact", confidence: 0.9, text: "User likes tea.", lineRange: [0, 0] }],
    });
    const result = parse(`\`\`\`json\n${inner}\n\`\`\``);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("User likes tea.");
  });

  it("rejects invalid categories, out-of-range confidence, and invalid text without discarding valid siblings", () => {
    const raw = JSON.stringify({
      candidates: [
        { target: "memory", category: "bogus", confidence: 0.85, text: "User likes tea.", lineRange: [0, 0] },
        { target: "memory", category: "fact", confidence: 1.5, text: "User likes coffee.", lineRange: [0, 0] },
        { target: "memory", category: "fact", confidence: -0.1, text: "User likes coffee.", lineRange: [0, 0] },
        { target: "bogus", category: "fact", confidence: 0.9, text: "User likes tea.", lineRange: [0, 0] },
        { target: "memory", category: "fact", confidence: 0.9, lineRange: [0, 0] },
        { target: "memory", category: "fact", confidence: 0.9, text: "   ", lineRange: [0, 0] },
        { target: "memory", category: "fact", confidence: 0.9, text: "Valid fact.", lineRange: [0, 0] },
      ],
    });
    const result = parse(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Valid fact.");
    expect(quarantineRecords()).toHaveLength(6);
  });

  it("rejects invalid or inverted line ranges while absent lineRange falls back to excerpt bounds", () => {
    const raw = JSON.stringify({
      candidates: [
        { category: "fact", confidence: 0.85, text: "Inverted.", lineRange: [1, 0] },
        { category: "fact", confidence: 0.85, text: "Short.", lineRange: [0] },
        { category: "fact", confidence: 0.85, text: "Long.", lineRange: [0, 1, 2] },
        { category: "fact", confidence: 0.85, text: "Not array.", lineRange: "0-1" },
        { category: "fact", confidence: 0.85, text: "Null range.", lineRange: null },
        { category: "fact", confidence: 0.85, text: "Fallback." },
      ],
    });
    const result = parse(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Fallback.");
    // Absent lineRange falls back to the excerpt bounds: first..last index.
    expect(result[0]?.source.lineRange).toEqual([0, 1]);
    expect(quarantineRecords()).toHaveLength(5);
  });

  it("accepts `summary` as a `text` alias", () => {
    const raw = JSON.stringify({
      candidates: [
        { category: "fact", confidence: 0.85, summary: "User likes tea.", lineRange: [0, 0] },
        { category: "fact", confidence: 0.85, text: 5, summary: "Non-string text falls back to summary.", lineRange: [0, 0] },
      ],
    });
    const result = parse(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("User likes tea.");
    expect(result[1]?.text).toBe("Non-string text falls back to summary.");
  });

  it("rejects when a present string `text` is empty even if `summary` is valid", () => {
    const raw = JSON.stringify({
      candidates: [
        { category: "fact", confidence: 0.85, text: "", summary: "Shadowed.", lineRange: [0, 0] },
      ],
    });
    expect(parse(raw)).toHaveLength(0);
    expect(quarantineRecords()).toHaveLength(1);
  });

  it("maps the source role from the range's start line", () => {
    const lines: TranscriptLine[] = [
      { index: 0, role: "user", text: "u", ts: "2026-07-01T00:00:00.000Z" },
      { index: 1, role: "assistant", text: "a", ts: "2026-07-01T00:00:01.000Z" },
      { index: 2, role: "toolResult", text: "t", ts: "2026-07-01T00:00:02.000Z" },
      { index: 3, role: "unknown", text: "?", ts: "2026-07-01T00:00:03.000Z" },
    ];
    const raw = JSON.stringify({
      candidates: [
        { category: "fact", confidence: 0.9, text: "from assistant", lineRange: [1, 1] },
        { category: "fact", confidence: 0.9, text: "from tool", lineRange: [2, 2] },
        { category: "fact", confidence: 0.9, text: "from unknown", lineRange: [3, 3] },
        { category: "fact", confidence: 0.9, text: "from missing line", lineRange: [9, 9] },
        { category: "fact", confidence: 0.9, text: "from fallback" },
      ],
    });
    const result = parse(raw, lines);
    expect(result.map((c) => c.source.sourceRole)).toEqual(["assistant", "tool", "system", "system", "user"]);
  });

  it("quarantines each malformed item individually", () => {
    const raw = JSON.stringify({
      candidates: [
        { category: "bogus", confidence: 0.5, text: "a", lineRange: [0, 0] },
        42,
        "text-item",
        { category: "fact", confidence: 0.9, text: "survives", lineRange: [0, 0] },
      ],
    });
    const result = parse(raw);
    expect(result).toHaveLength(1);
    const records = quarantineRecords();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.reason).toBe("malformed");
      expect(record.sourceSession).toBe(CONVERSATION_ID);
      expect(record.targetScope).toBe(`transcript/${CONVERSATION_ID}`);
      expect(record.category).toBeNull();
    }
  });

  it("quarantines a malformed top-level payload exactly once per call", () => {
    for (const raw of [
      "not json at all",
      "{}",
      JSON.stringify({ candidates: "nope" }),
      JSON.stringify([1, 2]),
      "null",
    ]) {
      expect(parse(raw)).toEqual([]);
    }
    const records = quarantineRecords();
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.reason).toBe("malformed");
      expect(record.targetScope).toBe(`transcript/${CONVERSATION_ID}`);
    }
  });

  it("returns no candidates and no quarantine record for empty payloads", () => {
    expect(parse("")).toEqual([]);
    expect(parse("   \n  ")).toEqual([]);
    expect(parse(JSON.stringify({ candidates: [] }))).toEqual([]);
    expect(quarantineRecords()).toHaveLength(0);
  });

  it("propagates quarantine append failures instead of swallowing them", () => {
    const blockingFile = join(tmpDir, "blocking");
    writeFileSync(blockingFile, "x", "utf-8");
    expect(() =>
      parseDreamingResponse({
        raw: "not json",
        conversationId: CONVERSATION_ID,
        lines: sampleLines,
        goblinHome: blockingFile,
      }),
    ).toThrow();
  });
});
