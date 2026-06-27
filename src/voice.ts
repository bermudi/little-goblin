import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_VOICE_NAME = "en-US-EmmaMultilingualNeural";

export { DEFAULT_VOICE_NAME };

let configVoiceName: string | undefined;

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

/** Apply voice name from goblin.json5. Call once at startup. */
export function configureVoice(cfg: { voiceName: string }): void {
  configVoiceName = cfg.voiceName;
}

/** Clear config voice (tests). */
export function resetVoiceConfig(): void {
  configVoiceName = undefined;
}

export function resolveVoiceName(): string {
  return process.env.VOICE_NAME ?? configVoiceName ?? DEFAULT_VOICE_NAME;
}

export function voiceTmpPath(): string {
  return join(tmpdir(), `goblin-voice-${randomUUID()}.mp3`);
}

/** Remove emoji pictographs and stray joiners before TTS. */
export function stripEmojis(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu, "")
    .replace(/\u200d/gi, "")
    .replace(/[\ufe0e\ufe0f]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function edgeTts(text: string, voice: string, outputPath: string): Promise<void> {
  const spoken = stripEmojis(text);
  if (spoken.length === 0) {
    throw new Error("text is empty after stripping emojis");
  }
  const textPath = join(tmpdir(), `goblin-voice-${randomUUID()}.txt`);
  await writeFile(textPath, spoken);
  try {
    await runUvxEdgeTts(["--file", textPath, "--voice", voice, "--write-media", outputPath], 30_000);
  } finally {
    await unlink(textPath).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return;
      throw err;
    });
  }
}

export async function assertEdgeTtsAvailable(): Promise<void> {
  await runUvxEdgeTts(["--version"], 10_000);

  const outputPath = voiceTmpPath();
  try {
    await edgeTts("ok", resolveVoiceName(), outputPath);
  } finally {
    await unlink(outputPath).catch((err: unknown) => {
      if (isNodeError(err) && err.code === "ENOENT") return;
      throw err;
    });
  }
}

async function runUvxEdgeTts(args: string[], timeoutMs: number): Promise<void> {
  const result = await runCommand("uvx", ["edge-tts", ...args], timeoutMs);
  if (result.code === 0) return;
  const detail = result.stderr.trim() || formatExit(result);
  throw new Error(`uvx edge-tts failed: ${detail}`);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to start ${command}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

function formatExit(result: CommandResult): string {
  if (result.signal !== null) return `terminated by signal ${result.signal}`;
  return `exit code ${result.code ?? "unknown"}`;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
