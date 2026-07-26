#!/usr/bin/env bun
/**
 * Offline state migration command.
 *
 * Run with the goblin service stopped:
 *   bun run migrate
 *
 * Reads `state/state-version.json`, takes a backup of `state/`, applies every
 * pending migration step, and writes the new version. Startup refuses to poll
 * until the state version matches `CURRENT_STATE_VERSION`.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ensureGoblinHome } from "./config.ts";
import { log, initLog } from "./log.ts";
import { CURRENT_STATE_VERSION, readStateVersion, writeStateVersion } from "./state-version.ts";
import { migrateSurfaceState } from "./sessions/surface-migration.ts";
import { migrateExecutionEnvironments } from "./sessions/environment-migration.ts";

const STEPS: Array<(home: string) => void> = [
  (home) => migrateSurfaceState(home),
  (home) => migrateExecutionEnvironments(home),
];

function backupState(home: string): string {
  const stateDir = join(home, "state");
  const backupDir = join(home, `.migration-backup-${Date.now()}`);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  cpSync(stateDir, backupDir, {
    recursive: true,
    filter: (src) => !src.includes(".migration-backup"),
  });
  return backupDir;
}

/**
 * Run every pending migration step for the given goblin home.
 * Exported for tests and for the CLI entry point below.
 */
export function runMigrations(home: string): void {
  const current = readStateVersion(home);
  if (current >= CURRENT_STATE_VERSION) {
    log.info("state is already at the required version", { current, required: CURRENT_STATE_VERSION });
    return;
  }

  log.info("starting offline migration", { from: current, to: CURRENT_STATE_VERSION });
  const backupDir = backupState(home);
  log.info("state backup created", { backupDir });

  for (let i = current; i < STEPS.length; i += 1) {
    const stepNumber = i + 1;
    log.info("running migration step", { step: stepNumber });
    STEPS[i]!(home);
    writeStateVersion(home, stepNumber);
  }

  log.info("migration complete", { version: CURRENT_STATE_VERSION });
}

function main(): void {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  runMigrations(cfg.goblinHome);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    log.error("migration failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
