/**
 * Subagent runtime.
 *
 * `SubagentRunner` owns the lifecycle of subagent instances spawned by goblin
 * (or by another subagent). Phase 2 lands generic spawning: artifacts on disk,
 * persisted pi session, depth cap. Real LLM execution arrives in phase 4.
 *
 * See specs/changes/subagent-runtime/ for the full design and tasks.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.ts";
import { workdirPath } from "../agent/paths.ts";
import { log } from "../log.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentSkillsDir,
} from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type NamedAgentDefinition,
  type SpawnOptions,
  type SubagentHandle,
  type SubagentInfo,
  type SubagentInstance,
  type SubagentMeta,
  type SubagentRole,
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
   * Generic (no `name`): creates `~/goblin/subagents/<id>/`, persisted pi
   * session, tracks the instance. Skills are inherited from goblin in phase 4.
   *
   * Named (`name` provided): loads `~/goblin/agents/<name>/AGENTS.md` (must
   * exist), creates `~/goblin/agents/<name>/instances/<id>/` for persistence,
   * carries a `NamedAgentDefinition` on the instance so phase 4 can override
   * the system prompt and resource loader for strict skill isolation.
   */
  async spawn(options: SpawnOptions): Promise<SubagentHandle> {
    const spawnerDepth = options.depth ?? 0;
    const newDepth = spawnerDepth + 1;
    if (newDepth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Maximum subagent depth reached (${MAX_SUBAGENT_DEPTH})`);
    }

    const id = randomUUID();
    const spawnedAt = new Date().toISOString();
    const spawnedBy = options.spawnedBy ?? null;

    let role: SubagentRole;
    let dir: string;
    let metaPath: string;
    let definition: NamedAgentDefinition | null;
    let displayName: string | null;

    if (options.name !== undefined) {
      role = "named";
      definition = loadNamedAgent(this.cfg.goblinHome, options.name);
      displayName = options.name;
      dir = namedAgentInstanceDir(this.cfg.goblinHome, options.name, id);
      metaPath = namedAgentInstanceMetaPath(this.cfg.goblinHome, options.name, id);
    } else {
      role = "generic";
      definition = null;
      displayName = null;
      dir = genericSubagentDir(this.cfg.goblinHome, id);
      metaPath = genericSubagentMetaPath(this.cfg.goblinHome, id);
    }

    // Create the instance directory up-front so meta.json + pi's session
    // file land side-by-side.
    mkdirSync(dir, { recursive: true });

    const meta: SubagentMeta = {
      id,
      role,
      name: displayName,
      spawnedBy,
      depth: newDepth,
      createdAt: spawnedAt,
      status: "running",
    };
    writeMetaAtomic(metaPath, meta);

    // Persisted session lives in the subagent's own directory.
    // cwd: generic → goblin's workdir (inherits goblin's project context);
    //      named   → the named agent's root dir (so pi's resource loader, if
    //                used as-is later, would scope discovery to the agent's
    //                own tree). Phase 4 will likely override the loader for
    //                strict isolation, but the cwd choice here is the right
    //                default.
    const cwd =
      role === "named"
        ? namedAgentDir(this.cfg.goblinHome, options.name as string)
        : workdirPath(this.cfg.goblinHome);
    const sessionManager = SessionManager.create(cwd, dir);

    const instance: SubagentInstance = {
      id,
      name: displayName,
      role,
      status: "running",
      depth: newDepth,
      spawnedAt,
      spawnedBy,
      dir,
      sessionManager,
      initialPrompt: options.prompt,
      onStatusUpdate: options.onStatusUpdate,
      definition,
    };
    this.activeSubagents.set(id, instance);

    log.debug("subagent spawned", {
      id,
      role,
      name: displayName,
      depth: newDepth,
      spawnedBy,
    });

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
 * Load a named agent definition from `~/goblin/agents/<name>/`.
 *
 * `AGENTS.md` is required. The `skills/` directory is optional — its path
 * is recorded so phase 4 can pin pi's resource loader to it for strict
 * isolation, regardless of whether the agent has any skills yet.
 */
function loadNamedAgent(home: string, name: string): NamedAgentDefinition {
  const agentsMdPath = namedAgentAgentsMdPath(home, name);
  let agentsMd: string;
  try {
    agentsMd = readFileSync(agentsMdPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Named agent '${name}' not found`);
    }
    throw err;
  }
  return {
    name,
    dir: namedAgentDir(home, name),
    agentsMd,
    skillsDir: namedAgentSkillsDir(home, name),
  };
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
  NamedAgentDefinition,
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
} from "./types.ts";
