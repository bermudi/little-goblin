import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { BindingsFile, ChatLocator, SessionState } from "./types.ts";
import { loadBindings, saveBindings } from "./bindings.ts";
import { loadState, saveState } from "./state.ts";
import { getProjectDir as getProjectDirFromSettings, bindProjectDir as bindProjectDirInSettings, consumeProjectNotice as consumeProjectNoticeFromSettings } from "./topic-settings.ts";
import { sessionsDir, sessionDir, transcriptPath } from "./paths.ts";

/**
 * Generate a short URL-safe session ID from a UUID.
 * 10 chars of hex (0-9a-f), fs-safe. 16^10 ≈ 1.1 trillion combos.
 */
function makeSessionId(): string {
  const hex = randomUUID().replace(/-/g, "");
  return hex.slice(0, 10);
}

/**
 * Remove every binding (DM, supergroup, topic) that references the given
 * session id. Returns true iff anything was removed.
 */
function clearBindingsForSession(bindings: BindingsFile, sessionId: string): boolean {
  let changed = false;
  if (bindings.dm) {
    for (const key of Object.keys(bindings.dm)) {
      if (bindings.dm[key] === sessionId) {
        delete bindings.dm[key];
        changed = true;
      }
    }
  }
  if (bindings.supergroups) {
    for (const key of Object.keys(bindings.supergroups)) {
      if (bindings.supergroups[key] === sessionId) {
        delete bindings.supergroups[key];
        changed = true;
      }
    }
  }
  if (bindings.topics) {
    for (const chat of Object.keys(bindings.topics)) {
      const inner = bindings.topics[chat];
      if (!inner) continue;
      for (const tid of Object.keys(inner)) {
        if (inner[tid] === sessionId) {
          delete inner[tid];
          changed = true;
        }
      }
      if (Object.keys(inner).length === 0) delete bindings.topics[chat];
    }
  }
  return changed;
}

function ensureSessionFiles(home: string, id: string): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  // Create empty transcript.jsonl if missing
  const transcriptFile = transcriptPath(home, id);
  try {
    writeFileSync(transcriptFile, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

export class SessionManager {
  private home: string;

  constructor(cfg: Config) {
    this.home = cfg.goblinHome;
  }

  /**
   * Ensure base directories exist.
   */
  init(): void {
    mkdirSync(sessionsDir(this.home), { recursive: true });
    log.debug("session manager initialized", { home: this.home });
  }

  /**
   * Resolve a chat locator to an active session.
   * - Topic messages: auto-create on first resolve (topic = session)
   * - Supergroups: auto-create on first resolve (supergroup = session)
   * - DMs: return null if no active session (user must /new)
   *
   * Stale bindings (binding exists but state.json missing) are treated as absent
   * and auto-heal for topics/supergroups. For DMs, the stale binding is logged and cleared.
   */
  resolve(loc: ChatLocator, opts?: { isSupergroup?: boolean }): SessionState | null {
    const bindings = loadBindings(this.home);
    const chatKey = String(loc.chatId);

    if (loc.topicId !== undefined) {
      // Topic: auto-create and bind if missing or stale
      const topicKey = String(loc.topicId);
      const existingId = bindings.topics?.[chatKey]?.[topicKey];
      if (existingId) {
        const state = loadState(this.home, existingId);
        if (state) return state;
        // Stale binding: state.json missing, fall through to recreate
        log.warn("stale topic binding, recreating session", { chatId: loc.chatId, topicId: loc.topicId, sessionId: existingId });
      }
      // Auto-create
      return this.createForChat(loc);
    }

    // Supergroup (no topic): auto-create like topics
    if (opts?.isSupergroup) {
      const existingId = bindings.supergroups?.[chatKey];
      if (existingId) {
        const state = loadState(this.home, existingId);
        if (state) return state;
        log.warn("stale supergroup binding, recreating session", { chatId: loc.chatId, sessionId: existingId });
      }
      return this.createForChat(loc);
    }

    // DM: must have explicit binding
    const dmId = bindings.dm?.[chatKey];
    if (!dmId) return null;
    const state = loadState(this.home, dmId);
    if (state) return state;
    // Stale binding: clear it and return null
    log.warn("stale DM binding, clearing", { chatId: loc.chatId, sessionId: dmId });
    delete bindings.dm![chatKey];
    saveBindings(this.home, bindings);
    return null;
  }

  /**
   * Create a new session for a chat locator, bind it, and persist.
   * For DMs: rebinding is allowed (old session becomes orphan).
   * For Topics: should not be called if already bound (resolve handles that).
   * For Supergroups: treated like topics (auto-created, bound to chatId).
   */
  createForChat(loc: ChatLocator, opts?: { title?: string; isSupergroup?: boolean }): SessionState {
    const id = makeSessionId();
    const state: SessionState = {
      id,
      createdAt: new Date().toISOString(),
      chatId: loc.chatId,
      topicId: loc.topicId,
      title: opts?.title,
    };

    // Ensure dirs and empty files
    ensureSessionFiles(this.home, id);

    // Persist state
    saveState(this.home, state);

    // Update bindings
    const bindings = loadBindings(this.home);
    const chatKey = String(loc.chatId);

    if (loc.topicId !== undefined) {
      bindings.topics ??= {};
      bindings.topics[chatKey] ??= {};
      bindings.topics[chatKey][String(loc.topicId)] = id;
    } else if (opts?.isSupergroup) {
      bindings.supergroups ??= {};
      bindings.supergroups[chatKey] = id;
    } else {
      bindings.dm ??= {};
      bindings.dm[chatKey] = id;
    }
    saveBindings(this.home, bindings);

    log.info("created session", { id, chatId: loc.chatId, topicId: loc.topicId, isSupergroup: opts?.isSupergroup });
    return state;
  }

  bindExistingToChat(sessionId: string, loc: ChatLocator, opts?: { isSupergroup?: boolean }): SessionState {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const bindings = loadBindings(this.home);
    const chatKey = String(loc.chatId);
    if (loc.topicId !== undefined) {
      bindings.topics ??= {};
      bindings.topics[chatKey] ??= {};
      bindings.topics[chatKey][String(loc.topicId)] = sessionId;
    } else if (opts?.isSupergroup) {
      bindings.supergroups ??= {};
      bindings.supergroups[chatKey] = sessionId;
    } else {
      bindings.dm ??= {};
      bindings.dm[chatKey] = sessionId;
    }
    saveBindings(this.home, bindings);
    log.info("bound existing session", { sessionId, chatId: loc.chatId, topicId: loc.topicId, isSupergroup: opts?.isSupergroup });
    return state;
  }

  /**
   * Archive a session: move `sessions/<id>/` to `sessions/archive/<id>/`
   * and remove every binding that references it.
   *
   * Throws if the source directory does not exist (already archived or
   * unknown id). The caller is expected to detect the already-archived
   * case via `existsSync(sessionDir(...))` first and surface a friendly
   * message; the throw here is a defensive backstop.
   */
  archive(sessionId: string): void {
    const src = sessionDir(this.home, sessionId);
    if (!existsSync(src)) {
      throw new Error(`session not found or already archived: ${sessionId}`);
    }
    const archiveBase = join(sessionsDir(this.home), "archive");
    mkdirSync(archiveBase, { recursive: true });
    const dst = join(archiveBase, sessionId);
    renameSync(src, dst);

    const bindings = loadBindings(this.home);
    const changed = clearBindingsForSession(bindings, sessionId);
    if (changed) saveBindings(this.home, bindings);

    log.info("archived session", { id: sessionId });
  }

  /**
   * Get the projectDir for a chat surface from topic-settings.json.
   */
  getProjectDir(loc: ChatLocator): string | undefined {
    return getProjectDirFromSettings(this.home, loc);
  }

  /**
   * Bind (or clear) the projectDir for a chat surface.
   * Updates topic-settings.json atomically.
   */
  bindProjectDir(loc: ChatLocator, projectDir: string | undefined): void {
    bindProjectDirInSettings(this.home, loc, projectDir);
  }

  /**
   * Read and clear the pending project notice for a chat surface.
   */
  consumeProjectNotice(loc: ChatLocator): string | undefined {
    return consumeProjectNoticeFromSettings(this.home, loc);
  }

  /**
   * Updates state.json atomically.
   * @deprecated Use bindProjectDir(locator, dir) instead.
   */
  setProjectDir(sessionId: string, projectDir: string | undefined): void {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const updated: SessionState = { ...state, projectDir };
    saveState(this.home, updated);
    log.info("set projectDir", { sessionId, projectDir });
  }

  /**
   * Set or clear the session-scoped model override.
   * Updates state.json atomically.
   */
  setModelName(sessionId: string, modelName: string | undefined): void {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const updated: SessionState = { ...state, modelName };
    saveState(this.home, updated);
    log.info("set modelName", { sessionId, modelName });
  }

  setThinkingLevel(sessionId: string, thinkingLevel: SessionState["thinkingLevel"]): void {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const updated: SessionState = { ...state, thinkingLevel: thinkingLevel as SessionState["thinkingLevel"] };
    saveState(this.home, updated);
    log.info("set thinkingLevel", { sessionId, thinkingLevel });
  }

  setTitle(sessionId: string, title: string | undefined): void {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const updated: SessionState = { ...state, title };
    saveState(this.home, updated);
    log.info("set session title", { sessionId, title });
  }

  /**
   * List all sessions by scanning the sessions directory.
   */
  list(): SessionState[] {
    const dir = sessionsDir(this.home);
    try {
      const entries = readdirSync(dir);
      const states: SessionState[] = [];
      for (const id of entries) {
        if (id === "archive") continue; // archived sessions live in their own subtree
        const s = loadState(this.home, id);
        if (s) states.push(s);
      }
      return states.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
}
