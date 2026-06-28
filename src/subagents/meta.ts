/**
 * On-disk persistence for subagent metadata.
 *
 * `meta.json` is the durable record of a subagent's lifecycle: where its
 * pi session lives, who spawned it, what state it ended in. Every transition
 * is committed via `writeMetaAtomic` (tmp + rename) so a crash mid-write
 * never leaves a partial file behind.
 *
 * `loadSubagentMeta` is the reverse lookup: given an id, find the meta.json
 * by scanning both the generic tree and every named-agent instance tree.
 *
 * `findSessionFile` resolves pi's `<ISO-timestamp>.jsonl` naming convention
 * to a concrete path — see the note above the function.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../fs.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentsRoot,
} from "./paths.ts";
import type { SubagentInstance, SubagentMeta } from "./types.ts";

/**
 * Write JSON to disk atomically (tmp + fsync + rename) so a crash mid-write
 * doesn't leave a partial meta.json behind. See `src/fs.ts` for details.
 */
export function writeMetaAtomic(path: string, meta: SubagentMeta): void {
  atomicWrite(path, JSON.stringify(meta, null, 2));
}

/**
 * Read the existing `meta.json`, merge `patch`, and atomically replace.
 * Best-effort: if the read fails, we fall back to a synthetic meta from
 * the in-memory instance state so we never lose the lifecycle write.
 *
 * Keys set to `undefined` in `patch` are dropped from the merged record
 * (used to clear stale fields like `errorMessage` on revival).
 */
export function persistMetaPatch(instance: SubagentInstance, patch: Partial<SubagentMeta>): void {
  let current: SubagentMeta;
  try {
    current = JSON.parse(readFileSync(instance.metaPath, "utf-8")) as SubagentMeta;
  } catch {
    current = {
      id: instance.id,
      role: instance.role,
      name: instance.name,
      spawnedBy: instance.spawnedBy,
      activeScope: instance.activeScope,
      depth: instance.depth,
      createdAt: instance.spawnedAt,
      status: instance.status,
    };
  }
  const merged = { ...current, ...patch };
  for (const key of Object.keys(merged) as (keyof SubagentMeta)[]) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  writeMetaAtomic(instance.metaPath, merged);
}

/**
 * Locate and parse a subagent's `meta.json` by id.
 *
 * Searches both the generic tree (`~/goblin/subagents/<id>/meta.json`)
 * and all named-agent instance trees (`~/goblin/agents/<name>/instances/<id>/meta.json`).
 *
 * Throws "Subagent not found" if no matching meta.json exists.
 */
export function loadSubagentMeta(home: string, id: string): { dir: string; meta: SubagentMeta } {
  const tryParse = (metaPath: string, dir: string): { dir: string; meta: SubagentMeta } | null => {
    try {
      return { dir, meta: JSON.parse(readFileSync(metaPath, "utf-8")) as SubagentMeta };
    } catch {
      // File missing or corrupted — treat as not found.
      return null;
    }
  };

  // Try generic first — most common case.
  const genericResult = tryParse(genericSubagentMetaPath(home, id), genericSubagentDir(home, id));
  if (genericResult !== null) return genericResult;

  // Scan named agents' instances.
  const agentsRoot = namedAgentsRoot(home);
  if (existsSync(agentsRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(agentsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const namedResult = tryParse(
        namedAgentInstanceMetaPath(home, name, id),
        namedAgentInstanceDir(home, name, id),
      );
      if (namedResult !== null) return namedResult;
    }
  }

  throw new Error("Subagent not found");
}

/**
 * Find the most recent `.jsonl` session file inside a directory.
 * Returns `null` if none found.
 *
 * NOTE: assumes pi's SessionManager names session files as
 * `<ISO-timestamp>.jsonl` (e.g. `2026-04-26T12-00-00.jsonl`). This is an
 * internal pi implementation detail, not a public API. If pi changes the
 * naming convention, this function must be updated. Prefer querying
 * SessionManager for the active session path once pi exposes such an API.
 */
export function findSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      // Most recent file first (timestamp prefix sorts lexicographically).
      .reverse();
    return files.length > 0 ? join(dir, files[0] as string) : null;
  } catch {
    return null;
  }
}
