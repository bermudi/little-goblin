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
