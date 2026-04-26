/**
 * Subagent runtime.
 *
 * `SubagentRunner` owns the lifecycle of subagent instances spawned by goblin
 * (or by another subagent). Phase 2 lands generic spawning: artifacts on disk,
 * persisted pi session, depth cap. Real LLM execution arrives in phase 4.
 *
 * See specs/changes/subagent-runtime/ for the full design and tasks.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.ts";
import { workdirPath } from "../agent/paths.ts";
import { log } from "../log.ts";
import { genericSubagentDir, genericSubagentMetaPath } from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type SpawnOptions,
  type SubagentHandle,
  type SubagentInfo,
  type SubagentInstance,
  type SubagentMeta,
} from "./types.ts";

/**
 * Manages all subagents spawned within a goblin process.
 *
 * Holds a map of active subagents keyed by id and exposes spawn/revive/list/
 * cancel as the public surface used by the `spawn_subagent` tool and by the
 * bot wiring.
 */
export class SubagentRunner {
  private readonly cfg: Config;
  private readonly activeSubagents: Map<string, SubagentInstance> = new Map();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Spawn a new subagent.
   *
   * Phase 2: generic only. Creates `~/goblin/subagents/<id>/` with `meta.json`,
   * provisions a persisted pi `SessionManager`, and tracks the instance.
   * Phase 3 adds named subagents; phase 4 adds actual LLM execution.
   */
  async spawn(options: SpawnOptions): Promise<SubagentHandle> {
    if (options.name !== undefined) {
      throw new Error(
        "Named subagents not implemented yet (phase 3); pass only { prompt } for now",
      );
    }

    const spawnerDepth = options.depth ?? 0;
    const newDepth = spawnerDepth + 1;
    if (newDepth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Maximum subagent depth reached (${MAX_SUBAGENT_DEPTH})`);
    }

    const id = randomUUID();
    const spawnedAt = new Date().toISOString();
    const spawnedBy = options.spawnedBy ?? null;
    const dir = genericSubagentDir(this.cfg.goblinHome, id);

    // Create the subagent's directory up-front so meta.json + pi's session
    // file land side-by-side.
    mkdirSync(dir, { recursive: true });

    const meta: SubagentMeta = {
      id,
      role: "generic",
      name: null,
      spawnedBy,
      depth: newDepth,
      createdAt: spawnedAt,
      status: "running",
    };
    writeMetaAtomic(genericSubagentMetaPath(this.cfg.goblinHome, id), meta);

    // Persisted session lives in the subagent's own directory. cwd points at
    // goblin's workdir so generic subagents inherit goblin's project context
    // (skill discovery happens through pi's resource loader in phase 4).
    const sessionManager = SessionManager.create(workdirPath(this.cfg.goblinHome), dir);

    const instance: SubagentInstance = {
      id,
      name: null,
      role: "generic",
      status: "running",
      depth: newDepth,
      spawnedAt,
      spawnedBy,
      dir,
      sessionManager,
      initialPrompt: options.prompt,
      onStatusUpdate: options.onStatusUpdate,
    };
    this.activeSubagents.set(id, instance);

    log.debug("subagent spawned", { id, depth: newDepth, spawnedBy });

    return { id, status: "running" };
  }

  /**
   * Resume a persisted subagent and send it a follow-up prompt.
   * Implemented in phase 5.
   */
  async revive(_id: string, _prompt: string): Promise<string> {
    throw new Error("SubagentRunner.revive() not implemented yet (phase 5)");
  }

  /**
   * Snapshot of all known subagent instances.
   */
  list(): SubagentInfo[] {
    const out: SubagentInfo[] = [];
    for (const inst of this.activeSubagents.values()) {
      out.push({
        id: inst.id,
        name: inst.name,
        role: inst.role,
        status: inst.status,
        spawnedAt: inst.spawnedAt,
      });
    }
    return out;
  }

  /**
   * Cancel an active subagent. Implemented in phase 6.
   */
  async cancel(_id: string): Promise<void> {
    throw new Error("SubagentRunner.cancel() not implemented yet (phase 6)");
  }
}

/**
 * Write JSON to disk via tmp + rename so a crash mid-write doesn't leave
 * a partial meta.json behind.
 */
function writeMetaAtomic(path: string, meta: SubagentMeta): void {
  // tmp file lives in the same directory as the target so the rename is
  // atomic on the same filesystem.
  const tmp = `${dirname(path)}/.meta.${meta.id}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, path);
}

export type {
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
} from "./types.ts";
