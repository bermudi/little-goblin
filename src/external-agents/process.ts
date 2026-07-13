import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";

const STDERR_MAX_CHARS = 64 * 1024;

export class ProcessHandleImpl implements ProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly _process: ReturnType<typeof nodeSpawn>;
  private readonly _exitPromise: Promise<ProcessExit>;
  private _stderr = "";
  private _lines: AsyncIterable<string> | undefined;
  private _exited = false;
  private _killed = false;

  constructor(child: ReturnType<typeof nodeSpawn>) {
    this._process = child;
    this.stdin = child.stdin!;
    this.stdout = child.stdout!;

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        this._stderr += chunk.toString("utf-8");
        if (this._stderr.length > STDERR_MAX_CHARS) {
          this._stderr = this._stderr.slice(-STDERR_MAX_CHARS);
        }
      });
    }

    this._exitPromise = new Promise<ProcessExit>((resolve) => {
      child.on("exit", (code: number | null, signal: string | null) => {
        this._exited = true;
        resolve({ exitCode: code ?? null, signal: signal ?? null });
      });
    });
  }

  readLines(): AsyncIterable<string> {
    if (this._lines === undefined) {
      this._lines = createInterface({ input: this.stdout });
    }
    return this._lines;
  }

  async waitForExit(): Promise<ProcessExit> {
    return this._exitPromise;
  }

  async kill(): Promise<void> {
    if (this._exited || this._killed) return;
    this._killed = true;

    try {
      this._process.kill("SIGTERM");
    } catch {
      // already gone
    }

    const timer = setTimeout(() => {
      if (!this._exited) {
        try {
          this._process.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 2000);

    this._exitPromise.then(() => clearTimeout(timer));
    await this._exitPromise;
  }

  getStderr(): string {
    return this._stderr;
  }
}

export class ProcessHostImpl implements ProcessHost {
  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const { command, cwd, env, stdin, signal } = args;
    const [bin, ...spawnArgs] = command;
    if (bin === undefined) {
      throw new Error("Process spawn command is empty");
    }

    if (signal?.aborted) {
      throw new Error("Spawn aborted");
    }

    const child = nodeSpawn(bin, spawnArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handle = new ProcessHandleImpl(child);

    const spawnPromise = new Promise<void>((resolve, reject) => {
      child.on("spawn", () => resolve());
      child.on("error", (err: Error) => reject(new Error(`Failed to spawn ${bin}: ${err.message}`)));
    });

    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        const abort = () => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          reject(new Error("Spawn aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        child.on("exit", () => signal.removeEventListener("abort", abort));
      });
      try {
        await Promise.race([spawnPromise, abortPromise]);
      } finally {
        // The losing promise may reject later; consume it to avoid unhandled
        // rejections while the caller handles the result of the race.
        Promise.allSettled([spawnPromise, abortPromise]);
      }
    } else {
      await spawnPromise;
    }

    if (stdin !== undefined) {
      await new Promise<void>((resolve, reject) => {
        handle.stdin.write(stdin, "utf-8", (err: Error | null | undefined) => {
          if (err) {
            reject(err);
          } else {
            handle.stdin.end(resolve);
          }
        });
      });
    }

    return handle;
  }
}

export function defaultProcessHost(): ProcessHost {
  return new ProcessHostImpl();
}
