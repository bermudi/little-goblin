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
  /**
   * @deprecated Use binding-scoped projectDir via SessionManager.getProjectDir(locator) instead.
   * This field may exist in legacy state.json files but is no longer read or written.
   */
  projectDir?: string;
  /** Session-scoped model override. Falls back to config default when absent. */
  modelName?: string;
  /** Session-scoped thinking level override. Falls back to model default when absent. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

/** Root config.json shape */
export interface BindingsFile {
  /** DM session bindings: chatId -> sessionId */
  dm?: Record<string, string>;
  /** Topic bindings: chatId -> topicId -> sessionId */
  topics?: Record<string, Record<string, string>>;
  /** Supergroup bindings: chatId -> sessionId (supergroup without topic = single session) */
  supergroups?: Record<string, string>;
  /** Guest session bindings: foreign chatId -> sessionId (chat the bot was summoned in but is not a member of) */
  guest?: Record<string, string>;
}
