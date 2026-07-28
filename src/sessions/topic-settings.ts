import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile, Surface } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { surfaceId } from "../surface.ts";

const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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

function isCanonicalSettings(value: unknown): value is TopicSettingsFile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.surfaces === "object" && v.surfaces !== null;
}

function isLegacySettings(value: unknown): value is LegacyTopicSettingsFile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return !("version" in v) && (
    typeof v.topics === "object" ||
    typeof v.dm === "object" ||
    typeof v.supergroups === "object"
  );
}

/**
 * Load the canonical topic-settings file (state/topic-settings.json). Returns
 * the default empty canonical shape when the file is missing or malformed. A
 * legacy-shaped file requires the offline migration and is never treated as an
 * empty canonical file, which would lose its other Surface settings on write.
 */
export function loadTopicSettings(home: string): TopicSettingsFile {
  const raw = loadJsonFile<TopicSettingsFile | LegacyTopicSettingsFile>(pathFor(home), structuredClone(DEFAULT_SETTINGS));
  if (isCanonicalSettings(raw)) {
    return raw;
  }
  if (isLegacySettings(raw)) {
    throw new Error(`legacy topic-settings file at ${pathFor(home)} requires offline migration`);
  }
  return structuredClone(DEFAULT_SETTINGS);
}

/**
 * Read only canonical settings while planning the offline Surface migration.
 * A legacy file is intentionally treated as absent here: its entries are read
 * separately through {@link loadLegacyTopicSettings} and migrated into the
 * plan. Runtime callers must use {@link loadTopicSettings}, which refuses a
 * legacy file rather than overwriting it.
 */
export function loadCanonicalTopicSettingsForMigration(home: string): TopicSettingsFile {
  const raw = loadJsonFile<TopicSettingsFile | LegacyTopicSettingsFile>(pathFor(home), structuredClone(DEFAULT_SETTINGS));
  return isCanonicalSettings(raw) ? raw : structuredClone(DEFAULT_SETTINGS);
}

/**
 * Save topic settings atomically (write to unique tmp, then rename).
 */
export function saveTopicSettings(home: string, settings: TopicSettingsFile): void {
  saveJsonFile(pathFor(home), settings);
}

/**
 * Load the legacy pre-Surface topic-settings shape. Used only by migration.
 */
export function loadLegacyTopicSettings(home: string): LegacyTopicSettingsFile {
  const raw = loadJsonFile<TopicSettingsFile | LegacyTopicSettingsFile>(pathFor(home), structuredClone(DEFAULT_LEGACY_SETTINGS));
  if (isLegacySettings(raw)) {
    return {
      topics: raw.topics ?? {},
      dm: raw.dm ?? {},
      supergroups: raw.supergroups ?? {},
    };
  }
  return structuredClone(DEFAULT_LEGACY_SETTINGS);
}

function isEmptySettings(s: TopicSettings): boolean {
  return !s.projectRoot && !s.modelName && !s.thinkingLevel;
}

function settingsForSurface(settings: TopicSettingsFile, surface: Surface): TopicSettings | undefined {
  return settings.surfaces[surfaceId(surface)];
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
