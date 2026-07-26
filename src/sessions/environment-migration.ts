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
 * The migration is split into a read-only planner and an applier. The planner
 * consumes the projected bindings and topic settings from the surface migration
 * step and computes every transformation in memory. Any ambiguity fails loudly
 * and aborts the whole run before the applier mutates persisted input.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
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
 * Canonicalize topic settings: every `projectDir` is resolved to a canonical
 * `projectRoot`; the legacy field and any pending notice are removed.
 * Empty records are dropped. Returns null when no change is required.
 */
function planTopicSettingsMigration(settings: TopicSettingsFile): TopicSettingsFile | null {
  let changed = false;
  const next: TopicSettingsFile = { version: 1, surfaces: {} };

  for (const [key, value] of Object.entries(settings.surfaces)) {
    const raw = value?.projectRoot ?? value?.projectDir;
    if (!raw) {
      // Preserve records that have no project path but may carry model/thinking
      // overrides, stripping only a possible pending notice.
      if (value?.pendingProjectNotice !== undefined) {
        changed = true;
      }
      const cleaned = { ...value };
      delete cleaned.pendingProjectNotice;
      if (Object.keys(cleaned).length > 0) {
        next.surfaces[key as SurfaceId] = cleaned;
      }
      continue;
    }

    const canonical = canonicalizeProjectPath(raw);
    if (canonical === null) {
      // Drop settings whose project path is missing or inaccessible.
      changed = true;
      log.warn("removing topic setting with missing/inaccessible project path", { surfaceId: key, raw });
      continue;
    }

    const cleaned: typeof value = {};
    if (value?.modelName !== undefined) cleaned.modelName = value.modelName;
    if (value?.thinkingLevel !== undefined) cleaned.thinkingLevel = value.thinkingLevel;
    cleaned.projectRoot = canonical;
    next.surfaces[key as SurfaceId] = cleaned;

    if (canonical !== value?.projectRoot || value?.projectDir !== undefined || value?.pendingProjectNotice !== undefined) {
      changed = true;
    }
  }

  return changed ? next : null;
}

function applyTopicSettingsMigration(home: string, settings: TopicSettingsFile): void {
  saveTopicSettings(home, settings);
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
function validatePiSessionFiles(piDir: string, env: ExecutionEnvironment, home: string): string[] {
  if (!existsSync(piDir)) return [];
  const files = readdirSync(piDir).filter((f) => f.endsWith(".jsonl"));
  const result: string[] = [];
  for (const f of files) {
    const path = join(piDir, f);
    const header = readPiSessionHeader(path);
    if (selectNormalizedCwd(header.cwd, env, home) === undefined) {
      throw new Error(
        `session has incompatible pi history: ${path} records cwd ${header.cwd} but environment expects ${environmentCwd(env, home)}`,
      );
    }
    result.push(path);
  }
  return result;
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

interface WorkdirManifestEntry {
  source: string;
  destination: string;
}

interface WorkdirPromotionManifest {
  version: 1;
  entries: WorkdirManifestEntry[];
}

export interface WorkdirPromotionPlan {
  readonly manifest: WorkdirManifestEntry[];
  readonly sourceDir: string;
  readonly destinationDir: string;
}

function workdirManifestPath(home: string): string {
  return join(home, "state", "workdir-promotion-manifest.json");
}

function readWorkdirManifest(home: string): WorkdirManifestEntry[] | null {
  const path = workdirManifestPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt workdir promotion manifest: ${path}`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).entries)) {
    throw new Error(`corrupt workdir promotion manifest: ${path}`);
  }
  const entries = (parsed as Record<string, unknown>).entries as unknown[];
  const result: WorkdirManifestEntry[] = [];
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>).source !== "string" ||
      typeof (entry as Record<string, unknown>).destination !== "string"
    ) {
      throw new Error(`corrupt workdir promotion manifest entry: ${path}`);
    }
    result.push({
      source: (entry as Record<string, unknown>).source as string,
      destination: (entry as Record<string, unknown>).destination as string,
    });
  }
  return result;
}

function saveWorkdirManifest(home: string, entries: WorkdirManifestEntry[]): void {
  saveJsonFile(workdirManifestPath(home), { version: 1, entries } as WorkdirPromotionManifest);
}

function scanWorkdirEntries(home: string): WorkdirManifestEntry[] {
  const src = workdirPath(home);
  if (!existsSync(src)) return [];

  const st = statSync(src);
  if (!st.isDirectory()) {
    throw new Error(`personal workdir is not a directory: ${src}`);
  }

  const dst = workspacePath(home);
  if (existsSync(dst)) {
    const dstSt = statSync(dst);
    if (!dstSt.isDirectory()) {
      throw new Error(`workspace collision while promoting personal workdir: ${dst}`);
    }
    const dstNames = new Set(readdirSync(dst));
    for (const name of readdirSync(src)) {
      if (dstNames.has(name)) {
        throw new Error(`workspace collision while promoting personal workdir: ${join(dst, name)}`);
      }
    }
  }

  const entries: WorkdirManifestEntry[] = [];
  for (const name of readdirSync(src)) {
    const srcPath = join(src, name);
    const dstPath = join(dst, name);
    const st = statSync(srcPath);
    if (!st.isFile() && !st.isDirectory()) {
      throw new Error(`personal workdir contains non-promotable entry: ${srcPath}`);
    }
    entries.push({ source: srcPath, destination: dstPath });
  }
  return entries;
}

function planWorkdirPromotion(home: string): WorkdirPromotionPlan | null {
  const src = workdirPath(home);
  const dst = workspacePath(home);

  const manifest = readWorkdirManifest(home) ?? [];
  const completedSources = new Set<WorkdirManifestEntry["source"]>();
  for (const entry of manifest) {
    const srcExists = existsSync(entry.source);
    const dstExists = existsSync(entry.destination);
    if (!srcExists && dstExists) {
      completedSources.add(entry.source);
      continue;
    }
    if (srcExists && !dstExists) {
      continue;
    }
    if (!srcExists && !dstExists) {
      throw new Error(
        `workdir promotion corruption: both source and destination missing for ${entry.source} -> ${entry.destination}`,
      );
    }
    throw new Error(`workspace collision while promoting personal workdir: ${entry.destination}`);
  }

  const newEntries = scanWorkdirEntries(home).filter((e) => !completedSources.has(e.source));
  const allEntries = manifest.concat(newEntries);
  if (allEntries.length === 0) return null;

  return { manifest: allEntries, sourceDir: src, destinationDir: dst };
}

function applyWorkdirPromotion(home: string, plan: WorkdirPromotionPlan): void {
  mkdirSync(plan.destinationDir, { recursive: true });
  saveWorkdirManifest(home, plan.manifest);
  for (const entry of plan.manifest) {
    if (!existsSync(entry.source)) continue;
    if (existsSync(entry.destination)) {
      throw new Error(`workspace collision while promoting personal workdir: ${entry.destination}`);
    }
    renameSync(entry.source, entry.destination);
    log.info("promoted personal workdir entry", { from: entry.source, to: entry.destination });
  }
  try {
    rmdirSync(plan.sourceDir);
  } catch (err) {
    throw new Error(
      `failed to remove empty personal workdir ${plan.sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    unlinkSync(workdirManifestPath(home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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

export interface SessionEnvironmentPlan {
  readonly id: string;
  readonly state: SessionState;
  readonly env: ExecutionEnvironment;
  readonly archived: boolean;
  readonly piFiles: string[];
}

export interface ExecutionEnvironmentPlan {
  readonly topicSettings: TopicSettingsFile | null;
  readonly workdirPromotion: WorkdirPromotionPlan | null;
  readonly sessionPlans: SessionEnvironmentPlan[];
}

function planSession(
  home: string,
  id: string,
  archived: boolean,
  sessionSurfaces: Map<string, Surface[]>,
  settings: TopicSettingsFile,
): SessionEnvironmentPlan | null {
  const state = archived ? loadArchivedLegacyState(home, id) : loadLegacyState(home, id);
  if (state === null) return null;

  const surfaces = sessionSurfaces.get(id) ?? [];
  const env = inferSessionEnvironment(id, state, surfaces, settings);
  const piDir = archived ? join(sessionsDir(home), "archive", id, "pi") : piSessionDir(home, id);
  const piFiles = validatePiSessionFiles(piDir, env, home);

  return { id, state, env, archived, piFiles };
}

/**
 * Plan the environment migration using the supplied or loaded bindings and
 * topic settings. When bindings/settings are provided, the planner does not
 * read them from disk, allowing the whole-run migration to preflight step 2
 * against the projected output of step 1.
 */
export function planExecutionEnvironments(
  home: string,
  bindings?: BindingsFile,
  settings?: TopicSettingsFile,
): ExecutionEnvironmentPlan {
  const loadedSettings = settings ?? loadTopicSettings(home);
  const topicSettings = planTopicSettingsMigration(loadedSettings);
  const canonicalSettings = topicSettings ?? loadedSettings;

  const loadedBindings = bindings ?? loadBindings(home);
  const sessionSurfaces = collectSessionSurfaces(loadedBindings);

  const workdirPromotion = planWorkdirPromotion(home);

  const sessionPlans: SessionEnvironmentPlan[] = [];
  const sessionsDirPath = sessionsDir(home);
  if (existsSync(sessionsDirPath)) {
    for (const id of readdirSync(sessionsDirPath)) {
      if (!isHexSessionId(id)) continue;
      const plan = planSession(home, id, false, sessionSurfaces, canonicalSettings);
      if (plan) sessionPlans.push(plan);
    }

    const archiveDir = join(sessionsDirPath, "archive");
    if (existsSync(archiveDir)) {
      for (const id of readdirSync(archiveDir)) {
        if (!isHexSessionId(id)) continue;
        const plan = planSession(home, id, true, sessionSurfaces, canonicalSettings);
        if (plan) sessionPlans.push(plan);
      }
    }
  }

  return { topicSettings, workdirPromotion, sessionPlans };
}

/**
 * Apply a planned environment migration. This is the only environment-migration
 * path that mutates persisted input.
 */
export function applyExecutionEnvironments(home: string, plan: ExecutionEnvironmentPlan): void {
  if (plan.topicSettings !== null) {
    applyTopicSettingsMigration(home, plan.topicSettings);
  }

  if (plan.workdirPromotion !== null) {
    applyWorkdirPromotion(home, plan.workdirPromotion);
  }

  for (const sessionPlan of plan.sessionPlans) {
    const next =
      sessionPlan.state.executionEnvironment && environmentsEqual(sessionPlan.state.executionEnvironment, sessionPlan.env)
        ? sessionPlan.state
        : { ...sessionPlan.state, executionEnvironment: sessionPlan.env };
    saveSessionState(home, sessionPlan.id, next, sessionPlan.archived);

    if (sessionPlan.piFiles.length > 0) {
      const piDir = sessionPlan.archived
        ? join(sessionsDir(home), "archive", sessionPlan.id, "pi")
        : piSessionDir(home, sessionPlan.id);
      for (const f of readdirSync(piDir).filter((f) => f.endsWith(".jsonl"))) {
        normalizePiHistoryFile(join(piDir, f), sessionPlan.env, home);
      }
    }
  }
}

/**
 * Convenience entry point: plan and apply environment migration in one call.
 */
export function migrateExecutionEnvironments(home: string): void {
  const plan = planExecutionEnvironments(home);
  applyExecutionEnvironments(home, plan);
}
