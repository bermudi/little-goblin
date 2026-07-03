/**
 * Quarantine store for rejected memory candidates.
 *
 * Appends redacted JSONL records to `$GOBLIN_HOME/memory/quarantine.jsonl`.
 * Quarantine is audit-only: its contents MUST NOT appear in per-turn
 * snapshots, `memory_read`, or `memory_read_index`. It exists for debugging
 * and future review, not for model context.
 *
 * Records contain: timestamp, source session, target scope tag, category,
 * reason, and a redacted candidate preview. The preview never copies the
 * sensitive value — it is produced by `redactPreview()` from safety.ts.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { memoryDir } from "./paths.ts";
import { redactPreview } from "./safety.ts";
import type { EntryCategory } from "./entry.ts";

export type QuarantineReason =
  | "unsafe"
  | "low_confidence"
  | "procedural_noise"
  | "review";

export interface QuarantineRecord {
  /** ISO timestamp of the rejection. */
  timestamp: string;
  /** Session that produced the rejected candidate. */
  sourceSession: string;
  /** Resolved target scope tag (e.g. `user`, `general`, `topics/-100/42`). */
  targetScope: string;
  /** Candidate category, if known. */
  category: EntryCategory | null;
  /** Rejection reason. */
  reason: QuarantineReason;
  /** Redacted preview of the rejected candidate content. */
  preview: string;
}

export interface AppendQuarantineArgs {
  goblinHome: string;
  sourceSession: string;
  targetScope: string;
  category: EntryCategory | null;
  reason: QuarantineReason;
  /** Raw rejected candidate content; redacted before persistence. */
  content: string;
  /** Override the record timestamp (defaults to now). */
  timestamp?: string;
}

/**
 * Append a redacted quarantine record to `memory/quarantine.jsonl`.
 *
 * The raw content is never persisted — `redactPreview()` produces a
 * structural preview with sensitive runs replaced by `[redacted:N]`.
 */
export function appendQuarantine(args: AppendQuarantineArgs): QuarantineRecord {
  const record: QuarantineRecord = {
    timestamp: args.timestamp ?? new Date().toISOString(),
    sourceSession: args.sourceSession,
    targetScope: args.targetScope,
    category: args.category,
    reason: args.reason,
    preview: redactPreview(args.content),
  };
  const path = quarantinePath(args.goblinHome);
  const line = JSON.stringify(record) + "\n";
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return record;
}

/**
 * Path to the quarantine JSONL file under `$GOBLIN_HOME/memory/`.
 */
export function quarantinePath(goblinHome: string): string {
  return join(memoryDir(goblinHome), "quarantine.jsonl");
}
