import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { ChatLocator, SessionState } from "./types.ts";
import { loadBindings, saveBindings } from "./bindings.ts";
import { loadState, saveState } from "./state.ts";
import { eventsPath, sessionsDir, sessionDir, transcriptPath } from "./paths.ts";

/**
 * Generate a short URL-safe session ID from a UUID.
 * 10 chars of hex (0-9a-f), fs-safe. 16^10 ≈ 1.1 trillion combos.
 */
function makeSessionId(): string {
  const hex = randomUUID().replace(/-/g, "");
  return hex.slice(0, 10);
}

function ensureSessionFiles(home: string, id: string): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  // Create empty JSONL files if missing
  const eventsFile = eventsPath(home, id);
  const transcriptFile = transcriptPath(home, id);
  try {
    writeFileSync(eventsFile, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
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

  /**
   * List all sessions by scanning the sessions directory.
   */
  list(): SessionState[] {
    const dir = sessionsDir(this.home);
    try {
      const entries = readdirSync(dir);
      const states: SessionState[] = [];
      for (const id of entries) {
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
