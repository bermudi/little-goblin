import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatLocator } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";
import { log } from "../log.ts";

/**
 * Per-chat-surface settings persisted in $GOBLIN_HOME/topic-settings.json.
 * Keys are stringified chatId/topicId numbers.
 */
export interface TopicSettingsFile {
  /** Topic bindings: chatId -> topicId -> settings */
  topics?: Record<string, Record<string, TopicSettings>>;
  /** DM bindings: chatId -> settings */
  dm?: Record<string, TopicSettings>;
  /** Supergroup bindings: chatId -> settings */
  supergroups?: Record<string, TopicSettings>;
}

export interface TopicSettings {
  projectDir?: string;
}

const DEFAULT_SETTINGS: TopicSettingsFile = {
  topics: {},
  dm: {},
  supergroups: {},
};

/**
 * Load topic-settings.json. Returns default if missing or malformed.
 */
export function loadTopicSettings(home: string): TopicSettingsFile {
  try {
    const raw = readFileSync(topicSettingsPath(home), "utf-8");
    return JSON.parse(raw) as TopicSettingsFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_SETTINGS);
    }
    log.warn("malformed topic-settings.json, returning default", { error: String(e) });
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * Save topic settings atomically (write to unique tmp, then rename).
 */
export function saveTopicSettings(home: string, settings: TopicSettingsFile): void {
  const finalPath = topicSettingsPath(home);
  const tmpPath = join(home, `.topic-settings.${randomUUID().slice(0, 8)}.tmp`);

  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
}

/**
 * Build the settings key for a chat surface.
 */
function settingsForLocator(settings: TopicSettingsFile, loc: ChatLocator): TopicSettings | undefined {
  const chatKey = String(loc.chatId);

  if (loc.topicId !== undefined) {
    return settings.topics?.[chatKey]?.[String(loc.topicId)];
  }

  // DMs have positive chatIds, supergroups negative.
  // We look up DM first, then supergroups. The caller knows which kind.
  // Since DMs and supergroups have different ranges, we try both.
  if (settings.dm?.[chatKey]) return settings.dm[chatKey];
  if (settings.supergroups?.[chatKey]) return settings.supergroups[chatKey];
  return undefined;
}

/**
 * Read the projectDir for a chat surface from topic-settings.json.
 * Returns undefined if none is set.
 */
export function getProjectDir(home: string, loc: ChatLocator): string | undefined {
  const settings = loadTopicSettings(home);
  return settingsForLocator(settings, loc)?.projectDir;
}

/**
 * Bind (or clear) a projectDir for a chat surface.
 * Atomically updates topic-settings.json.
 */
export function bindProjectDir(home: string, loc: ChatLocator, projectDir: string | undefined): void {
  const settings = loadTopicSettings(home);
  const chatKey = String(loc.chatId);

  if (loc.topicId !== undefined) {
    settings.topics ??= {};
    settings.topics[chatKey] ??= {};
    const topicKey = String(loc.topicId);
    if (projectDir !== undefined) {
      settings.topics[chatKey]![topicKey] = { projectDir };
    } else {
      delete settings.topics[chatKey]![topicKey];
      if (Object.keys(settings.topics[chatKey]!).length === 0) {
        delete settings.topics[chatKey];
      }
    }
  } else if (loc.chatId < 0) {
    // Supergroup
    settings.supergroups ??= {};
    if (projectDir !== undefined) {
      settings.supergroups[chatKey] = { projectDir };
    } else {
      delete settings.supergroups[chatKey];
    }
  } else {
    // DM
    settings.dm ??= {};
    if (projectDir !== undefined) {
      settings.dm[chatKey] = { projectDir };
    } else {
      delete settings.dm[chatKey];
    }
  }

  saveTopicSettings(home, settings);
  log.info("bound projectDir", { chatId: loc.chatId, topicId: loc.topicId, projectDir });
}
