/**
 * Offline migration of legacy session execution environments to canonical
 * ExecutionEnvironment values.
 *
 * This runs after surface migration. It:
 *  - promotes legacy `scratch/workdir` personal contents to `workspace`
 *  - canonicalizes legacy `projectDir` topic settings to `projectRoot`
 *  - infers an immutable execution environment for every session without one
 *  - validates and normalizes pi JSONL history headers against the selected env
 *
 * The migration is two-phase: every transformation is computed and validated
 * before the first state or history write. Any ambiguity fails loudly and
 * aborts the whole run.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { workdirPath, workspacePath } from "../workspace/paths.ts";
import { readPiSessionHeader } from "../pi-host.ts";
import { loadBindings } from "./bindings.ts";
import { loadTopicSettings, saveTopicSettings } from "./topic-settings.ts";
import { loadLegacyState } from "./state.ts";
import { saveJsonFile } from "./state-file.ts";
import { sessionsDir, piSessionDir, sessionDir } from "./paths.ts";
import { surfaceId, parseSurfaceId, type Surface, type SurfaceId } from "../surface.ts";
import {
  environmentCwd,
  environmentsEqual,
  personalEnvironment,
  projectEnvironment,
  resolveProjectRoot,
  type ExecutionEnvironment,
} from "./environment.ts";
import type { SessionState, TopicSettingsFile, BindingsFile } from "./types.ts";
import { atomicWrite } from "../fs.ts";

function isHexSessionId(id: string): boolean {
  return /^[0-9a-f]{10}$/.test(id);
}

/** Canonicalize a stored project path. Returns null if it is missing, not a directory, or inaccessible. */
function canonicalizeProjectPath(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return resolveProjectRoot(raw);
  } catch {
    return null;
  }
}

/**
 * Migrate topic settings: every `projectDir` is resolved to a canonical
 * `projectRoot`; the legacy field and any pending notice are removed.
 * Empty records are dropped.
 */
function migrateTopicSettings(home: string): void {
  const settings = loadTopicSettings(home);
  let changed = false;
  for (const [key, value] of Object.entries(settings.surfaces)) {
    const raw = value?.projectRoot ?? value?.projectDir;
    if (!raw) continue;
    const canonical = canonicalizeProjectPath(raw);
    if (canonical === null) {
      log.warn("removing topic setting with missing/inaccessible project path", { surfaceId: key, raw });
      delete settings.surfaces[key as SurfaceId];
      changed = true;
      continue;
    }
    settings.surfaces[key as SurfaceId] = { projectRoot: canonical };
    changed = true;
  }
  if (changed) saveTopicSettings(home, settings);
}

function canonicalProjectRootForSurface(settings: TopicSettingsFile, surface: Surface): string | undefined {
  const s = settings.surfaces[surfaceId(surface)];
  const raw = s?.projectRoot ?? s?.projectDir;
  if (!raw) return undefined;
  return canonicalizeProjectPath(raw) ?? undefined;
}

function collectSessionSurfaces(bindings: BindingsFile): Map<string, Surface[]> {
  const map = new Map<string, Surface[]>();
  for (const [key, sessionId] of Object.entries(bindings.surfaces)) {
    let surface: Surface;
    try {
      surface = parseSurfaceId(key);
    } catch {
      continue;
    }
    const arr = map.get(sessionId) ?? [];
    arr.push(surface);
    map.set(sessionId, arr);
  }
  return map;
}

function inferSessionEnvironment(
  id: string,
  state: SessionState,
  surfaces: Surface[],
  settings: TopicSettingsFile,
): ExecutionEnvironment {
  if (state.chatId === 0) return personalEnvironment();

  // Bound surfaces: all must agree on the environment.
  const roots = new Set<string>();
  let hasPersonalSurface = false;
  for (const surface of surfaces) {
    const root = canonicalProjectRootForSurface(settings, surface);
    if (root) {
      roots.add(root);
    } else {
      hasPersonalSurface = true;
    }
  }
  const rootArray = Array.from(roots);
  if (rootArray.length > 1 || (rootArray.length === 1 && hasPersonalSurface)) {
    const details = hasPersonalSurface ? [...rootArray, "<personal>"].join(", ") : rootArray.join(", ");
    throw new Error(`session ${id} is bound to surfaces with conflicting environments: ${details}`);
  }
  if (rootArray.length === 1) {
    return projectEnvironment(rootArray[0]!);
  }
  if (hasPersonalSurface) {
    return personalEnvironment();
  }

  // Unbound session: use legacy projectDir from state if present.
  const legacyProjectDir = (state as unknown as Record<string, unknown>).projectDir;
  if (typeof legacyProjectDir === "string" && legacyProjectDir.length > 0) {
    const canonical = canonicalizeProjectPath(legacyProjectDir);
    if (canonical !== null) return projectEnvironment(canonical);
  }

  return personalEnvironment();
}

/**
 * Select the canonical cwd a pi header should be rewritten to.
 * Returns the original cwd when no rewrite is needed, the normalized cwd when
 * the header is an allowed legacy spelling, or undefined when incompatible.
 */
function selectNormalizedCwd(headerCwd: string, env: ExecutionEnvironment, home: string): string | undefined {
  const expectedCwd = env.kind === "personal" ? workspacePath(home) : env.projectRoot;
  if (headerCwd === expectedCwd) return headerCwd;

  if (env.kind === "personal") {
    if (headerCwd === workdirPath(home)) return expectedCwd;
  } else {
    try {
      if (realpathSync(headerCwd) === env.projectRoot) return expectedCwd;
    } catch {
      // realpath failed; cannot normalize
    }
  }

  return undefined;
}

/**
 * Validate all `.jsonl` session files in a directory against the selected
 * environment. Throws on the first malformed or incompatible header.
 */
function validatePiSessionFiles(piDir: string, env: ExecutionEnvironment, home: string): void {
  if (!existsSync(piDir)) return;
  const files = readdirSync(piDir).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const path = join(piDir, f);
    const header = readPiSessionHeader(path);
    if (selectNormalizedCwd(header.cwd, env, home) === undefined) {
      throw new Error(
        `session has incompatible pi history: ${path} records cwd ${header.cwd} but environment expects ${environmentCwd(env, home)}`,
      );
    }
  }
}

/**
 * Normalize a pi session history file's header cwd to the selected environment.
 * Only two normalizations are allowed:
 *  - personal `scratch/workdir` -> `workspace`
 *  - project header whose realpath equals the project root -> projectRoot
 * Everything else is preserved byte-for-byte.
 */
function normalizePiHistoryFile(filePath: string, env: ExecutionEnvironment, home: string): void {
  const header = readPiSessionHeader(filePath);
  const normalizedCwd = selectNormalizedCwd(header.cwd, env, home);
  if (normalizedCwd === undefined) {
    throw new Error(
      `session has incompatible pi history: ${filePath} records cwd ${header.cwd} but environment expects ${environmentCwd(env, home)}`,
    );
  }
  if (normalizedCwd === header.cwd) return;

  const raw = readFileSync(filePath, "utf-8");
  const firstNl = raw.indexOf("\n");
  const firstLine = raw.slice(0, firstNl >= 0 ? firstNl : undefined);
  const rest = firstNl >= 0 ? raw.slice(firstNl + 1) : "";
  const parsed = JSON.parse(firstLine);
  const newHeader = JSON.stringify({ ...parsed, cwd: normalizedCwd });
  atomicWrite(filePath, newHeader + "\n" + rest);
  log.info("normalized pi history header", { file: filePath, cwd: normalizedCwd });
}

/**
 * Promote regular files/directories from `$GOBLIN_HOME/scratch/workdir` to
 * `$GOBLIN_HOME/workspace`. A collision with an existing workspace path fails
 * loudly. The legacy workdir is removed once it is empty.
 */
function promotePersonalWorkdir(home: string): void {
  const src = workdirPath(home);
  const dst = workspacePath(home);
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  const entries = readdirSync(src);
  for (const name of entries) {
    const srcPath = join(src, name);
    const dstPath = join(dst, name);
    if (existsSync(dstPath)) {
      throw new Error(`workspace collision while promoting personal workdir: ${dstPath}`);
    }
    const st = statSync(srcPath);
    if (st.isFile() || st.isDirectory()) {
      renameSync(srcPath, dstPath);
      log.info("promoted personal workdir entry", { from: srcPath, to: dstPath });
    } else {
      throw new Error(`personal workdir contains non-promotable entry: ${srcPath}`);
    }
  }
  try {
    rmdirSync(src);
  } catch (err) {
    throw new Error(`failed to remove empty personal workdir ${src}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadArchivedLegacyState(home: string, id: string): SessionState | null {
  const path = join(sessionsDir(home), "archive", id, "state.json");
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function saveSessionState(home: string, id: string, state: SessionState, archived: boolean): void {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  saveJsonFile(join(dir, "state.json"), state);
}

interface MigrationPlan {
  id: string;
  state: SessionState;
  env: ExecutionEnvironment;
  archived: boolean;
}

export function migrateExecutionEnvironments(home: string): void {
  migrateTopicSettings(home);
  promotePersonalWorkdir(home);

  const settings = loadTopicSettings(home);
  const bindings = loadBindings(home);
  const sessionSurfaces = collectSessionSurfaces(bindings);

  const sessionsDirPath = sessionsDir(home);
  if (!existsSync(sessionsDirPath)) return;

  const plans: MigrationPlan[] = [];

  function planSession(id: string, archived: boolean): void {
    const state = archived ? loadArchivedLegacyState(home, id) : loadLegacyState(home, id);
    if (state === null) return;

    const surfaces = sessionSurfaces.get(id) ?? [];
    const env = inferSessionEnvironment(id, state, surfaces, settings);
    const piDir = archived ? join(sessionsDirPath, "archive", id, "pi") : piSessionDir(home, id);
    validatePiSessionFiles(piDir, env, home);

    plans.push({ id, state, env, archived });
  }

  for (const id of readdirSync(sessionsDirPath)) {
    if (!isHexSessionId(id)) continue;
    planSession(id, false);
  }

  const archiveDir = join(sessionsDirPath, "archive");
  if (existsSync(archiveDir)) {
    for (const id of readdirSync(archiveDir)) {
      if (!isHexSessionId(id)) continue;
      planSession(id, true);
    }
  }

  // Second pass: every plan has been validated, so writes are safe to perform.
  for (const plan of plans) {
    const next = plan.state.executionEnvironment && environmentsEqual(plan.state.executionEnvironment, plan.env)
      ? plan.state
      : { ...plan.state, executionEnvironment: plan.env };
    saveSessionState(home, plan.id, next, plan.archived);

    const piDir = plan.archived ? join(sessionsDirPath, "archive", plan.id, "pi") : piSessionDir(home, plan.id);
    if (existsSync(piDir)) {
      for (const f of readdirSync(piDir).filter((f) => f.endsWith(".jsonl"))) {
        normalizePiHistoryFile(join(piDir, f), plan.env, home);
      }
    }
  }
}
