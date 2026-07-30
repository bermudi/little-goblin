/**
 * Core types for session management.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Surface, SurfaceId } from "../surface.ts";
import type { SkillPolicy } from "../agent/skills/types.ts";
import type { ExecutionEnvironment } from "./environment.ts";

/** Migration-only legacy locator shape (chat + optional topic). Not exported from the session module API. */
export interface ChatLocator {
  chatId: number;
  topicId?: number;
  /** True when the source chat is a private (one-on-one) conversation. */
  isPrivate?: boolean;
}

/** A goblin-generated conversation id: 10 lowercase hex characters. */
export type ConversationId = string;

/** Canonical durable Conversation state persisted in sessions/<id>/state.json.
 * Routing, model, and thinking fields are intentionally omitted from the
 * canonical write; they remain available as migration-only legacy reads. */
export interface ConversationState {
  id: ConversationId;
  createdAt: string; // ISO 8601
  title?: string;
  /** Immutable execution environment captured at Conversation creation. */
  executionEnvironment: ExecutionEnvironment;
}

/** Per-session state persisted in sessions/<id>/state.json.
 * @deprecated SessionState is the legacy shape; new code should use ConversationState.
 */
export interface SessionState extends ConversationState {
  chatId: number;
  topicId?: number;
  /**
   * @deprecated Use binding-scoped projectDir via SessionManager.getProjectDir(surface) instead.
   * This field may exist in legacy state.json files but is no longer read or written.
   */
  projectDir?: string;
  /** Session-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Session-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: ThinkingLevel;
  /** Legacy archived flag; canonical archive is a directory move to sessions/archive/. */
  archived?: boolean;
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
  /** Canonical project root. May be a legacy `projectDir` before environment migration runs. */
  projectRoot?: string;
  /** @deprecated Legacy field, present only until environment migration rewrites it to `projectRoot`. */
  projectDir?: string;
  /** Surface-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Surface-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: string;
  /** Surface-owned skill selection policy. Missing means the effective defaults. */
  skillPolicy?: SkillPolicy;
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
