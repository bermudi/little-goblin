#!/usr/bin/env bun

/**
 * Doctor CLI: read-only local system health checks for little-goblin.
 *
 * Usage:
 *   bun run doctor
 *   bun run src/doctor.ts
 */

import { readdirSync, statSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { resolveModel } from "./agent/models.ts";
import { ConversationStore } from "./sessions/conversation-store.ts";
import { isValidConversationId } from "./sessions/conversation.ts";
import { sessionsDir } from "./sessions/paths.ts";
import { memoryDbPath } from "./memory/paths.ts";
import { MemoryBudget } from "./memory/budget.ts";
import { agentsMdPath, soulMdPath } from "./workspace/paths.ts";
import { CURRENT_STATE_VERSION, readStateVersion } from "./state-version.ts";
import { log } from "./log.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function goblinHome(): string {
  return process.env.GOBLIN_HOME ?? join(homedir(), ".goblin");
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "[unstringifiable error]";
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function checkStateVersion(home: string): Promise<Check> {
  try {
    const version = readStateVersion(home);
    if (version === CURRENT_STATE_VERSION) {
      return {
        name: "state version",
        ok: true,
        detail: `state version ${version} matches expected ${CURRENT_STATE_VERSION}`,
      };
    }
    return {
      name: "state version",
      ok: false,
      detail: `state version mismatch: file has ${version}, expected ${CURRENT_STATE_VERSION}`,
    };
  } catch (err) {
    return {
      name: "state version",
      ok: false,
      detail: `cannot read state version: ${errorMessage(err)}`,
    };
  }
}

async function checkGoblinHomeDirs(home: string): Promise<Check> {
  const required = ["workspace", "state", "state/memory", "state/sessions", "scratch"];
  const missing: string[] = [];

  try {
    if (!statSync(home).isDirectory()) {
      return { name: "GOBLIN_HOME", ok: false, detail: `not a directory: ${home}` };
    }
  } catch (err) {
    return {
      name: "GOBLIN_HOME",
      ok: false,
      detail: isNodeErrnoException(err) && err.code === "ENOENT"
        ? `missing: ${home}`
        : `cannot stat GOBLIN_HOME: ${errorMessage(err)}`,
    };
  }

  for (const sub of required) {
    const path = join(home, sub);
    try {
      if (!statSync(path).isDirectory()) {
        missing.push(`${sub} is not a directory`);
      }
    } catch (err) {
      missing.push(`${sub} is missing`);
    }
  }

  if (missing.length === 0) {
    return {
      name: "GOBLIN_HOME",
      ok: true,
      detail: `home exists at ${home}; subdirs: ${required.join(", ")}`,
    };
  }
  return { name: "GOBLIN_HOME", ok: false, detail: missing.join("; ") };
}

async function checkMemory(home: string): Promise<Check> {
  const dbPath = memoryDbPath(home);
  let db: Database | undefined;

  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      name: "memory",
      ok: false,
      detail: `cannot open memory DB at ${dbPath}: ${errorMessage(err)}`,
    };
  }

  try {
    const countRow = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_entries").get();
    const entryCount = countRow?.count ?? 0;

    const usageRow = db
      .query<{ total: number }, []>(
        "SELECT COALESCE(SUM(LENGTH(text)), 0) AS total FROM memory_entries WHERE entry_kind IN ('memory', 'user') AND scope NOT LIKE 'archive/%'",
      )
      .get();
    const current = usageRow?.total ?? 0;
    const budget = new MemoryBudget().budgetChars;

    const modelMeta = db.query<{ value: string }, []>("SELECT value FROM memory_meta WHERE key = 'embedding_model'").get();
    const providerMeta = db.query<{ value: string }, []>("SELECT value FROM memory_meta WHERE key = 'embedding_provider'").get();
    const reindexingMeta = db.query<{ value: string }, []>("SELECT value FROM memory_meta WHERE key = 'reindexing'").get();

    const model = modelMeta?.value ?? process.env.GOBLIN_MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small";
    const provider = providerMeta?.value ?? process.env.GOBLIN_MEMORY_EMBEDDING_PROVIDER ?? "openai";
    const reindexing = reindexingMeta?.value === "true";
    const degraded = reindexing;

    const syncMeta = db.query<{ value: string }, []>("SELECT value FROM memory_meta WHERE key = 'last_transcript_sync'").get();
    const lastSync = syncMeta?.value
      ? new Date(Number.parseInt(syncMeta.value, 10)).toISOString()
      : "never";

    const size = (() => {
      try {
        return statSync(dbPath).size;
      } catch {
        return 0;
      }
    })();

    return {
      name: "memory",
      ok: true,
      detail: `${entryCount} entries, budget ${current} / ${budget} chars, embedding ${model} (${provider}) ${degraded ? "degraded" : "ok"}, last sync ${lastSync}, db ${formatBytes(size)}`,
    };
  } catch (err) {
    return {
      name: "memory",
      ok: false,
      detail: `failed to query memory DB: ${errorMessage(err)}`,
    };
  } finally {
    db.close();
  }
}

async function checkConversations(home: string): Promise<Check> {
  try {
    const store = new ConversationStore(home);
    const active = store.list().length;

    const archiveDir = join(sessionsDir(home), "archive");
    let archived = 0;
    try {
      for (const id of readdirSync(archiveDir)) {
        if (!isValidConversationId(id)) continue;
        const stateFile = join(archiveDir, id, "state.json");
        try {
          if (statSync(stateFile).isFile()) archived++;
        } catch {
          // skip archived entries with no state file
        }
      }
    } catch (err) {
      if (!isNodeErrnoException(err) || err.code !== "ENOENT") {
        return {
          name: "conversations",
          ok: false,
          detail: `cannot read archived conversations: ${errorMessage(err)}`,
        };
      }
    }

    return {
      name: "conversations",
      ok: true,
      detail: `${active} active, ${archived} archived`,
    };
  } catch (err) {
    return {
      name: "conversations",
      ok: false,
      detail: `cannot list conversations: ${errorMessage(err)}`,
    };
  }
}

async function checkConfig(): Promise<Check> {
  try {
    const cfg = loadConfig();
    const resolved = resolveModel(cfg);
    return {
      name: "config",
      ok: true,
      detail: `loaded ${join(cfg.goblinHome, "goblin.json5")}; default model ${cfg.modelName} resolves to ${resolved.model.id} (${resolved.model.provider})`,
    };
  } catch (err) {
    return {
      name: "config",
      ok: false,
      detail: `config reload failed: ${errorMessage(err)}`,
    };
  }
}

async function checkFavorites(): Promise<Check> {
  try {
    const cfg = loadConfig();
    const favorites = cfg.favorites ?? [];
    if (favorites.length === 0) {
      return { name: "favorites", ok: true, detail: "0 favorites configured" };
    }

    const failures: string[] = [];
    for (const modelName of favorites) {
      try {
        resolveModel({ ...cfg, modelName });
      } catch (err) {
        failures.push(`${modelName}: ${errorMessage(err)}`);
      }
    }

    if (failures.length === 0) {
      return { name: "favorites", ok: true, detail: `${favorites.length} favorites resolve` };
    }
    return { name: "favorites", ok: false, detail: failures.join("; ") };
  } catch (err) {
    return {
      name: "favorites",
      ok: false,
      detail: `cannot load favorites: ${errorMessage(err)}`,
    };
  }
}

async function checkPromptFiles(home: string): Promise<Check> {
  const soulPath = soulMdPath(home);
  const agentsPath = agentsMdPath(home);
  const missing: string[] = [];

  for (const [label, path] of [
    ["SOUL.md", soulPath] as const,
    ["AGENTS.md", agentsPath] as const,
  ]) {
    try {
      if (!statSync(path).isFile()) {
        missing.push(`${label} not a file`);
      }
    } catch {
      missing.push(`${label} missing`);
    }
  }

  if (missing.length === 0) {
    return {
      name: "prompt files",
      ok: true,
      detail: `SOUL.md and AGENTS.md present`,
    };
  }
  return { name: "prompt files", ok: false, detail: missing.join("; ") };
}

async function checkDisk(home: string): Promise<Check> {
  try {
    const stats = statfsSync(home);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return {
      name: "disk",
      ok: true,
      detail: `${formatBytes(free)} free / ${formatBytes(total)} total on ${home}`,
    };
  } catch (err) {
    return {
      name: "disk",
      ok: false,
      detail: `cannot statfs GOBLIN_HOME volume: ${errorMessage(err)}`,
    };
  }
}

async function runChecks(home: string): Promise<Check[]> {
  return Promise.all([
    checkStateVersion(home),
    checkGoblinHomeDirs(home),
    checkMemory(home),
    checkConversations(home),
    checkConfig(),
    checkFavorites(),
    checkPromptFiles(home),
    checkDisk(home),
  ]);
}

export async function main(): Promise<void> {
  const home = goblinHome();
  const checks = await runChecks(home);

  for (const check of checks) {
    out(`${check.name}: ${check.ok ? "pass" : "fail"} (${check.detail})`);
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  out(`${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("doctor failed:", { error: errorMessage(err) });
    out(`unexpected error: ${errorMessage(err)}`);
    process.exit(1);
  });
}
