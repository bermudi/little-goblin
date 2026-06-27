import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_VOICE_NAME = "en-US-EmmaMultilingualNeural";

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

export function resolveVoiceName(): string {
  return process.env.VOICE_NAME ?? DEFAULT_VOICE_NAME;
}

export function voiceTmpPath(): string {
  return join(tmpdir(), `goblin-voice-${randomUUID()}.mp3`);
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
