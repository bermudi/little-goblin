import type { ChatLocator } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";
import { log } from "../log.ts";

/**
 * Per-chat-surface settings persisted in $GOBLIN_HOME/state/topic-settings.json.
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
 * Non-ENOENT/non-Syntax errors propagate per the fail-loud rule.
 */
export function loadTopicSettings(home: string): TopicSettingsFile {
  return loadJsonFile(topicSettingsPath(home), structuredClone(DEFAULT_SETTINGS));
}

/**
 * Save topic settings atomically (write to unique tmp, then rename).
 */
export function saveTopicSettings(home: string, settings: TopicSettingsFile): void {
  saveJsonFile(topicSettingsPath(home), settings);
}

/**
 * True when a TopicSettings object has no meaningful values.
 */
function isEmptySettings(s: TopicSettings): boolean {
  return !s.projectDir && !s.pendingProjectNotice;
}

/**
 * Build the settings key for a chat surface.
 */
function settingsForLocator(settings: TopicSettingsFile, loc: ChatLocator): TopicSettings | undefined {
  const chatKey = String(loc.chatId);

  if (loc.topicId !== undefined) {
    return settings.topics?.[chatKey]?.[String(loc.topicId)];
  }

  // Branch on sign: DMs are positive, supergroups negative.
  if (loc.chatId < 0) {
    return settings.supergroups?.[chatKey];
  }
  return settings.dm?.[chatKey];
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
/**
 * Mutate a single TopicSettings slot for a locator on a pre-loaded settings object.
 */
function applyToSlot(settings: TopicSettingsFile, loc: ChatLocator, updater: (settings: TopicSettings) => TopicSettings): void {
  const chatKey = String(loc.chatId);

  if (loc.topicId !== undefined) {
    settings.topics ??= {};
    settings.topics[chatKey] ??= {};
    const topicKey = String(loc.topicId);
    settings.topics[chatKey]![topicKey] = updater(settings.topics[chatKey]![topicKey] ?? {});
    if (isEmptySettings(settings.topics[chatKey]![topicKey]!)) {
      delete settings.topics[chatKey]![topicKey];
    }
    if (Object.keys(settings.topics[chatKey]!).length === 0) delete settings.topics[chatKey];
  } else if (loc.chatId < 0) {
    settings.supergroups ??= {};
    settings.supergroups[chatKey] = updater(settings.supergroups[chatKey] ?? {});
    if (isEmptySettings(settings.supergroups[chatKey]!)) {
      delete settings.supergroups[chatKey];
    }
  } else {
    settings.dm ??= {};
    settings.dm[chatKey] = updater(settings.dm[chatKey] ?? {});
    if (isEmptySettings(settings.dm[chatKey]!)) {
      delete settings.dm[chatKey];
    }
  }
}

/**
 * Load, mutate a slot, and save atomically.
 */
function updateSettings(home: string, loc: ChatLocator, updater: (settings: TopicSettings) => TopicSettings): void {
  const settings = loadTopicSettings(home);
  applyToSlot(settings, loc, updater);
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
 * Single load → mutate → save to avoid TOCTOU.
 * Returns undefined if none is pending.
 */
export function consumeProjectNotice(home: string, loc: ChatLocator): string | undefined {
  const settings = loadTopicSettings(home);
  const existing = settingsForLocator(settings, loc);
  if (!existing?.pendingProjectNotice) return undefined;

  const notice = existing.pendingProjectNotice;
  applyToSlot(settings, loc, (s) => {
    const { pendingProjectNotice: _, ...rest } = s;
    return rest;
  });
  saveTopicSettings(home, settings);
  return notice;
}
