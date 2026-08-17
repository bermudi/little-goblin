#!/usr/bin/env bun
/**
 * Offline state migration command.
 *
 * Run with the goblin service stopped:
 *   bun run migrate
 *
 * Reads `state/state-version.json`, plans every pending migration step against
 * the projected output of earlier steps, snapshots every root each step will
 * mutate (including path absence), applies the steps in version order, and
 * advances the version only after each step succeeds. Startup refuses to poll
 * until the state version matches `CURRENT_STATE_VERSION`.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { log, initLog } from "./log.ts";
import { CURRENT_STATE_VERSION, readStateVersion, writeStateVersion } from "./state-version.ts";
import { planSurfaceMigration, applySurfaceMigration, type SurfaceMigrationPlan } from "./sessions/surface-migration.ts";
import {
  planExecutionEnvironments,
  applyExecutionEnvironments,
  type ExecutionEnvironmentPlan,
} from "./sessions/environment-migration.ts";
import {
  planTranscriptProvenanceMigration,
  applyTranscriptProvenanceMigration,
  type TranscriptProvenanceMigrationPlan,
} from "./sessions/transcript-provenance-migration.ts";
import {
  planConversationMigration,
  applyConversationMigration,
  type ConversationMigrationPlan,
} from "./sessions/conversation-migration.ts";
import {
  planDelegatedWorkLayout,
  applyDelegatedWorkLayout,
  type DelegatedWorkLayoutPlan,
} from "./delegated-work/layout-migration.ts";

interface SnapshotManifest {
  roots: Array<{ path: string; exists: boolean }>;
}

interface SurfaceMigrationStep {
  readonly version: number;
  readonly roots: string[];
  plan(home: string): SurfaceMigrationPlan;
  apply(home: string, plan: SurfaceMigrationPlan): void;
}

interface EnvironmentMigrationStep {
  readonly version: number;
  readonly roots: string[];
  plan(
    home: string,
    bindings?: SurfaceMigrationPlan["bindings"],
    settings?: SurfaceMigrationPlan["settings"],
  ): ExecutionEnvironmentPlan;
  apply(home: string, plan: ExecutionEnvironmentPlan): void;
}

interface TranscriptMigrationStep {
  readonly version: number;
  readonly roots: string[];
  plan(home: string): TranscriptProvenanceMigrationPlan;
  apply(home: string, plan: TranscriptProvenanceMigrationPlan): void;
}

interface ConversationMigrationStep {
  readonly version: number;
  readonly roots: string[];
  plan(
    home: string,
    bindings?: SurfaceMigrationPlan["bindings"],
    settings?: SurfaceMigrationPlan["settings"],
    environments?: ExecutionEnvironmentPlan,
    schedules?: SurfaceMigrationPlan["schedules"],
  ): ConversationMigrationPlan;
  apply(home: string, plan: ConversationMigrationPlan): void;
}

interface DelegatedWorkLayoutStep {
  readonly version: number;
  readonly roots: string[];
  plan(home: string): DelegatedWorkLayoutPlan;
  apply(home: string, plan: DelegatedWorkLayoutPlan): void;
}

const STEP_1_ROOTS = ["state"];
const STEP_2_ROOTS = ["state", "workspace", "scratch/workdir"];
const STEP_3_ROOTS = ["state/sessions"];
const STEP_4_ROOTS = ["state"];

/**
 * Step 5 is a layout break, not a data transformation. Delegated-run records
 * now live under `state/delegated-work/runs/<id>/` and the legacy
 * `scratch/subagents` and `workspace/agents/.../instances` trees are no longer
 * read or written. No legacy data is migrated; the operator deletes the old
 * trees manually. The version advance gates the cutover so the new code never
 * polls against a pre-break home.
 */
const STEP_5_ROOTS = ["state"];

function backupDirPath(home: string): string {
  return join(home, `.migration-backup-${Date.now()}`);
}

function snapshotRoot(sourceRoot: string, backupRoot: string): void {
  if (existsSync(sourceRoot)) {
    mkdirSync(dirname(backupRoot), { recursive: true });
    cpSync(sourceRoot, backupRoot, { recursive: true });
  }
}

/**
 * Snapshot every persisted root declared by the pending steps, recording prior
 * contents and path absence. No source root is created by this call; an absent
 * root is recorded in the manifest and left out of the backup tree.
 */
function snapshotRoots(home: string, roots: string[]): string {
  const backupDir = backupDirPath(home);
  mkdirSync(backupDir, { recursive: true });

  const manifest: SnapshotManifest = { roots: [] };
  for (const root of roots) {
    const sourcePath = join(home, root);
    const exists = existsSync(sourcePath);
    manifest.roots.push({ path: root, exists });
    if (exists) {
      snapshotRoot(sourcePath, join(backupDir, root));
    }
  }

  writeFileSync(join(backupDir, "snapshot.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return backupDir;
}

const SURFACE_STEP: SurfaceMigrationStep = {
  version: 1,
  roots: STEP_1_ROOTS,
  plan: planSurfaceMigration,
  apply: applySurfaceMigration,
};

const ENVIRONMENT_STEP: EnvironmentMigrationStep = {
  version: 2,
  roots: STEP_2_ROOTS,
  plan: (home: string, bindings?, settings?) =>
    planExecutionEnvironments(home, bindings, settings),
  apply: applyExecutionEnvironments,
};

const TRANSCRIPT_STEP: TranscriptMigrationStep = {
  version: 3,
  roots: STEP_3_ROOTS,
  plan: planTranscriptProvenanceMigration,
  apply: applyTranscriptProvenanceMigration,
};

const CONVERSATION_STEP: ConversationMigrationStep = {
  version: 4,
  roots: STEP_4_ROOTS,
  plan: (home, bindings, settings, environments, schedules) =>
    planConversationMigration(
      home,
      bindings,
      environments?.topicSettings ?? settings,
      environments,
      schedules ?? undefined,
    ),
  apply: applyConversationMigration,
};

const DELEGATED_WORK_STEP: DelegatedWorkLayoutStep = {
  version: 5,
  roots: STEP_5_ROOTS,
  plan: planDelegatedWorkLayout,
  apply: applyDelegatedWorkLayout,
};

/**
 * Run every pending migration step for the given goblin home.
 * Exported for tests and for the CLI entry point below.
 */
export function runMigrations(home: string): void {
  const current = readStateVersion(home);
  if (current === CURRENT_STATE_VERSION) {
    log.info("state is already at the required version", { current, required: CURRENT_STATE_VERSION });
    return;
  }

  // Preflight: plan only pending steps. Earlier steps' plan functions read
  // the filesystem shape they expect to transform, which is incompatible with
  // data already transformed by later steps. Since migration is sequential,
  // a step is pending only when current < step.version. When a pending step
  // depends on an already-applied step's projected output, pass undefined so
  // the plan function loads canonical inputs from disk (the dependency
  // already wrote its output to the filesystem).
  const step1Plan = current < 1 ? SURFACE_STEP.plan(home) : null;
  const step2Plan = current < 2
    ? ENVIRONMENT_STEP.plan(home, step1Plan?.bindings, step1Plan?.settings)
    : null;
  const step3Plan = current < 3 ? TRANSCRIPT_STEP.plan(home) : null;
  const step4Plan = current < 4
    ? CONVERSATION_STEP.plan(
        home,
        step1Plan?.bindings,
        step1Plan?.settings,
        step2Plan ?? undefined,
        step1Plan?.schedules,
      )
    : null;
  const step5Plan = current < 5 ? DELEGATED_WORK_STEP.plan(home) : null;

  const rootsToSnapshot = new Set<string>();
  if (current < 1) {
    for (const root of SURFACE_STEP.roots) rootsToSnapshot.add(root);
  }
  if (current < 2) {
    for (const root of ENVIRONMENT_STEP.roots) rootsToSnapshot.add(root);
  }
  if (current < 3) {
    for (const root of TRANSCRIPT_STEP.roots) rootsToSnapshot.add(root);
  }
  if (current < 4) {
    for (const root of CONVERSATION_STEP.roots) rootsToSnapshot.add(root);
  }
  if (current < 5) {
    for (const root of DELEGATED_WORK_STEP.roots) rootsToSnapshot.add(root);
  }

  log.info("starting offline migration", { from: current, to: CURRENT_STATE_VERSION });
  const backupDir = snapshotRoots(home, Array.from(rootsToSnapshot));
  log.info("migration backup created", { backupDir });

  if (current < 1) {
    log.info("running migration step", { step: 1 });
    SURFACE_STEP.apply(home, step1Plan!);
    writeStateVersion(home, 1);
  }
  if (current < 2) {
    log.info("running migration step", { step: 2 });
    ENVIRONMENT_STEP.apply(home, step2Plan!);
    writeStateVersion(home, 2);
  }
  if (current < 3) {
    log.info("running migration step", { step: 3 });
    TRANSCRIPT_STEP.apply(home, step3Plan!);
    writeStateVersion(home, 3);
  }
  if (current < 4) {
    log.info("running migration step", { step: 4 });
    CONVERSATION_STEP.apply(home, step4Plan!);
    writeStateVersion(home, 4);
  }
  if (current < 5) {
    log.info("running migration step", { step: 5 });
    DELEGATED_WORK_STEP.apply(home, step5Plan!);
    writeStateVersion(home, 5);
  }

  log.info("migration complete", { version: CURRENT_STATE_VERSION });
}

function main(): void {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
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
