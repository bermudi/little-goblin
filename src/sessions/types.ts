/**
 * Core types for session management.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Surface, SurfaceId } from "../surface.ts";

/** Locator derived from a Telegram context: chat + optional topic. */
export interface ChatLocator {
  chatId: number;
  topicId?: number;
  /** True when the source chat is a private (one-on-one) conversation. */
  isPrivate?: boolean;
}

/** Per-session state persisted in sessions/<id>/state.json */
export interface SessionState {
  id: string;
  createdAt: string; // ISO 8601
  chatId: number;
  topicId?: number;
  title?: string;
  archived?: boolean;
  /**
   * @deprecated Use binding-scoped projectDir via SessionManager.getProjectDir(surface) instead.
   * This field may exist in legacy state.json files but is no longer read or written.
   */
  projectDir?: string;
  /** Session-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Session-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: ThinkingLevel;
}

/** Legacy pre-Surface bindings.json shape. Loaded only by migration. */
export interface LegacyBindingsFile {
  /** DM session bindings: chatId -> sessionId */
  dm?: Record<string, string>;
  /** Topic bindings: chatId -> topicId -> sessionId */
  topics?: Record<string, Record<string, string>>;
  /** Supergroup bindings: chatId -> sessionId (supergroup without topic = single session) */
  supergroups?: Record<string, string>;
  /** Guest session bindings: foreign chatId -> sessionId */
  guest?: Record<string, string>;
}

/** Canonical bindings.json shape. */
export interface BindingsFile {
  version: 1;
  /** SurfaceId -> sessionId */
  surfaces: Record<SurfaceId, string>;
}

export interface TopicSettings {
  projectDir?: string;
  /** Queued notice injected as context on the next user message (e.g. project dir change). Consumed on read. */
  pendingProjectNotice?: string;
}

/** Legacy pre-Surface topic-settings.json shape. Loaded only by migration. */
export interface LegacyTopicSettingsFile {
  /** Topic bindings: chatId -> topicId -> settings */
  topics?: Record<string, Record<string, TopicSettings>>;
  /** DM bindings: chatId -> settings */
  dm?: Record<string, TopicSettings>;
  /** Supergroup bindings: chatId -> settings */
  supergroups?: Record<string, TopicSettings>;
}

/** Canonical topic-settings.json shape. */
export interface TopicSettingsFile {
  version: 1;
  /** SurfaceId -> TopicSettings */
  surfaces: Record<SurfaceId, TopicSettings>;
}

export type { Surface, SurfaceId };

/** Options passed by legacy callers that have not yet migrated to `Surface`. */
export interface SurfaceCompatOpts {
  isSupergroup?: boolean;
  isGuest?: boolean;
}
