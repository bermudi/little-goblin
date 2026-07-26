import type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile, Surface } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";
import { surfaceId } from "../surface.ts";

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
  return !s.projectDir && !s.pendingProjectNotice;
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

/** Read the projectDir for a complete Surface. */
export function getProjectDir(home: string, surface: Surface): string | undefined {
  const settings = loadTopicSettings(home);
  return settingsForSurface(settings, surface)?.projectDir;
}

/** Bind (or clear) the projectDir for a complete Surface. */
export function bindProjectDir(home: string, surface: Surface, projectDir: string | undefined): void {
  const notice = projectDir !== undefined
    ? `Project directory changed to \`${projectDir}\`.`
    : undefined;
  const settings = loadTopicSettings(home);
  updateSurface(settings, surface, (s) => ({ ...s, projectDir, pendingProjectNotice: notice }));
  saveTopicSettings(home, settings);
  log.info("bound projectDir", { surfaceId: surfaceId(surface), projectDir });
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
