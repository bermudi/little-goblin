import { readFileSync } from "node:fs";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";

/**
 * Load a JSON authority file. `ENOENT` is the sole absence case and returns
 * the caller-supplied default. Invalid JSON is persisted-state corruption, not
 * an empty record: log its path and fail before a later write can erase it.
 *
 * Each caller validates its own schema after parsing. This module owns only
 * the filesystem and JSON boundary; {@link saveJsonFile} wraps `atomicWrite`
 * on the write side.
 */
export function loadJsonFile<T>(path: string, defaultValue: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultValue;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.error("malformed JSON authority file", { path, error: error.message });
    }
    throw error;
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
