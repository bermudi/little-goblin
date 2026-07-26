import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile, Surface } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { surfaceId } from "../surface.ts";
import { resolveProjectRoot } from "./environment.ts";

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
 * the default empty canonical shape when the file is missing or malformed.
 */
export function loadTopicSettings(home: string): TopicSettingsFile {
  const raw = loadJsonFile<TopicSettingsFile | LegacyTopicSettingsFile>(pathFor(home), structuredClone(DEFAULT_SETTINGS));
  if (isCanonicalSettings(raw)) {
    return raw;
  }
  return structuredClone(DEFAULT_SETTINGS);
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
  return !s.projectRoot && !s.projectDir && !s.pendingProjectNotice && !s.modelName && !s.thinkingLevel;
}

function settingsForSurface(settings: TopicSettingsFile, surface: Surface): TopicSettings | undefined {
  return settings.surfaces[surfaceId(surface)];
}

function updateSurface(settings: TopicSettingsFile, surface: Surface, updater: (s: TopicSettings) => TopicSettings): void {
  const key = surfaceId(surface);
  const next = updater(settings.surfaces[key] ?? {});
  if (isEmptySettings(next)) {
    delete settings.surfaces[key];
  } else {
    settings.surfaces[key] = next;
  }
}

/** Read the canonical project root for a complete Surface. */
export function getProjectRoot(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  const s = settingsForSurface(settings, surface);
  return s?.projectRoot ?? s?.projectDir;
}

/**
 * Read the project root for a complete Surface using the legacy field name.
 * @deprecated Use `getProjectRoot`.
 */
export function getProjectDir(home: string, surface: Surface): string | undefined {
  return getProjectRoot(home, surface);
}

/**
 * Bind (or clear) the canonical project root for a complete Surface.
 * This is the assignment primitive: it persists the canonical root and clears
 * any legacy projectDir/pendingProjectNotice for the Surface.
 */
export function bindProjectRoot(home: string, surface: Surface, projectRoot: string | undefined): void {
  const settings = loadTopicSettings(home);
  updateSurface(settings, surface, (s) => ({
    ...s,
    projectRoot,
    projectDir: undefined,
    pendingProjectNotice: undefined,
  }));
  saveTopicSettings(home, settings);
  log.info("bound projectRoot", { surfaceId: surfaceId(surface), projectRoot });
}

/**
 * Bind (or clear) the project directory for a complete Surface. Input is
 * canonicalized before storage. This legacy helper also sets `projectDir` and
 * a pending notice for backwards compatibility with mutable-project callers.
 * @deprecated Use `bindProjectRoot` for canonical assignment or
 * `SessionManager.assignProject` for immutable first assignment.
 */
export function bindProjectDir(home: string, surface: Surface, projectDir: string | undefined): void {
  if (projectDir === undefined) {
    bindProjectRoot(home, surface, undefined);
    return;
  }
  const canonical = resolveProjectRoot(projectDir);
  const settings = loadTopicSettings(home);
  updateSurface(settings, surface, (s) => ({
    ...s,
    projectRoot: canonical,
    projectDir: canonical,
    pendingProjectNotice: `Project directory changed to \`${canonical}\`.`,
  }));
  saveTopicSettings(home, settings);
  log.info("bound projectDir (deprecated)", { surfaceId: surfaceId(surface), projectDir: canonical });
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
  return isValidThinkingLevel(getThinkingLevel(home, surface));
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

/** Read and clear the pending project notice for a complete Surface. */
export function consumeProjectNotice(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  const existing = settingsForSurface(settings, surface);
  if (!existing?.pendingProjectNotice) return undefined;

  const notice = existing.pendingProjectNotice;
  updateSurface(settings, surface, (s) => {
    const { pendingProjectNotice: _, ...rest } = s;
    return rest;
  });
  saveTopicSettings(home, settings);
  return notice;
}
