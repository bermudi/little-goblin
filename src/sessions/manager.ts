import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { surfaceId, parseSurfaceId, type Surface } from "../surface.ts";
import type { BindingsFile, SessionState } from "./types.ts";
import { loadBindings, saveBindings } from "./bindings.ts";
import { loadState, saveState } from "./state.ts";
import {
  getProjectRoot,
  bindProjectRoot,
  bindProjectDir as bindProjectDirInSettings,
  consumeProjectNotice as consumeProjectNoticeFromSettings,
} from "./topic-settings.ts";
import { sessionsDir, sessionDir, transcriptPath, metricsPath, piSessionDir } from "./paths.ts";
import {
  type ExecutionEnvironment,
  personalEnvironment,
  projectEnvironment,
  environmentFromProjectRoot,
  environmentsEqual,
  projectRootOf,
} from "./environment.ts";
import {
  loadPendingProjectAssignment,
  savePendingProjectAssignment,
  clearPendingProjectAssignment,
  buildProjectSessionState,
  type ProjectAssignmentIntent,
} from "./project-assignment.ts";
import { withLifecycleTransitionLock } from "../orchestration/lifecycle-transition-lock.ts";

/**
 * Runtime lifecycle host supplied by the caller for assignment. It is used to
 * synchronously invalidate and quiesce a bound personal runtime before the
 * durable assignment intent is persisted.
 */
export interface RuntimeLifecycle {
  /** Dispose the active runtime for `sessionId`, if any. Should be idempotent. */
  disposeRuntime(sessionId: string): Promise<void> | void;
  /** True when the session currently has an active runtime. */
  hasRuntime?(sessionId: string): boolean;
}

export type ProjectAssignmentResult =
  | { kind: "assigned"; session: SessionState; projectRoot: string; previousSessionId?: string }
  | { kind: "already-assigned"; projectRoot: string; session?: SessionState }
  | { kind: "conflict"; currentRoot: string };

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
  mkdirSync(join(dir, "workdir"), { recursive: true });

  // Create empty session JSONL files if missing
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

export class SessionManager {
  private home: string;

  constructor(cfg: Config) {
    this.home = cfg.goblinHome;
  }

  /**
   * Ensure base directories exist and replay any pending project assignment.
   */
  async init(): Promise<void> {
    mkdirSync(sessionsDir(this.home), { recursive: true });
    await withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
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
    return existsSync(join(sessionsDir(this.home), "archive", sessionId));
  }

  /**
   * Resolve a complete Surface to an active session.
   * - `dm`: return null if no explicit binding (user must /new)
   * - `topic`, `supergroup`, `guest`: auto-create on first resolve
   * - Stale bindings are repaired according to the surface kind.
   */
  resolve(surface: Surface): Promise<SessionState | null> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
      const key = surfaceId(surface);
      const bindings = loadBindings(this.home);
      const existingId = bindings.surfaces[key];

      if (surface.kind === "dm") {
        if (!existingId) return null;
        const state = loadState(this.home, existingId);
        if (state) return state;
        log.warn("stale DM binding, clearing", { surfaceId: key, sessionId: existingId });
        delete bindings.surfaces[key];
        saveBindings(this.home, bindings);
        return null;
      }

      // topic, supergroup, guest: auto-create / repair stale binding
      if (existingId) {
        const state = loadState(this.home, existingId);
        if (state) return state;
        log.warn("stale surface binding, recreating session", { surfaceId: key, sessionId: existingId, kind: surface.kind });
      }

      return this.createForSurface(surface);
    });
  }

  /**
   * Create a new session for a complete Surface and bind it.
   */
  createForSurface(surface: Surface, opts?: { title?: string }): Promise<SessionState> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
      const id = makeSessionId();
      const state: SessionState = {
        id,
        createdAt: new Date().toISOString(),
        chatId: surface.chatId,
        topicId: surface.kind === "topic" ? surface.topicId : undefined,
        title: opts?.title,
        executionEnvironment: this.effectiveEnvironment(surface),
      };

      ensureSessionFiles(this.home, id);
      saveState(this.home, state);

      const bindings = loadBindings(this.home);
      bindings.surfaces[surfaceId(surface)] = id;
      saveBindings(this.home, bindings);

      log.info("created session", { id, kind: surface.kind, surfaceId: surfaceId(surface) });
      return state;
    });
  }

  /**
   * Bind an existing session to a Surface. Rejects environment mismatches
   * before changing the binding.
   */
  bindExistingToSurface(sessionId: string, surface: Surface): Promise<SessionState> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
      const state = loadState(this.home, sessionId);
      if (!state) {
        throw new Error(`session not found: ${sessionId}`);
      }

      const surfaceEnv = this.effectiveEnvironment(surface);
      if (!environmentsEqual(state.executionEnvironment, surfaceEnv)) {
        throw new Error(
          `environment mismatch: session ${sessionId} is ${state.executionEnvironment.kind}, surface ${surfaceId(surface)} is ${surfaceEnv.kind}`,
        );
      }

      const bindings = loadBindings(this.home);
      bindings.surfaces[surfaceId(surface)] = sessionId;
      saveBindings(this.home, bindings);
      log.info("bound existing session", { sessionId, surfaceId: surfaceId(surface) });
      return state;
    });
  }

  /**
   * Archive a session: move `sessions/<id>/` to `sessions/archive/<id>/`
   * and remove every surface binding that references it.
   */
  archive(sessionId: string): Promise<void> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
      const src = sessionDir(this.home, sessionId);
      if (!existsSync(src)) {
        throw new Error(`session not found or already archived: ${sessionId}`);
      }
      const state = loadState(this.home, sessionId);
      if (state?.chatId === 0) {
        throw new Error(`cannot archive internal session: ${sessionId}`);
      }
      const archiveBase = join(sessionsDir(this.home), "archive");
      mkdirSync(archiveBase, { recursive: true });
      const dst = join(archiveBase, sessionId);
      renameSync(src, dst);

      const bindings = loadBindings(this.home);
      const changed = clearSessionBindings(bindings, sessionId);
      if (changed) saveBindings(this.home, bindings);

      log.info("archived session", { id: sessionId });
    });
  }

  /**
   * Get the project root for a complete Surface from topic-settings.json.
   * @deprecated Use `effectiveEnvironment(surface)`.
   */
  getProjectDir(surface: Surface): string | undefined {
    return projectRootOf(this.effectiveEnvironment(surface));
  }

  /**
   * Bind (or clear) the project directory for a complete Surface.
   * @deprecated Use `assignProject` for first assignment.
   */
  bindProjectDir(surface: Surface, projectDir: string | undefined): void {
    bindProjectDirInSettings(this.home, surface, projectDir);
  }

  /**
   * Read and clear the pending project notice for a complete Surface.
   */
  consumeProjectNotice(surface: Surface): string | undefined {
    return consumeProjectNoticeFromSettings(this.home, surface);
  }

  /**
   * Assign a canonical project environment to an unassigned Surface, creating
   * and binding a fresh project Conversation. This is the single deep operation
   * for first assignment; callers must not coordinate settings, state,
   * bindings, and runner replacement independently.
   */
  async assignProject(
    surface: Surface,
    requestedRoot: string,
    runtimeLifecycle: RuntimeLifecycle,
  ): Promise<ProjectAssignmentResult> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();

      const key = surfaceId(surface);
      const settingsRoot = getProjectRoot(this.home, surface);
      const existingEnv = environmentFromProjectRoot(settingsRoot);
      const requestedEnv = projectEnvironment(requestedRoot);

      // Already assigned to the same canonical root: idempotent report.
      if (existingEnv.kind === "project" && environmentsEqual(existingEnv, requestedEnv)) {
        const bindings = loadBindings(this.home);
        const boundId = bindings.surfaces[key];
        const boundState = boundId ? loadState(this.home, boundId) : null;
        return { kind: "already-assigned", projectRoot: requestedRoot, session: boundState ?? undefined };
      }

      // Already assigned to a different root: immutable.
      if (existingEnv.kind === "project") {
        return { kind: "conflict", currentRoot: projectRootOf(existingEnv) ?? requestedRoot };
      }

      // Personal/unassigned: proceed with first assignment.
      const bindings = loadBindings(this.home);
      const previousSessionId = bindings.surfaces[key];

      if (previousSessionId) {
        // Synchronously invalidate and quiesce the prior runtime. Failure here
        // leaves no intent and no change to settings/binding.
        try {
          await runtimeLifecycle.disposeRuntime(previousSessionId);
        } catch (err) {
          log.error("prior runtime quiescence failed during project assignment", {
            surfaceId: key,
            previousSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new Error(`Failed to quiesce the current conversation: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const plannedSessionId = this.allocateSessionId();
      const intent: ProjectAssignmentIntent = {
        version: 1,
        surfaceId: key,
        previousSessionId,
        plannedSessionId,
        projectRoot: requestedRoot,
      };
      savePendingProjectAssignment(this.home, intent);

      let state: SessionState;
      try {
        state = this.createOrVerifyProjectSession(surface, plannedSessionId, requestedRoot);
        bindProjectRoot(this.home, surface, requestedRoot);
        const nextBindings = loadBindings(this.home);
        nextBindings.surfaces[key] = plannedSessionId;
        saveBindings(this.home, nextBindings);
        clearPendingProjectAssignment(this.home);
      } catch (err) {
        log.error("project assignment failed after intent persistence", {
          surfaceId: key,
          plannedSessionId,
          projectRoot: requestedRoot,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      return { kind: "assigned", session: state, projectRoot: requestedRoot, previousSessionId };
    });
  }

  private allocateSessionId(): string {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const id = makeSessionId();
      if (!existsSync(sessionDir(this.home, id)) && !existsSync(piSessionDir(this.home, id))) {
        return id;
      }
    }
    throw new Error("unable to allocate a unique session id");
  }

  private createOrVerifyProjectSession(surface: Surface, id: string, projectRoot: string): SessionState {
    const path = sessionDir(this.home, id);
    if (existsSync(path)) {
      const existing = loadState(this.home, id);
      if (!existing) {
        throw new Error(`pending assignment session ${id} exists but has no state`);
      }
      if (!environmentsEqual(existing.executionEnvironment, projectEnvironment(projectRoot))) {
        throw new Error(
          `pending assignment session ${id} exists with a different execution environment`,
        );
      }
      return existing;
    }

    const state: SessionState = buildProjectSessionState(id, surface, projectRoot);
    ensureSessionFiles(this.home, id);
    saveState(this.home, state);
    return state;
  }

  private reconcilePendingAssignments(): void {
    const intent = loadPendingProjectAssignment(this.home);
    if (intent === null) return;

    let surface: Surface;
    try {
      surface = parseSurfaceId(intent.surfaceId);
    } catch (err) {
      log.error("pending assignment has invalid surface id", { surfaceId: intent.surfaceId });
      throw new Error(`pending assignment has invalid surface id: ${intent.surfaceId}`);
    }

    const state = this.createOrVerifyProjectSession(surface, intent.plannedSessionId, intent.projectRoot);
    const settingsRoot = getProjectRoot(this.home, surface);
    if (settingsRoot !== intent.projectRoot) {
      bindProjectRoot(this.home, surface, intent.projectRoot);
    }

    const key = surfaceId(surface);
    const bindings = loadBindings(this.home);
    const boundId = bindings.surfaces[key];
    if (boundId !== state.id) {
      // Acceptable states: unbound, still pointing to the previous session, or absent.
      if (boundId !== undefined && boundId !== intent.previousSessionId) {
        throw new Error(
          `pending assignment replay conflict: surface ${intent.surfaceId} is bound to ${boundId}, expected ${intent.previousSessionId ?? "(none)"} or ${state.id}`,
        );
      }
      bindings.surfaces[key] = state.id;
      saveBindings(this.home, bindings);
    }

    clearPendingProjectAssignment(this.home);
    log.info("replayed pending project assignment", { surfaceId: intent.surfaceId, sessionId: state.id });
  }

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
   * Non-mutating read of the binding for a complete Surface.
   *
   * Used by the scheduler to validate that a captured schedule still targets
   * its captured session surface before dispatch. Runs under the lifecycle lock
   * so pending assignments are replayed before the binding is read.
   */
  peekBinding(surface: Surface): Promise<{ sessionId: string; state: SessionState } | null> {
    return withLifecycleTransitionLock(async () => {
      this.reconcilePendingAssignments();
      const key = surfaceId(surface);
      const bindings = loadBindings(this.home);
      const boundId = bindings.surfaces[key];
      if (!boundId) return null;
      const state = loadState(this.home, boundId);
      if (!state) return null;
      return { sessionId: boundId, state };
    });
  }

  /**
   * Ensure an internal non-chat session exists. Internal sessions are used for
   * background work (e.g. the dreaming subagent) and are never bound to a chat.
   */
  ensureInternal(id: string): SessionState {
    ensureSessionFiles(this.home, id);
    const existing = loadState(this.home, id);
    if (existing !== null) {
      return existing;
    }
    const state: SessionState = {
      id,
      createdAt: new Date().toISOString(),
      chatId: 0,
      title: undefined,
      executionEnvironment: personalEnvironment(),
    };
    saveState(this.home, state);
    log.debug("ensured internal session", { id });
    return state;
  }

  /**
   * List all sessions by scanning the sessions directory. Internal sessions
   * (`chatId === 0`) and archived sessions are skipped.
   */
  list(): SessionState[] {
    const dir = sessionsDir(this.home);
    try {
      const entries = readdirSync(dir);
      const states: SessionState[] = [];
      for (const id of entries) {
        if (id === "archive") continue;
        const s = loadState(this.home, id);
        if (s && s.chatId !== 0) states.push(s);
      }
      return states.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
}

function clearSessionBindings(bindings: BindingsFile, sessionId: string): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(bindings.surfaces)) {
    if (value === sessionId) {
      delete (bindings.surfaces as Record<string, string>)[key];
      changed = true;
    }
  }
  return changed;
}
