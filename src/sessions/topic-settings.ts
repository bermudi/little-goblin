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
  /** Queued notice injected as context on the next user message (e.g. project dir change). Consumed on read. */
  pendingProjectNotice?: string;
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
 * Update a single TopicSettings slot for a locator, persisting atomically.
 */
function updateSettings(home: string, loc: ChatLocator, updater: (settings: TopicSettings) => TopicSettings): void {
  const settings = loadTopicSettings(home);
  const chatKey = String(loc.chatId);

  if (loc.topicId !== undefined) {
    settings.topics ??= {};
    settings.topics[chatKey] ??= {};
    const topicKey = String(loc.topicId);
    settings.topics[chatKey]![topicKey] = updater(settings.topics[chatKey]![topicKey] ?? {});
    // Prune empty
    if (!settings.topics[chatKey]![topicKey]?.projectDir && !settings.topics[chatKey]![topicKey]?.pendingProjectNotice) {
      delete settings.topics[chatKey]![topicKey];
    }
    if (Object.keys(settings.topics[chatKey]!).length === 0) delete settings.topics[chatKey];
  } else if (loc.chatId < 0) {
    settings.supergroups ??= {};
    settings.supergroups[chatKey] = updater(settings.supergroups[chatKey] ?? {});
    if (!settings.supergroups[chatKey]?.projectDir && !settings.supergroups[chatKey]?.pendingProjectNotice) {
      delete settings.supergroups[chatKey];
    }
  } else {
    settings.dm ??= {};
    settings.dm[chatKey] = updater(settings.dm[chatKey] ?? {});
    if (!settings.dm[chatKey]?.projectDir && !settings.dm[chatKey]?.pendingProjectNotice) {
      delete settings.dm[chatKey];
    }
  }

  saveTopicSettings(home, settings);
}

/**
 * Bind (or clear) a projectDir for a chat surface.
 * Atomically updates topic-settings.json. Sets a pending notice
 * that will be injected as context on the next user message.
 */
export function bindProjectDir(home: string, loc: ChatLocator, projectDir: string | undefined): void {
  const notice = projectDir !== undefined
    ? `Project directory changed to \`${projectDir}\`.`
    : undefined;
  updateSettings(home, loc, (s) => ({ ...s, projectDir: projectDir, pendingProjectNotice: notice }));
  log.info("bound projectDir", { chatId: loc.chatId, topicId: loc.topicId, projectDir });
}

/**
 * Read and clear the pending project notice for a chat surface.
 * Returns undefined if none is pending.
 */
export function consumeProjectNotice(home: string, loc: ChatLocator): string | undefined {
  const settings = loadTopicSettings(home);
  const existing = settingsForLocator(settings, loc);
  if (!existing?.pendingProjectNotice) return undefined;

  const notice = existing.pendingProjectNotice;
  updateSettings(home, loc, (s) => {
    const { pendingProjectNotice: _, ...rest } = s;
    return rest;
  });
  return notice;
}
