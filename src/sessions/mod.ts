/**
 * Session management module.
 * Responsible for persisting and retrieving conversation state.
 */

export { SessionManager } from "./manager.ts";
export type { SessionState, Surface, SurfaceId } from "./types.ts";
export type { TopicSettings, TopicSettingsFile, LegacyTopicSettingsFile } from "./topic-settings.ts";
export type { BindingsFile, LegacyBindingsFile } from "./types.ts";
export type { ExecutionEnvironment } from "./environment.ts";
export type { ProjectAssignmentResult, RuntimeLifecycle } from "./manager.ts";
