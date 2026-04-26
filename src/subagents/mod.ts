/**
 * Subagent runtime.
 *
 * `SubagentRunner` owns the lifecycle of subagent instances spawned by goblin
 * (or by another subagent). Phase 1 lands the skeleton: state shape, public
 * API surface, and stubbed methods. Real spawning, revival, and execution
 * arrive in subsequent phases.
 *
 * See specs/changes/subagent-runtime/ for the full design and tasks.
 */

import type { Config } from "../config.ts";
import type {
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
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
   * Spawn a new subagent. Implemented in phase 2 (generic) and phase 3 (named).
   */
  // biome-ignore lint/correctness/noUnusedVariables: skeleton stub, filled in phase 2
  async spawn(_options: SpawnOptions): Promise<SubagentHandle> {
    void this.cfg;
    throw new Error("SubagentRunner.spawn() not implemented yet (phase 2)");
  }

  /**
   * Resume a persisted subagent and send it a follow-up prompt.
   * Implemented in phase 5.
   */
  async revive(_id: string, _prompt: string): Promise<string> {
    throw new Error("SubagentRunner.revive() not implemented yet (phase 5)");
  }

  /**
   * Snapshot of all known subagent instances. Implemented in phase 6.
   * Phase 1 returns whatever happens to be in the map (currently always empty).
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

export type { SpawnOptions, SubagentHandle, SubagentInfo, SubagentInstance } from "./types.ts";
