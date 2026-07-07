import { readFileSync } from "node:fs";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";

/**
 * Load a JSON state file. Returns `defaultValue` when the file is missing
 * (ENOENT, expected — not yet created) or malformed (SyntaxError, logged and
 * recovered). Any other error propagates per the fail-loud rule.
 *
 * Each caller supplies its own default and type; this module hardcodes
 * neither. Wraps `atomicWrite` on the write side via {@link saveJsonFile}.
 */
export function loadJsonFile<T>(path: string, defaultValue: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultValue;
    }
    throw e;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    if (e instanceof SyntaxError) {
      log.warn("malformed JSON state file, returning default", { path, error: String(e) });
      return defaultValue;
    }
    throw e;
  }
}

/**
 * Save a JSON state file atomically (tmp + fsync + rename). Serializes as
 * `JSON.stringify(value, null, 2) + "\n"`, matching the format every caller
 * already used.
 */
export function saveJsonFile(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}
