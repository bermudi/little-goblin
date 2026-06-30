import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { executeVoice, readLastAssistantMessage } from "./voice.ts";

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

describe("executeVoice", () => {
  let home: string;
  const sessionId = "sess-voice-exec";
  const chatId = 42;
  const topicId = 7;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-voice-exec-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(lines: object[]): void {
    const dir = join(home, "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    writeFileSync(join(dir, "transcript.jsonl"), content);
  }

  type SendVoiceMock = ReturnType<typeof mock<(chatId: number, file: InputFile, opts?: { message_thread_id?: number }) => Promise<{ message_id: number }>>>;

  function makeBot(sendVoice: SendVoiceMock = mock(async () => ({ message_id: 1 }))): Bot {
    return { api: { sendVoice } } as unknown as Bot;
  }

  it("returns no-messages when the transcript has no assistant text", async () => {
    writeTranscript([{ role: "user", content: "hello" }]);
    const sendVoice = mock(async () => ({ message_id: 1 }));
    const result = await executeVoice({ home, sessionId, bot: makeBot(sendVoice), chatId });
    expect(result).toEqual({ kind: "no-messages" });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("generates audio and sends a voice message", async () => {
    writeTranscript([{ role: "assistant", content: "Hello from goblin." }]);
    const sendVoice = mock(async () => ({ message_id: 99 }));
    const result = await executeVoice({
      home,
      sessionId,
      bot: makeBot(sendVoice),
      chatId,
      topicId,
    });
    expect(result).toEqual({ kind: "sent" });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    const call = sendVoice.mock.calls[0];
    expect(call).toBeDefined();
    const [calledChatId, file, opts] = call as unknown as [
      number,
      InputFile,
      { message_thread_id?: number },
    ];
    expect(calledChatId).toBe(chatId);
    expect(file).toBeInstanceOf(InputFile);
    expect(opts).toEqual({ message_thread_id: topicId });
  }, 60_000);

  it("cleans up the temp mp3 after sending", async () => {
    writeTranscript([{ role: "assistant", content: "Short line." }]);
    let capturedPath: string | undefined;
    const sendVoice = mock(async (_chatId: number, file: InputFile) => {
      capturedPath = file.filename;
      return { message_id: 1 };
    });
    await executeVoice({ home, sessionId, bot: makeBot(sendVoice), chatId });
    expect(capturedPath).toBeDefined();
    expect(existsSync(capturedPath!)).toBe(false);
  }, 60_000);

  it("returns tts-failed when sendVoice throws", async () => {
    writeTranscript([{ role: "assistant", content: "Hello." }]);
    const sendVoice = mock(async () => {
      throw new Error("network down");
    });
    const result = await executeVoice({ home, sessionId, bot: makeBot(sendVoice), chatId });
    expect(result).toEqual({ kind: "tts-failed", error: "network down" });
  }, 60_000);
});
