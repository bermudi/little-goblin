import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastAssistantMessage } from "./voice.ts";

function writeTranscript(home: string, sessionId: string, lines: object[]): void {
  const dir = join(home, "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(join(dir, "transcript.jsonl"), content);
}

describe("readLastAssistantMessage", () => {
  let home: string;
  const sessionId = "sess-voice-test";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-voice-cmd-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns text from a single assistant message", async () => {
    writeTranscript(home, sessionId, [
      { role: "assistant", content: "Hello from goblin" },
    ]);
    expect(await readLastAssistantMessage(home, sessionId)).toBe("Hello from goblin");
  });

  it("returns the most recent assistant message, skipping user and toolResult", async () => {
    writeTranscript(home, sessionId, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "old answer" },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: "latest answer" },
    ]);
    expect(await readLastAssistantMessage(home, sessionId)).toBe("latest answer");
  });

  it("concatenates text blocks and skips thinking, toolCall, and image blocks", async () => {
    writeTranscript(home, sessionId, [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "part one " },
          { type: "toolCall", id: "c1", name: "bash", arguments: {} },
          { type: "image", mimeType: "image/png" },
          { type: "text", text: "part two" },
        ],
      },
    ]);
    expect(await readLastAssistantMessage(home, sessionId)).toBe("part one part two");
  });

  it("returns null when the last assistant message has only non-text blocks", async () => {
    writeTranscript(home, sessionId, [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "only thinking" },
          { type: "toolCall", id: "c1", name: "bash", arguments: {} },
          { type: "image", mimeType: "image/png" },
        ],
      },
    ]);
    expect(await readLastAssistantMessage(home, sessionId)).toBeNull();
  });

  it("returns null when the transcript file does not exist", async () => {
    expect(await readLastAssistantMessage(home, sessionId)).toBeNull();
  });

  it("returns null when there are no assistant entries", async () => {
    writeTranscript(home, sessionId, [
      { role: "user", content: "hello" },
      { role: "toolResult", content: [{ type: "text", text: "done" }] },
    ]);
    expect(await readLastAssistantMessage(home, sessionId)).toBeNull();
  });
});
