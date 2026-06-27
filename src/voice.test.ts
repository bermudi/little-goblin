import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEdgeTtsAvailable, edgeTts, resolveVoiceName, resetVoiceConfig, configureVoice, stripEmojis, voiceTmpPath } from "./voice.ts";

const originalVoiceName = process.env.VOICE_NAME;
const originalPath = process.env.PATH;

describe("voice", () => {
  beforeEach(() => {
    delete process.env.VOICE_NAME;
    process.env.PATH = originalPath;
    resetVoiceConfig();
  });

  afterEach(() => {
    if (originalVoiceName === undefined) {
      delete process.env.VOICE_NAME;
    } else {
      process.env.VOICE_NAME = originalVoiceName;
    }
    process.env.PATH = originalPath;
    resetVoiceConfig();
  });

  it("resolves the default voice name", () => {
    expect(resolveVoiceName()).toBe("en-US-EmmaMultilingualNeural");
  });

  it("resolves VOICE_NAME when set", () => {
    process.env.VOICE_NAME = "en-US-AndrewMultilingualNeural";
    expect(resolveVoiceName()).toBe("en-US-AndrewMultilingualNeural");
  });

  it("resolves voiceName from config when VOICE_NAME is unset", () => {
    configureVoice({ voiceName: "en-US-AndrewMultilingualNeural" });
    expect(resolveVoiceName()).toBe("en-US-AndrewMultilingualNeural");
  });

  it("prefers VOICE_NAME env over config voiceName", () => {
    configureVoice({ voiceName: "en-US-EmmaMultilingualNeural" });
    process.env.VOICE_NAME = "en-US-AndrewMultilingualNeural";
    expect(resolveVoiceName()).toBe("en-US-AndrewMultilingualNeural");
  });

  it("produces unique paths in tmpdir", () => {
    const first = voiceTmpPath();
    const second = voiceTmpPath();
    expect(first).not.toBe(second);
    expect(first.startsWith(join(tmpdir(), "goblin-voice-"))).toBe(true);
    expect(second.startsWith(join(tmpdir(), "goblin-voice-"))).toBe(true);
    expect(first.endsWith(".mp3")).toBe(true);
    expect(second.endsWith(".mp3")).toBe(true);
  });

  it("strips emoji pictographs and collapses whitespace", () => {
    expect(stripEmojis("Morning, Daniel! ☀️")).toBe("Morning, Daniel!");
    expect(stripEmojis("Get some sleep 🌙")).toBe("Get some sleep");
    expect(stripEmojis("hello 😅 world")).toBe("hello world");
    expect(stripEmojis("no emoji")).toBe("no emoji");
    expect(stripEmojis("☀️🌙")).toBe("");
    expect(stripEmojis("👨‍👩‍👧 family")).toBe("family");
  });

  it("generates a valid MP3 with edge-tts", async () => {
    const outputPath = voiceTmpPath();
    try {
      await edgeTts("Hello from goblin.", resolveVoiceName(), outputPath);
      expect(existsSync(outputPath)).toBe(true);
      const data = readFileSync(outputPath);
      expect(data.length).toBeGreaterThan(3);
      const hasId3Header = data.subarray(0, 3).toString() === "ID3";
      const secondByte = data[1];
      const hasFrameSync = data[0] === 0xff && secondByte !== undefined && (secondByte & 0xe0) === 0xe0;
      expect(hasId3Header || hasFrameSync).toBe(true);
    } finally {
      unlinkIfExists(outputPath);
    }
  }, 60_000);

  it("strips emojis before sending text to edge-tts", async () => {
    const outputPath = voiceTmpPath();
    try {
      await edgeTts("Hello from goblin. ☀️", resolveVoiceName(), outputPath);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      unlinkIfExists(outputPath);
    }
  }, 60_000);

  it("throws when text is only emojis", async () => {
    const outputPath = voiceTmpPath();
    await expect(edgeTts("😅🌙", resolveVoiceName(), outputPath)).rejects.toThrow(
      /empty after stripping emojis/i,
    );
    unlinkIfExists(outputPath);
  });

  it("throws with stderr when edge-tts receives an invalid voice", async () => {
    const outputPath = voiceTmpPath();
    try {
      await expect(edgeTts("Hello.", "not-a-real-edge-voice", outputPath)).rejects.toThrow(/not-a-real-edge-voice|voice/i);
    } finally {
      unlinkIfExists(outputPath);
    }
  }, 60_000);

  it("asserts edge-tts availability and the configured voice", async () => {
    await expect(assertEdgeTtsAvailable()).resolves.toBeUndefined();
  }, 60_000);

  it("throws when VOICE_NAME is invalid", async () => {
    process.env.VOICE_NAME = "invalid-voice";
    await expect(assertEdgeTtsAvailable()).rejects.toThrow(/invalid-voice|voice/i);
  }, 60_000);

  it("throws when uvx cannot be spawned", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "goblin-empty-path-"));
    process.env.PATH = emptyPath;
    try {
      await expect(assertEdgeTtsAvailable()).rejects.toThrow(/failed to start uvx|uvx edge-tts failed/);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}
