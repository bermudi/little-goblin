import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile, Surface } from "./types.ts";
import { assertCanonicalProjectRoot, isCanonicalProjectRoot } from "./environment.ts";
import { topicSettingsPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { cloneSkillPolicy, DEFAULT_SKILL_POLICY, validateSkillPolicy, type SkillPolicy } from "../agent/skills/types.ts";
import { parseSurfaceId, surfaceId } from "../surface.ts";

const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isValidThinkingLevel(level: string | undefined): level is ThinkingLevel {
  return level !== undefined && (ALL_THINKING_LEVELS as readonly string[]).includes(level);
}

export type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile } from "./types.ts";

const DEFAULT_SETTINGS: TopicSettingsFile = {
  version: 1,
  surfaces: {},
};

const DEFAULT_LEGACY_SETTINGS: LegacyTopicSettingsFile = {
  topics: {},
  dm: {},
  supergroups: {},
};

function pathFor(home: string): string {
  return topicSettingsPath(home);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalSettings(value: unknown): value is TopicSettingsFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.surfaces)) return false;
  return Object.keys(value).every((key) => key === "version" || key === "surfaces");
}

function isLegacySettings(value: unknown): value is LegacyTopicSettingsFile {
  if (!isRecord(value) || "version" in value) return false;
  return isRecord(value.topics) || isRecord(value.dm) || isRecord(value.supergroups);
}

function assertCanonicalSettings(value: unknown, path: string): asserts value is TopicSettingsFile {
  if (!isCanonicalSettings(value)) {
    throw new Error(`invalid canonical topic-settings file at ${path}`);
  }
}

function validateSurfaceSettings(surfaceKey: string, value: unknown): asserts value is TopicSettings {
  parseSurfaceId(surfaceKey);
  if (!isRecord(value)) {
    throw new Error(`invalid settings for surface ${surfaceKey}`);
  }
  const validKeys = new Set(["projectRoot", "modelName", "thinkingLevel", "skillPolicy"]);
  for (const key of Object.keys(value)) {
    if (!validKeys.has(key)) {
      throw new Error(`invalid settings field ${key} for surface ${surfaceKey}`);
    }
  }
  if (value.projectRoot !== undefined && !isCanonicalProjectRoot(value.projectRoot)) {
    throw new Error(`invalid projectRoot for surface ${surfaceKey}: expected existing canonical directory`);
  }
  if (value.modelName !== undefined && (typeof value.modelName !== "string" || value.modelName.length === 0)) {
    throw new Error(`invalid modelName for surface ${surfaceKey}`);
  }
  if (value.thinkingLevel !== undefined && !isValidThinkingLevel(
    typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
  )) {
    throw new Error(`invalid thinkingLevel for surface ${surfaceKey}`);
  }
  if (value.skillPolicy !== undefined) {
    validateSkillPolicy(value.skillPolicy, `skillPolicy for surface ${surfaceKey}`);
  }
}

/** Validate exact current-version Surface settings authority. */
export function validateTopicSettings(settings: TopicSettingsFile): void {
  assertCanonicalSettings(settings, "topic-settings");
  for (const [surfaceKey, value] of Object.entries(settings.surfaces)) {
    validateSurfaceSettings(surfaceKey, value);
  }
}

/**
 * Load canonical Surface settings. Missing state is an empty file; malformed,
 * legacy, or structurally invalid authority fails before a runtime write can
 * erase it.
 */
export function loadTopicSettings(home: string): TopicSettingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown>(path, structuredClone(DEFAULT_SETTINGS));
  if (isLegacySettings(raw)) {
    throw new Error(`legacy topic-settings file at ${path} requires offline migration`);
  }
  assertCanonicalSettings(raw, path);
  validateTopicSettings(raw);
  return raw;
}

/**
 * Read only canonical settings while planning the offline Surface migration.
 * A valid legacy file is absent canonical input and is read separately by the
 * legacy loader; malformed input still fails the migration plan.
 */
export function loadCanonicalTopicSettingsForMigration(home: string): TopicSettingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown>(path, structuredClone(DEFAULT_SETTINGS));
  if (isLegacySettings(raw)) return structuredClone(DEFAULT_SETTINGS);
  // This loader participates in the offline step that normalizes historical
  // `projectRoot` spellings. Runtime callers use the strict loader above.
  validateEnvironmentMigrationSettings(raw, path);
  return raw;
}

/**
 * Read the version-1 Surface-keyed settings accepted by offline execution-
 * environment migration. That one historical step may see `projectDir` and
 * `pendingProjectNotice`; runtime code must use `loadTopicSettings` instead.
 */
function validateEnvironmentMigrationSettings(settings: unknown, path: string): asserts settings is TopicSettingsFile {
  assertCanonicalSettings(settings, path);
  const allowedKeys = new Set(["projectRoot", "projectDir", "pendingProjectNotice", "modelName", "thinkingLevel"]);
  for (const [surfaceKey, value] of Object.entries(settings.surfaces)) {
    parseSurfaceId(surfaceKey);
    if (!isRecord(value)) {
      throw new Error(`invalid settings for surface ${surfaceKey}`);
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`invalid settings field ${key} for surface ${surfaceKey}`);
      }
    }
    for (const key of allowedKeys) {
      if (value[key] !== undefined && typeof value[key] !== "string") {
        throw new Error(`invalid settings field ${key} for surface ${surfaceKey}`);
      }
    }
  }
}

export function loadTopicSettingsForEnvironmentMigration(home: string): TopicSettingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown>(path, structuredClone(DEFAULT_SETTINGS));
  validateEnvironmentMigrationSettings(raw, path);
  return raw;
}

/**
 * Write Surface-keyed settings while offline environment migration is still
 * carrying its explicitly allowed legacy fields. Runtime code must use
 * `saveTopicSettings`, which accepts only the current schema.
 */
export function saveTopicSettingsForEnvironmentMigration(home: string, settings: TopicSettingsFile): void {
  validateEnvironmentMigrationSettings(settings, pathFor(home));
  saveJsonFile(pathFor(home), settings);
}

/** Save validated topic settings atomically (write to unique tmp, then rename). */
export function saveTopicSettings(home: string, settings: TopicSettingsFile): void {
  validateTopicSettings(settings);
  saveJsonFile(pathFor(home), settings);
}

/** Load legacy pre-Surface settings only for the offline migration. */
export function loadLegacyTopicSettings(home: string): LegacyTopicSettingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown | undefined>(path, undefined);
  if (raw === undefined || isCanonicalSettings(raw)) return structuredClone(DEFAULT_LEGACY_SETTINGS);
  if (!isLegacySettings(raw)) {
    throw new Error(`invalid legacy topic-settings file at ${path}`);
  }
  return {
    topics: raw.topics ?? {},
    dm: raw.dm ?? {},
    supergroups: raw.supergroups ?? {},
  };
}

function isEmptySettings(s: TopicSettings): boolean {
  return !s.projectRoot && !s.modelName && !s.thinkingLevel && !s.skillPolicy;
}

function settingsForSurface(settings: TopicSettingsFile, surface: Surface): TopicSettings | undefined {
  return settings.surfaces[surfaceId(surface)];
}

/** One validated read of every Surface setting consumed by runtime preparation. */
export interface SurfaceRuntimeSettingsRecord {
  readonly projectRoot: string | undefined;
  readonly modelName: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly skillPolicy: SkillPolicy;
}

export function getSurfaceRuntimeSettings(
  home: string,
  surface: Surface,
): SurfaceRuntimeSettingsRecord {
  const stored = settingsForSurface(loadTopicSettings(home), surface);
  return {
    projectRoot: stored?.projectRoot,
    modelName: stored?.modelName,
    thinkingLevel: isValidThinkingLevel(stored?.thinkingLevel) ? stored.thinkingLevel : undefined,
    skillPolicy: cloneSkillPolicy(stored?.skillPolicy ?? DEFAULT_SKILL_POLICY),
  };
}

function updateSurface(settings: TopicSettingsFile, surface: Surface, updater: (s: TopicSettings) => TopicSettings): void {
  const key = surfaceId(surface);
  const next = updater(settings.surfaces[key] ?? {});
  // Runtime settings never write the legacy projectDir field.
  // pendingProjectNotice is migration-only and not on the runtime type;
  // environment migration strips it via LegacyTopicSettingsValue.
  delete next.projectDir;
  if (isEmptySettings(next)) {
    delete settings.surfaces[key];
  } else {
    settings.surfaces[key] = next;
  }
}

/** Read the canonical project root for a complete Surface. Runtime reads only projectRoot. */
export function getProjectRoot(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  return settingsForSurface(settings, surface)?.projectRoot;
}

/**
 * Persist an immutable, set-once canonical project assignment for a Surface.
 * Re-assigning the same root is a no-op; assigning a different root throws.
 * Callers must canonicalize the path before calling.
 */
export function bindProjectRoot(home: string, surface: Surface, projectRoot: string): void {
  if (!projectRoot) {
    throw new Error("projectRoot is required; assignment clearing is not supported");
  }
  assertCanonicalProjectRoot(projectRoot, "projectRoot");
  const settings = loadTopicSettings(home);
  const existing = settingsForSurface(settings, surface)?.projectRoot;
  if (existing === projectRoot) {
    log.info("project assignment already present", { surfaceId: surfaceId(surface), projectRoot });
    return;
  }
  if (existing) {
    throw new Error(`surface ${surfaceId(surface)} is already assigned to ${existing}; cannot reassign to ${projectRoot}`);
  }
  updateSurface(settings, surface, (s) => ({ ...s, projectRoot }));
  saveTopicSettings(home, settings);
  log.info("bound projectRoot", { surfaceId: surfaceId(surface), projectRoot });
}

/** Read the effective Surface skill policy, applying defaults without writing them. */
export function getSkillPolicy(home: string, surface: Surface): SkillPolicy {
  const settings = loadTopicSettings(home);
  const stored = settingsForSurface(settings, surface)?.skillPolicy;
  return cloneSkillPolicy(stored ?? DEFAULT_SKILL_POLICY);
}

/** Persist the complete validated skill policy for a Surface atomically. */
export function setSkillPolicy(home: string, surface: Surface, policy: SkillPolicy): void {
  const settings = loadTopicSettings(home);
  const canonical = cloneSkillPolicy(policy);
  updateSurface(settings, surface, (s) => ({ ...s, skillPolicy: canonical }));
  saveTopicSettings(home, settings);
  log.info("bound skill policy", {
    surfaceId: surfaceId(surface),
    policy: canonical,
  });
}

/** Read the model override for a complete Surface, or undefined if using the config default. */
export function getModelName(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  return settingsForSurface(settings, surface)?.modelName;
}

/** Read the thinking level override for a complete Surface, or undefined if using the model default. */
export function getThinkingLevel(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  return settingsForSurface(settings, surface)?.thinkingLevel;
}

/** Read the validated thinking level override for a complete Surface, or undefined if invalid/unset. */
export function getThinkingLevelValidated(home: string, surface: Surface): ThinkingLevel | undefined {
  const level = getThinkingLevel(home, surface);
  return isValidThinkingLevel(level) ? level : undefined;
}

/** Bind (or clear) the model override for a complete Surface. */
export function setModelName(home: string, surface: Surface, modelName: string | undefined): void {
  const settings = loadTopicSettings(home);
  updateSurface(settings, surface, (s) => ({ ...s, modelName }));
  saveTopicSettings(home, settings);
  log.info("bound modelName", { surfaceId: surfaceId(surface), modelName });
}

/** Bind (or clear) the thinking level override for a complete Surface. */
export function setThinkingLevel(home: string, surface: Surface, thinkingLevel: string | undefined): void {
  const settings = loadTopicSettings(home);
  updateSurface(settings, surface, (s) => ({ ...s, thinkingLevel }));
  saveTopicSettings(home, settings);
  log.info("bound thinkingLevel", { surfaceId: surfaceId(surface), thinkingLevel });
}

/** Surface-scoped preference patch. A present key with an `undefined` value clears that field. */
export interface SurfacePreferencePatch {
  modelName?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

function hasOwn<K extends string>(value: object, key: K): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Apply a model/thinking preference patch to a Surface in one atomic settings
 * write. A key that is present with `undefined` clears that override; an
 * omitted key leaves the existing value unchanged. Validation fails before any
 * write, so invalid input never mutates durable state.
 */
export function patchSurfaceSettings(home: string, surface: Surface, patch: SurfacePreferencePatch): void {
  const settings = loadTopicSettings(home);

  updateSurface(settings, surface, (s) => {
    const next = { ...s };
    if (hasOwn(patch, "modelName")) {
      if (patch.modelName !== undefined && (typeof patch.modelName !== "string" || patch.modelName.length === 0)) {
        throw new Error(`invalid modelName for surface ${surfaceId(surface)}`);
      }
      next.modelName = patch.modelName;
    }
    if (hasOwn(patch, "thinkingLevel")) {
      if (patch.thinkingLevel !== undefined && !isValidThinkingLevel(patch.thinkingLevel)) {
        throw new Error(`invalid thinkingLevel for surface ${surfaceId(surface)}`);
      }
      next.thinkingLevel = patch.thinkingLevel;
    }
    return next;
  });

  saveTopicSettings(home, settings);
  log.info("patched surface preferences", {
    surfaceId: surfaceId(surface),
    modelName: hasOwn(patch, "modelName") ? patch.modelName : "(unchanged)",
    thinkingLevel: hasOwn(patch, "thinkingLevel") ? patch.thinkingLevel : "(unchanged)",
  });
}
