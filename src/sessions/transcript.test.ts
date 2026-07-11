import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAssistantTranscriptEntry,
  appendTranscriptEntry,
  extractEntryText,
  readTranscriptAfter,
  type TranscriptEntry,
} from "./transcript.ts";
import { sessionDir, transcriptPath } from "./paths.ts";

describe("transcript module", () => {
  let tmpDir: string;
  const sessionId = "abcdef1234";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-transcript-"));
    mkdirSync(sessionDir(tmpDir, sessionId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Read the raw transcript file and parse each non-blank line. */
  function readRawEntries(): TranscriptEntry[] {
    const raw = readFileSync(transcriptPath(tmpDir, sessionId), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TranscriptEntry);
  }

  describe("writer ↔ reader round-trip", () => {
    it("preserves an assistant entry with all optional fields", () => {
      appendTranscriptEntry(sessionId, tmpDir, {
        type: "message_end",
        ts: "2026-07-07T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet",
          responseModel: "claude-sonnet-4",
          responseId: "resp_123",
          stopReason: "end_turn",
          errorMessage: undefined,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 20,
            totalTokens: 135,
            cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
          },
        },
      });

      const entries = readRawEntries();
      expect(entries).toHaveLength(1);
      const e = entries[0]!;
      expect(e.role).toBe("assistant");
      expect(e.api).toBe("anthropic");
      expect(e.provider).toBe("anthropic");
      expect(e.model).toBe("claude-sonnet");
      expect(e.responseModel).toBe("claude-sonnet-4");
      expect(e.responseId).toBe("resp_123");
      expect(e.stopReason).toBe("end_turn");
      expect(e.usage?.totalTokens).toBe(135);
      expect(e.usage?.cost.total).toBe(0.33);
    });

    it("preserves a tool-result entry's toolCallId/toolName/isError", () => {
      appendTranscriptEntry(sessionId, tmpDir, {
        type: "message_end",
        ts: "2026-07-07T10:01:00.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "result" }],
          toolCallId: "call_42",
          toolName: "memory_search",
          isError: true,
        },
      });

      const entries = readRawEntries();
      expect(entries[0]!.role).toBe("toolResult");
      expect(entries[0]!.toolCallId).toBe("call_42");
      expect(entries[0]!.toolName).toBe("memory_search");
      expect(entries[0]!.isError).toBe(true);
    });

    it("round-trips through readTranscriptAfter", () => {
      appendTranscriptEntry(sessionId, tmpDir, {
        type: "message_end",
        ts: "2026-07-07T10:00:00.000Z",
        message: { role: "user", content: "hi there" },
      });
      appendTranscriptEntry(sessionId, tmpDir, {
        type: "message_end",
        ts: "2026-07-07T10:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello back" }] },
      });

      const lines = readTranscriptAfter(tmpDir, sessionId, 0);
      expect(lines).toHaveLength(2);
      expect(lines[0]!.index).toBe(0);
      expect(lines[0]!.role).toBe("user");
      expect(lines[0]!.text).toBe("hi there");
      expect(lines[1]!.index).toBe(1);
      expect(lines[1]!.role).toBe("assistant");
      expect(lines[1]!.text).toBe("hello back");
    });
  });

  describe("extractEntryText", () => {
    it("passes string content through unchanged", () => {
      expect(extractEntryText("plain string")).toBe("plain string");
    });

    it("concatenates text blocks and ignores non-text blocks", () => {
      const content = [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "part one " },
        { type: "toolCall", id: "1", name: "x", arguments: {} },
        { type: "text", text: "part two" },
        { type: "image", mimeType: "image/png" },
      ];
      expect(extractEntryText(content)).toBe("part one part two");
    });

    it("returns '' for non-array, non-string content", () => {
      expect(extractEntryText(undefined)).toBe("");
      expect(extractEntryText(null)).toBe("");
      expect(extractEntryText({})).toBe("");
    });

    it("handles the assistant synthetic entry's prefixed string", () => {
      appendAssistantTranscriptEntry(sessionId, tmpDir, "sorry, can't do that");
      const lines = readTranscriptAfter(tmpDir, sessionId, 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.role).toBe("assistant");
      expect(lines[0]!.text).toBe("[system] sorry, can't do that");
    });
  });

  describe("readTranscriptAfter", () => {
    it("returns [] when the transcript file does not exist (ENOENT)", () => {
      expect(readTranscriptAfter(tmpDir, "0000000000", 0)).toEqual([]);
    });

    it("skips malformed lines but counts them toward the index", () => {
      // Hand-write a transcript with one good line, one corrupted line, one good line.
      const path = transcriptPath(tmpDir, sessionId);
      const good1 = JSON.stringify({ ts: "2026-07-07T10:00:00.000Z", role: "user", content: "first" });
      const corrupted = "this is not valid json {{{";
      const good2 = JSON.stringify({ ts: "2026-07-07T10:00:02.000Z", role: "assistant", content: [{ type: "text", text: "third" }] });
      writeFileSync(path, `${good1}\n${corrupted}\n${good2}\n`, "utf-8");

      const lines = readTranscriptAfter(tmpDir, sessionId, 0);
      expect(lines).toHaveLength(3);
      expect(lines[0]!.index).toBe(0);
      expect(lines[0]!.role).toBe("user");
      expect(lines[0]!.text).toBe("first");
      // Malformed line: counted, unknown role, empty text.
      expect(lines[1]!.index).toBe(1);
      expect(lines[1]!.role).toBe("unknown");
      expect(lines[1]!.text).toBe("");
      expect(lines[2]!.index).toBe(2);
      expect(lines[2]!.role).toBe("assistant");
      expect(lines[2]!.text).toBe("third");
    });

    it("range read: excludes entries at or before processedLines, preserves absolute indices", () => {
      const path = transcriptPath(tmpDir, sessionId);
      const linesToWrite = [
        { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "a" },
        { ts: "2026-07-07T10:00:01.000Z", role: "assistant", content: [{ type: "text", text: "b" }] },
        { ts: "2026-07-07T10:00:02.000Z", role: "user", content: "c" },
        { ts: "2026-07-07T10:00:03.000Z", role: "assistant", content: [{ type: "text", text: "d" }] },
      ];
      writeFileSync(path, linesToWrite.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

      // processedLines=2 → only entries 2 and 3, with absolute indices preserved.
      const tail = readTranscriptAfter(tmpDir, sessionId, 2);
      expect(tail).toHaveLength(2);
      expect(tail[0]!.index).toBe(2);
      expect(tail[0]!.text).toBe("c");
      expect(tail[1]!.index).toBe(3);
      expect(tail[1]!.text).toBe("d");
    });

    it("interior blank lines do not desync the cursor from logical indices", () => {
      // Hand-write a transcript with an interior blank line. The writer never
      // produces these, but external corruption can. The cursor is a logical
      // (non-blank) count, so the skip guard must use a logical counter too —
      // otherwise the blank line shifts physical indices and entries get
      // re-processed.
      const path = transcriptPath(tmpDir, sessionId);
      const good1 = JSON.stringify({ ts: "2026-07-07T10:00:00.000Z", role: "user", content: "first" });
      const good2 = JSON.stringify({ ts: "2026-07-07T10:00:02.000Z", role: "assistant", content: [{ type: "text", text: "second" }] });
      const good3 = JSON.stringify({ ts: "2026-07-07T10:00:03.000Z", role: "user", content: "third" });
      // blank line between good1 and good2
      writeFileSync(path, `${good1}\n\n${good2}\n${good3}\n`, "utf-8");

      // First pass: seed cursor to 3 (three non-blank lines).
      const all = readTranscriptAfter(tmpDir, sessionId, 0);
      expect(all).toHaveLength(3);
      expect(all[0]!.index).toBe(0);
      expect(all[0]!.text).toBe("first");
      expect(all[1]!.index).toBe(1);
      expect(all[1]!.text).toBe("second");
      expect(all[2]!.index).toBe(2);
      expect(all[2]!.text).toBe("third");

      // Second pass with processedLines=3 → nothing new (no re-processing).
      const none = readTranscriptAfter(tmpDir, sessionId, 3);
      expect(none).toEqual([]);

      // processedLines=1 → only the second and third logical lines.
      const tail = readTranscriptAfter(tmpDir, sessionId, 1);
      expect(tail).toHaveLength(2);
      expect(tail[0]!.index).toBe(1);
      expect(tail[0]!.text).toBe("second");
      expect(tail[1]!.index).toBe(2);
      expect(tail[1]!.text).toBe("third");
    });
  });
});
