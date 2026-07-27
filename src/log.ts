export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Default threshold until initLog() is called
let threshold = order.info;

/** Initialize the log level from config. Call after loadConfig(). */
export function initLog(level: Level): void {
  if (order[level] === undefined) {
    process.stderr.write(
      `[log] Warning: Invalid LOG_LEVEL="${level}". Valid: debug, info, warn, error. Falling back to "info".\n`,
    );
    threshold = order.info;
  } else {
    threshold = order[level];
  }
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${JSON.stringify(extra)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};

/** Default cap for structured error summaries written to the log stream. */
export const STRUCTURED_ERROR_CAP = 256;

function safeErrorString(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "[unstringifiable error]";
  }
}

/**
 * Produce a bounded error summary suitable for structured log fields.
 *
 * Never throws, even for circular or otherwise unstringifiable values.
 * Durable error records (e.g. subagent meta.json) should keep the full
 * diagnostic; log emission uses this cap to avoid unbounded line lengths.
 */
export function boundedError(err: unknown, cap = STRUCTURED_ERROR_CAP): { error: string } {
  const raw = safeErrorString(err);
  if (raw.length <= cap) return { error: raw };
  if (cap <= 3) return { error: raw.slice(0, cap) };
  return { error: `${raw.slice(0, cap - 3)}...` };
}
