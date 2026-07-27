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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { workdirPath, workspacePath } from "../workspace/paths.ts";
import { readPiSessionHeader } from "../pi-host.ts";
import { loadBindings } from "./bindings.ts";
import { loadTopicSettings, saveTopicSettings } from "./topic-settings.ts";
import { loadLegacyState, isValidExecutionEnvironment } from "./state.ts";
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
import type { SessionState, TopicSettings, TopicSettingsFile, BindingsFile } from "./types.ts";
import { atomicWrite } from "../fs.ts";

function isHexSessionId(id: string): boolean {
  return /^[0-9a-f]{10}$/.test(id);
}

/** Canonicalize a project path and require it to be an accessible directory. */
function canonicalizeProjectPath(raw: string, context: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${context} has an empty project path`);
  }
  try {
    return resolveProjectRoot(raw);
  } catch (err) {
    throw new Error(`${context} project path ${raw} is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolve the canonical project root for a `TopicSettings` value. Both the
 * canonical `projectRoot` and the legacy `projectDir` must agree when both are
 * present. Missing/empty values mean "no project". Invalid or disagreeing
 * values throw.
 */
function canonicalSurfaceProjectRoot(value: TopicSettings | undefined, context: string): string | undefined {
  if (!value) return undefined;
  const rootRaw = value.projectRoot;
  const dirRaw = value.projectDir;
  const hasRoot = typeof rootRaw === "string" && rootRaw.length > 0;
  const hasDir = typeof dirRaw === "string" && dirRaw.length > 0;
  if (!hasRoot && !hasDir) return undefined;
  if (hasRoot && !hasDir) return canonicalizeProjectPath(rootRaw, context);
  if (!hasRoot && hasDir) return canonicalizeProjectPath(dirRaw, context);

  const rootCanonical = canonicalizeProjectPath(rootRaw!, `${context} projectRoot`);
  const dirCanonical = canonicalizeProjectPath(dirRaw!, `${context} projectDir`);
  if (rootCanonical !== dirCanonical) {
    throw new Error(`${context} has disagreeing projectRoot (${rootRaw}) and projectDir (${dirRaw})`);
  }
  return rootCanonical;
}

/**
 * Canonicalize topic settings: every `projectDir` is resolved to a canonical
 * `projectRoot`; the legacy field and any pending notice are removed.
 * Surface records that only carry model/thinking overrides are preserved.
 * Returns null when no change is required.
 */
function planTopicSettingsMigration(settings: TopicSettingsFile): TopicSettingsFile | null {
  let changed = false;
  const next: TopicSettingsFile = { version: 1, surfaces: {} };

  for (const [key, value] of Object.entries(settings.surfaces)) {
    const root = canonicalSurfaceProjectRoot(value, `topic setting ${key}`);
    const cleaned: TopicSettings = {};
    if (value?.modelName !== undefined) cleaned.modelName = value.modelName;
    if (value?.thinkingLevel !== undefined) cleaned.thinkingLevel = value.thinkingLevel;
    if (root !== undefined) cleaned.projectRoot = root;

    const hadProjectDir = value?.projectDir !== undefined;
    const hadNotice = value?.pendingProjectNotice !== undefined;
    const hadRoot = value?.projectRoot !== undefined;
    const rootChanged = hadRoot && value!.projectRoot !== root;

    if (hadProjectDir || hadNotice || rootChanged || (hadRoot && root === undefined)) {
      changed = true;
    }

    if (Object.keys(cleaned).length > 0) {
      next.surfaces[key as SurfaceId] = cleaned;
    }
  }

  return changed ? next : null;
}

function applyTopicSettingsMigration(home: string, settings: TopicSettingsFile): void {
  saveTopicSettings(home, settings);
}

function canonicalProjectRootForSurface(settings: TopicSettingsFile, surface: Surface): string | undefined {
  return canonicalSurfaceProjectRoot(settings.surfaces[surfaceId(surface)], `surface ${surfaceId(surface)}`);
}

function collectSessionSurfaces(bindings: BindingsFile): Map<string, Surface[]> {
  const map = new Map<string, Surface[]>();
  for (const [key, sessionId] of Object.entries(bindings.surfaces)) {
    let surface: Surface;
    try {
      surface = parseSurfaceId(key);
    } catch {
      throw new Error(`binding has invalid SurfaceId: ${key}`);
    }
    const arr = map.get(sessionId) ?? [];
    arr.push(surface);
    map.set(sessionId, arr);
  }
  return map;
}

function surfaceMatchesLegacyState(surface: Surface, state: SessionState): boolean {
  if (surface.chatId !== state.chatId) return false;
  if (surface.kind === "topic") {
    return typeof state.topicId === "number" && surface.topicId === state.topicId;
  }
  return state.topicId === undefined || state.topicId === null;
}

function inferSessionEnvironment(
  id: string,
  state: SessionState,
  boundSurfaces: Surface[],
  settings: TopicSettingsFile,
): ExecutionEnvironment {
  if (typeof state.chatId !== "number" || !Number.isSafeInteger(state.chatId)) {
    throw new Error(`session ${id} has malformed routing identity: chatId ${String(state.chatId)}`);
  }
  if (state.id !== undefined && state.id !== id) {
    throw new Error(`session ${id} state file id mismatch: ${String(state.id)}`);
  }

  const rootSources = new Map<string, string>();
  let hasPersonalCandidate = false;

  if (state.chatId === 0) {
    if (boundSurfaces.length > 0) {
      throw new Error(`internal session ${id} is bound to ${boundSurfaces.length} surface(s)`);
    }
    const legacyProjectDir = (state as unknown as Record<string, unknown>).projectDir;
    if (typeof legacyProjectDir === "string" && legacyProjectDir.length > 0) {
      throw new Error(`internal session ${id} has projectDir ${legacyProjectDir}`);
    }
    if (state.executionEnvironment !== undefined && state.executionEnvironment.kind === "project") {
      throw new Error(`internal session ${id} has project executionEnvironment`);
    }
    return personalEnvironment();
  }

  const legacyProjectDir = (state as unknown as Record<string, unknown>).projectDir;
  if (typeof legacyProjectDir === "string" && legacyProjectDir.length > 0) {
    const canonical = canonicalizeProjectPath(legacyProjectDir, `session ${id} projectDir`);
    rootSources.set(canonical, `session ${id} projectDir`);
  }

  for (const surface of boundSurfaces) {
    const root = canonicalProjectRootForSurface(settings, surface);
    if (root !== undefined) {
      rootSources.set(root, `surface ${surfaceId(surface)}`);
    } else {
      hasPersonalCandidate = true;
    }
  }

  if (boundSurfaces.length === 0) {
    for (const [key, value] of Object.entries(settings.surfaces)) {
      let surface: Surface;
      try {
        surface = parseSurfaceId(key);
      } catch {
        throw new Error(`topic setting has invalid SurfaceId: ${key}`);
      }
      if (!surfaceMatchesLegacyState(surface, state)) continue;
      const root = canonicalSurfaceProjectRoot(value, `topic setting ${key}`);
      if (root !== undefined) {
        rootSources.set(root, `surface setting ${key}`);
      } else {
        hasPersonalCandidate = true;
      }
    }
  }

  let selected: ExecutionEnvironment;
  if (rootSources.size > 1 || (rootSources.size === 1 && hasPersonalCandidate)) {
    const roots = Array.from(rootSources.entries()).map(([root, source]) => `${root} (${source})`);
    const details = hasPersonalCandidate ? [...roots, "<personal>"].join(", ") : roots.join(", ");
    throw new Error(`session ${id} has conflicting environments: ${details}`);
  }
  if (rootSources.size === 1) {
    selected = projectEnvironment([...rootSources.keys()][0]!);
  } else {
    selected = personalEnvironment();
  }

  if (state.executionEnvironment !== undefined) {
    if (!isValidExecutionEnvironment(state.executionEnvironment)) {
      throw new Error(`session ${id} has malformed executionEnvironment`);
    }
    if (!environmentsEqual(state.executionEnvironment, selected)) {
      throw new Error(
        `session ${id} canonical executionEnvironment ${JSON.stringify(state.executionEnvironment)} disagrees with inferred ${JSON.stringify(selected)}`,
      );
    }
    return state.executionEnvironment;
  }

  return selected;
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

interface WorkdirEntry {
  source: string;
  destination: string;
}

export interface WorkdirPromotionPlan {
  readonly entries: WorkdirEntry[];
  readonly sourceDir: string;
  readonly destinationDir: string;
}

function scanWorkdirEntries(home: string): WorkdirEntry[] {
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

  const entries: WorkdirEntry[] = [];
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
  const entries = scanWorkdirEntries(home);
  if (entries.length === 0) return null;
  return { entries, sourceDir: src, destinationDir: dst };
}

function applyWorkdirPromotion(plan: WorkdirPromotionPlan): void {
  mkdirSync(plan.destinationDir, { recursive: true });
  for (const entry of plan.entries) {
    if (!existsSync(entry.source)) {
      throw new Error(`personal workdir entry disappeared during migration: ${entry.source}`);
    }
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

function saveSessionState(home: string, id: string, state: SessionState, env: ExecutionEnvironment, archived: boolean): void {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  const next: SessionState = {
    id: state.id,
    createdAt: state.createdAt,
    chatId: state.chatId,
    topicId: state.topicId,
    title: state.title,
    executionEnvironment: env,
  };
  saveJsonFile(join(dir, "state.json"), next);
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
    applyWorkdirPromotion(plan.workdirPromotion);
  }

  for (const sessionPlan of plan.sessionPlans) {
    saveSessionState(home, sessionPlan.id, sessionPlan.state, sessionPlan.env, sessionPlan.archived);

    for (const filePath of sessionPlan.piFiles) {
      normalizePiHistoryFile(filePath, sessionPlan.env, home);
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
