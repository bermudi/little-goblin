/**
 * Session management module.
 * Responsible for persisting and retrieving conversation state.
 */

export { SessionManager } from "./manager.ts";
export { ConversationStore, ensureConversationFiles } from "./conversation-store.ts";
export { makeConversationId, isValidConversationId, validateConversationId, runtimeSession, runtimeSessionWithPreferences } from "./conversation.ts";
export { loadConversationState, saveConversationState } from "./state.ts";
export { assertInternalSessionId, assertInternalSessionState, createInternalSessionState } from "./internal-session.ts";
export type { InternalSessionId, InternalSessionState } from "./internal-session.ts";
export type { ConversationId, ConversationState, SessionState, Surface, SurfaceId } from "./types.ts";
export type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile } from "./topic-settings.ts";
export type { BindingsFile, LegacyBindingsFile } from "./types.ts";
export type { ExecutionEnvironment } from "./environment.ts";
