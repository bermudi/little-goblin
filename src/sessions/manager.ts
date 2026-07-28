import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { surfaceId, parseSurfaceId, type Surface } from "../surface.ts";
import type { SessionState, ConversationState, ConversationId } from "./types.ts";
import { FileBindingStore } from "./bindings.ts";
import { loadState, saveState } from "./state.ts";
import { getProjectRoot } from "./topic-settings.ts";
import { sessionsDir, sessionDir, transcriptPath, metricsPath } from "./paths.ts";
import {
  type ExecutionEnvironment,
  environmentFromProjectRoot,
  environmentsEqual,
} from "./environment.ts";
import { assertInternalSessionId, assertInternalSessionState, createInternalSessionState, type InternalSessionId, type InternalSessionState } from "./internal-session.ts";
import { reconcilePendingProjectAssignment } from "./project-assignment.ts";
import { withLifecycleTransitionLock } from "../orchestration/lifecycle-transition-lock.ts";
import { ConversationStore } from "./conversation-store.ts";
import { runtimeSessionWithPreferences } from "./conversation.ts";
import { isValidConversationId } from "./conversation.ts";

/**
 * Create empty on-disk artifacts for a session directory. Internal sessions
 * (e.g. dreaming) use this directly because they are not canonical
 * Conversations and do not participate in ConversationStore.load/list.
 */
function ensureSessionFiles(home: string, id: string): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });

  const transcriptFile = transcriptPath(home, id);
  try {
    writeFileSync(transcriptFile, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const metricsFile = metricsPath(home, id);
  try {
    writeFileSync(metricsFile, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const eventsFile = join(dir, "events.jsonl");
  try {
    writeFileSync(eventsFile, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/**
 * @deprecated Transitional compatibility facade. New binding and lifecycle
 * mutations must use ConversationLifecycle; this class remains only for
 * scheduler inspection, internal sessions, and legacy runtime callers.
 */
export class SessionManager {
  private readonly home: string;
  private readonly store: ConversationStore;
  private readonly bindingStore: FileBindingStore;

  constructor(cfg: Config) {
    this.home = cfg.goblinHome;
    this.store = new ConversationStore(this.home);
    this.bindingStore = new FileBindingStore(this.home);
  }

  /**
   * Ensure base directories exist and replay any pending project assignment.
   */
  async init(): Promise<void> {
    mkdirSync(sessionsDir(this.home), { recursive: true });
    await withLifecycleTransitionLock(async () => {
      reconcilePendingProjectAssignment(this.home, this.store, this.bindingStore);
    });
    log.debug("session manager initialized", { home: this.home });
  }

  /**
   * Resolve a complete Surface to an effective execution environment.
   * An unassigned Surface is personal; an assigned Surface is the canonical
   * project environment stored in topic-settings.json.
   */
  effectiveEnvironment(surface: Surface): ExecutionEnvironment {
    const root = getProjectRoot(this.home, surface);
    return environmentFromProjectRoot(root);
  }

  /**
   * Precisely determine whether a session was archived via `archive()` — i.e.
   * its directory now lives under `sessions/archive/<id>/`. This is a single
   * `existsSync`, not a directory scan, so it is cheap to call per due
   * schedule.
   */
  isArchived(sessionId: string): boolean {
    // Avoid path traversal on the archive check; callers pass conversation ids.
    if (!isValidConversationId(sessionId)) return false;
    return existsSync(join(sessionsDir(this.home), "archive", sessionId));
  }

  /**
   * Update a session title. The change is persisted in canonical conversation
   * state; runtime fields are rebuilt on the next load.
   */
  setTitle(sessionId: string, title: string | undefined): void {
    if (!isValidConversationId(sessionId)) {
      throw new Error(`session not found: ${sessionId}`);
    }
    this.store.setTitle(sessionId as ConversationId, title);
    log.info("set session title", { sessionId, title });
  }

  /**
   * Non-mutating read of the binding for a complete Surface.
   *
   * Used by the scheduler to validate that a captured schedule still targets
   * its captured session surface before dispatch. Runs under the lifecycle lock
   * so pending assignments are replayed before the binding is read.
   */
  peekBinding(surface: Surface): Promise<{ sessionId: string; state: SessionState } | null> {
    return withLifecycleTransitionLock(async () => {
      reconcilePendingProjectAssignment(this.home, this.store, this.bindingStore);
      const key = surfaceId(surface);
      const bindings = this.bindingStore.load();
      const boundId = bindings.surfaces[key];
      if (!boundId || !isValidConversationId(boundId)) return null;
      const conv = this.store.load(boundId as ConversationId);
      if (!conv) return null;
      const env = this.effectiveEnvironment(surface);
      if (!environmentsEqual(conv.executionEnvironment, env)) return null;
      return { sessionId: boundId, state: this.runtimeSession(conv, surface) };
    });
  }

  /**
   * Ensure an internal non-chat session exists. Internal sessions are used for
   * background work (e.g. the dreaming subagent) and are never bound to a chat.
   */
  ensureInternal(id: InternalSessionId): InternalSessionState {
    assertInternalSessionId(id);
    const existing = loadState(this.home, id);
    if (existing !== null) {
      assertInternalSessionState(existing);
      return existing;
    }
    ensureSessionFiles(this.home, id);
    const state = createInternalSessionState(id);
    saveState(this.home, state);
    log.debug("ensured internal session", { id });
    return state;
  }

  /**
   * List all bound user sessions. Unbound and internal sessions (`chatId === 0`)
   * are skipped; the runtime address is rebuilt from the current binding.
   */
  list(): SessionState[] {
    const bindings = this.bindingStore.load();
    const states: SessionState[] = [];
    for (const [surfaceKey, convId] of Object.entries(bindings.surfaces)) {
      if (!isValidConversationId(convId)) continue;
      const conv = this.store.load(convId as ConversationId);
      if (!conv) continue;
      try {
        const surface = parseSurfaceId(surfaceKey);
        states.push(this.runtimeSession(conv, surface));
      } catch {
        continue;
      }
    }
    return states.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private runtimeSession(conv: ConversationState, surface: Surface): SessionState {
    return runtimeSessionWithPreferences(conv, surface, this.home);
  }
}
