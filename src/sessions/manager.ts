import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { surfaceId, type Surface } from "../surface.ts";
import type { BindingsFile, ChatLocator, SessionState, SurfaceCompatOpts } from "./types.ts";
import { loadBindings, saveBindings } from "./bindings.ts";
import { loadState, saveState } from "./state.ts";
import {
  getProjectDir as getProjectDirFromSettings,
  bindProjectDir as bindProjectDirInSettings,
  consumeProjectNotice as consumeProjectNoticeFromSettings,
} from "./topic-settings.ts";
import { sessionsDir, sessionDir, transcriptPath, metricsPath } from "./paths.ts";
import { surfaceFromLocatorCompat } from "./surface-compat.ts";

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
   * Ensure base directories exist.
   */
  init(): void {
    mkdirSync(sessionsDir(this.home), { recursive: true });
    log.debug("session manager initialized", { home: this.home });
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
  resolve(surface: Surface): SessionState | null;
  /** @deprecated Use surface-based resolve. */
  resolve(loc: ChatLocator, opts?: SurfaceCompatOpts): SessionState | null;
  resolve(input: Surface | ChatLocator, opts?: SurfaceCompatOpts): SessionState | null {
    const surface = "kind" in input ? input : surfaceFromLocatorCompat(input, opts);
    const bindings = loadBindings(this.home);
    const key = surfaceId(surface);
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
  }

  /**
   * Create a new session for a complete Surface and bind it.
   */
  createForSurface(surface: Surface, opts?: { title?: string }): SessionState {
    const id = makeSessionId();
    const state: SessionState = {
      id,
      createdAt: new Date().toISOString(),
      chatId: surface.chatId,
      topicId: surface.kind === "topic" ? surface.topicId : undefined,
      title: opts?.title,
    };

    ensureSessionFiles(this.home, id);
    saveState(this.home, state);

    const bindings = loadBindings(this.home);
    bindings.surfaces[surfaceId(surface)] = id;
    saveBindings(this.home, bindings);

    log.info("created session", { id, kind: surface.kind, surfaceId: surfaceId(surface) });
    return state;
  }

  /** @deprecated Use surface-based createForSurface. */
  createForChat(loc: ChatLocator, opts?: { title?: string } & SurfaceCompatOpts): SessionState {
    return this.createForSurface(surfaceFromLocatorCompat(loc, opts), opts);
  }

  bindExistingToSurface(sessionId: string, surface: Surface): SessionState {
    const state = loadState(this.home, sessionId);
    if (!state) {
      throw new Error(`session not found: ${sessionId}`);
    }

    const bindings = loadBindings(this.home);
    bindings.surfaces[surfaceId(surface)] = sessionId;
    saveBindings(this.home, bindings);
    log.info("bound existing session", { sessionId, surfaceId: surfaceId(surface) });
    return state;
  }

  /** @deprecated Use surface-based bindExistingToSurface. */
  bindExistingToChat(sessionId: string, loc: ChatLocator, opts?: SurfaceCompatOpts): SessionState {
    return this.bindExistingToSurface(sessionId, surfaceFromLocatorCompat(loc, opts));
  }

  /**
   * Archive a session: move `sessions/<id>/` to `sessions/archive/<id>/`
   * and remove every surface binding that references it.
   */
  archive(sessionId: string): void {
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
  }

  /**
   * Get the projectDir for a complete Surface from topic-settings.json.
   */
  getProjectDir(surface: Surface): string | undefined;
  /** @deprecated Use surface-based getProjectDir. */
  getProjectDir(loc: ChatLocator): string | undefined;
  getProjectDir(input: Surface | ChatLocator): string | undefined {
    const surface = typeof input === "object" && "kind" in input ? input : surfaceFromLocatorCompat(input);
    return getProjectDirFromSettings(this.home, surface);
  }

  /**
   * Bind (or clear) the projectDir for a complete Surface.
   */
  bindProjectDir(surface: Surface, projectDir: string | undefined): void;
  /** @deprecated Use surface-based bindProjectDir. */
  bindProjectDir(loc: ChatLocator, projectDir: string | undefined): void;
  bindProjectDir(input: Surface | ChatLocator, projectDir: string | undefined): void {
    const surface = typeof input === "object" && "kind" in input ? input : surfaceFromLocatorCompat(input);
    bindProjectDirInSettings(this.home, surface, projectDir);
  }

  /**
   * Read and clear the pending project notice for a complete Surface.
   */
  consumeProjectNotice(surface: Surface): string | undefined;
  /** @deprecated Use surface-based consumeProjectNotice. */
  consumeProjectNotice(loc: ChatLocator): string | undefined;
  consumeProjectNotice(input: Surface | ChatLocator): string | undefined {
    const surface = typeof input === "object" && "kind" in input ? input : surfaceFromLocatorCompat(input);
    return consumeProjectNoticeFromSettings(this.home, surface);
  }

  /**
   * Updates state.json atomically.
   * @deprecated Use bindProjectDir(surface, dir) instead.
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
   * its captured session surface before dispatch.
   */
  peekBinding(surface: Surface): { sessionId: string; state: SessionState } | null;
  /** @deprecated Use surface-based peekBinding. */
  peekBinding(loc: ChatLocator, opts?: SurfaceCompatOpts): { sessionId: string; state: SessionState } | null;
  peekBinding(input: Surface | ChatLocator, opts?: SurfaceCompatOpts): { sessionId: string; state: SessionState } | null {
    const surface = typeof input === "object" && "kind" in input ? input : surfaceFromLocatorCompat(input as ChatLocator, opts);
    const bindings = loadBindings(this.home);
    const boundId = bindings.surfaces[surfaceId(surface)];
    if (!boundId) return null;
    const state = loadState(this.home, boundId);
    if (!state) return null;
    return { sessionId: boundId, state };
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
