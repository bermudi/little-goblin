/**
 * Core types for session management.
 */

/** Locator derived from a Telegram context: chat + optional topic. */
export interface ChatLocator {
  chatId: number;
  topicId?: number;
}

/** Per-session state persisted in sessions/<id>/state.json */
export interface SessionState {
  id: string;
  createdAt: string; // ISO 8601
  chatId: number;
  topicId?: number;
  title?: string;
  archived?: boolean;
}

/** Root config.json shape */
export interface BindingsFile {
  /** DM session bindings: chatId -> sessionId */
  dm?: Record<string, string>;
  /** Topic bindings: chatId -> topicId -> sessionId */
  topics?: Record<string, Record<string, string>>;
  /** Supergroup bindings: chatId -> sessionId (supergroup without topic = single session) */
  supergroups?: Record<string, string>;
}
