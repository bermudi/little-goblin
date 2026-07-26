/**
 * Offline migration of legacy session execution environments to canonical
 * ExecutionEnvironment values.
 *
 * This runs after surface migration. It:
 *  - canonicalizes legacy `projectDir` topic settings to `projectRoot`
 *  - infers an immutable execution environment for every session without one
 *  - validates/normalizes pi JSONL history headers against the selected env
 *  - promotes legacy `scratch/workdir` personal contents to `workspace`
 *
 * All mutations are computed in memory or applied per-file atomically. The
 * migration fails before any state/history write when a session has ambiguous
 * or incompatible environment authority.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { workdirPath, workspacePath } from "../workspace/paths.ts";
import { readPiSessionHeader, validatePiSessionHeaders } from "../pi-host.ts";
import { loadBindings } from "./bindings.ts";
import { loadTopicSettings, saveTopicSettings } from "./topic-settings.ts";
import { loadLegacyState, saveState } from "./state.ts";
import { sessionsDir, piSessionDir } from "./paths.ts";
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

/** Canonicalize a stored project path. Throws if the path is missing or not a directory. */
function canonicalizeProjectPath(raw: string | undefined): string | null {
  if (!raw) return null;
  return resolveProjectRoot(raw);
}

/**
 * Migrate topic settings: every `projectDir` is resolved to a canonical
 * `projectRoot`; the legacy field is removed. Empty records are dropped.
 */
function migrateTopicSettings(home: string): void {
  const settings = loadTopicSettings(home);
  let changed = false;
  for (const [key, value] of Object.entries(settings.surfaces)) {
    if (!value?.projectDir) continue;
    const canonical = canonicalizeProjectPath(value.projectDir);
    if (canonical === null) {
      log.warn("removing topic setting with missing projectDir", { surfaceId: key, projectDir: value.projectDir });
      delete settings.surfaces[key as SurfaceId];
      changed = true;
      continue;
    }
    settings.surfaces[key as SurfaceId] = {
      projectRoot: canonical,
    };
    changed = true;
  }
  if (changed) saveTopicSettings(home, settings);
}

function projectRootForSurface(settings: TopicSettingsFile, surface: Surface): string | undefined {
  return settings.surfaces[surfaceId(surface)]?.projectRoot;
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
  for (const surface of surfaces) {
    const root = projectRootForSurface(settings, surface);
    if (root) roots.add(root);
  }
  const rootArray = Array.from(roots);
  if (rootArray.length > 1) {
    throw new Error(
      `session ${id} is bound to surfaces with conflicting project roots: ${rootArray.join(", ")}`,
    );
  }
  if (rootArray.length === 1) {
    return projectEnvironment(rootArray[0]!);
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
 * Normalize a pi session history file's header cwd to the selected environment.
 * Only two normalizations are allowed:
 *  - personal `scratch/workdir` -> `workspace`
 *  - project header whose realpath equals the project root -> projectRoot
 * Everything else is preserved byte-for-byte.
 */
function normalizePiHistory(
  home: string,
  id: string,
  filePath: string,
  env: ExecutionEnvironment,
): void {
  let header: { cwd: string };
  try {
    header = readPiSessionHeader(filePath);
  } catch {
    throw new Error(`session ${id} has malformed pi history header: ${filePath}`);
  }

  const expectedCwd = env.kind === "personal" ? workspacePath(home) : env.projectRoot;
  const headerCwd = header.cwd;

  // Already matches: nothing to do.
  if (headerCwd === expectedCwd) return;

  let normalizedCwd: string | undefined;

  if (env.kind === "personal") {
    const workdir = workdirPath(home);
    if (headerCwd === workdir) {
      normalizedCwd = expectedCwd;
    }
  } else {
    try {
      if (realpathSync(headerCwd) === env.projectRoot) {
        normalizedCwd = expectedCwd;
      }
    } catch {
      // realpath failed; cannot normalize
    }
  }

  if (normalizedCwd === undefined) {
    throw new Error(
      `session ${id} has incompatible pi history: ${filePath} records cwd ${headerCwd} but environment expects ${expectedCwd}`,
    );
  }

  // Rewrite only the first line; preserve every non-header line exactly.
  const raw = readFileSync(filePath, "utf-8");
  const firstNl = raw.indexOf("\n");
  const firstLine = raw.slice(0, firstNl >= 0 ? firstNl : undefined);
  const rest = firstNl >= 0 ? raw.slice(firstNl + 1) : "";
  const parsed = JSON.parse(firstLine);
  const newHeader = JSON.stringify({ ...parsed, cwd: normalizedCwd });
  atomicWrite(filePath, newHeader + "\n" + rest);
  log.info("normalized pi history header", { sessionId: id, file: filePath, cwd: normalizedCwd });
}

/**
 * Promote regular files/directories from `$GOBLIN_HOME/scratch/workdir` to
 * `$GOBLIN_HOME/workspace`. A collision with an existing workspace path fails
 * loudly.
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
    }
  }
}

function migrateSession(home: string, id: string, state: SessionState | null, env: ExecutionEnvironment): SessionState {
  if (state === null) {
    throw new Error(`session directory ${id} has no state.json`);
  }
  if (state.executionEnvironment && environmentsEqual(state.executionEnvironment, env)) {
    return state;
  }
  const next: SessionState = { ...state, executionEnvironment: env };
  saveState(home, next);
  return next;
}

export function migrateExecutionEnvironments(home: string): void {
  migrateTopicSettings(home);
  const settings = loadTopicSettings(home);
  const bindings = loadBindings(home);
  const sessionSurfaces = collectSessionSurfaces(bindings);

  const sessionsDirPath = sessionsDir(home);
  if (!existsSync(sessionsDirPath)) return;

  const entries = readdirSync(sessionsDirPath);
  for (const id of entries) {
    if (id === "archive" || !isHexSessionId(id)) continue;
    const state = loadLegacyState(home, id);
    if (state === null) continue;

    const surfaces = sessionSurfaces.get(id) ?? [];
    const env = inferSessionEnvironment(id, state, surfaces, settings);
    const migrated = migrateSession(home, id, state, env);

    const piDir = piSessionDir(home, id);
    if (existsSync(piDir)) {
      const expectedCwd = environmentCwd(migrated.executionEnvironment, home);
      const incompatible = validatePiSessionHeaders(piDir, expectedCwd);
      if (incompatible.length > 0) {
        const details = incompatible.map((i) => `${i.path} (cwd ${i.headerCwd})`).join("; ");
        throw new Error(`session ${id} has incompatible pi history headers: ${details}`);
      }
      const files = readdirSync(piDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        normalizePiHistory(home, id, join(piDir, f), migrated.executionEnvironment);
      }
    }
  }

  promotePersonalWorkdir(home);
}
