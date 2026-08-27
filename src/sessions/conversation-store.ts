import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { environmentsEqual, type ExecutionEnvironment } from "./environment.ts";
import type { ConversationId, ConversationState } from "./types.ts";
import { isValidConversationId, makeConversationId, validateConversationId } from "./conversation.ts";
import { loadConversationState, saveConversationState } from "./state.ts";
import { archiveDir, metricsPath, sessionDir, sessionsDir, statePath, transcriptPath } from "./paths.ts";

/**
 * Initialize the on-disk artifacts for a new conversation in the legacy
 * `state/sessions/<id>/` layout. This is the same layout the pi backend
 * expects; no filesystem rename is introduced by the conversation-lifecycle
 * change.
 */
export function ensureConversationFiles(home: string, id: string): void {
  validateConversationId(id);
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
 * Conversation persistence without binding behavior.
 *
 * Creates, loads, lists, names, and archives conversations under the legacy
 * `state/sessions/<id>/` path. The store never edits bindings.json or
 * surface settings; those are owned by the lifecycle orchestrator.
 */
export class ConversationStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /**
   * Create a new conversation with the given immutable environment and
   * optional title. Generates a unique 10-char hex id.
   */
  create(env: ExecutionEnvironment, title?: string): ConversationState {
    const id = this.allocateId();
    return this.createWithId(env, id, title);
  }

  /**
   * Create a conversation with an explicitly supplied fresh id. The directory
   * must not already exist: only the project-assignment recovery path may
   * complete a partial planned directory.
   */
  createWithId(env: ExecutionEnvironment, id: ConversationId, title?: string): ConversationState {
    validateConversationId(id);
    if (existsSync(sessionDir(this.home, id)) || existsSync(join(archiveDir(this.home), id))) {
      throw new Error(`conversation ${id} already exists`);
    }
    return this.writeNewConversation(env, id, title);
  }

  /**
   * Complete the directory for an ID recorded in a pending project-assignment
   * intent. A present state.json is never absence: callers must first load and
   * verify it. The only recoverable partial directory contains zero or more of
   * the empty JSONL files written before state.json, with no other artifacts.
   */
  createPlannedWithId(env: ExecutionEnvironment, id: ConversationId, title?: string): ConversationState {
    validateConversationId(id);
    if (existsSync(join(archiveDir(this.home), id))) {
      throw new Error(`planned conversation ${id} is already archived`);
    }
    if (existsSync(statePath(this.home, id))) {
      throw new Error(`planned conversation ${id} already has state.json`);
    }
    this.assertRecoverablePlannedDirectory(id);
    return this.writeNewConversation(env, id, title);
  }

  private writeNewConversation(env: ExecutionEnvironment, id: ConversationId, title?: string): ConversationState {
    ensureConversationFiles(this.home, id);
    const state: ConversationState = {
      id,
      createdAt: new Date().toISOString(),
      title,
      executionEnvironment: env,
    };
    saveConversationState(this.home, state);
    log.info("created conversation", { id, kind: env.kind });
    return state;
  }

  private assertRecoverablePlannedDirectory(id: ConversationId): void {
    const dir = sessionDir(this.home, id);
    if (!existsSync(dir)) return;
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`planned conversation ${id} path is not a directory`);
    }
    const allowed = new Set(["transcript.jsonl", "metrics.jsonl", "events.jsonl"]);
    for (const entry of readdirSync(dir)) {
      if (!allowed.has(entry)) {
        throw new Error(`planned conversation ${id} has unexpected partial artifact: ${entry}`);
      }
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== 0) {
        throw new Error(`planned conversation ${id} partial artifact is invalid: ${entry}`);
      }
    }
  }

  /**
   * Load a canonical conversation. Returns null if missing; throws if the
   * record exists but lacks a valid execution environment.
   */
  load(id: ConversationId): ConversationState | null {
    return loadConversationState(this.home, id);
  }

  /**
   * List non-archived canonical Conversations, optionally filtered to a
   * compatible execution environment. Reserved internal IDs are not valid
   * Conversation directory names and are ignored by the ID scan.
   */
  list(envFilter?: ExecutionEnvironment): ConversationState[] {
    const dir = sessionsDir(this.home);
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }

    const states: ConversationState[] = [];
    for (const id of ids) {
      if (id === "archive") continue;
      if (!isValidConversationId(id)) continue;

      const conv = this.load(id as ConversationId);
      if (conv === null) continue;

      if (envFilter !== undefined && !environmentsEqual(conv.executionEnvironment, envFilter)) {
        continue;
      }
      states.push(conv);
    }

    return states.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * Update a conversation's title. Throws if the conversation does not exist.
   */
  setTitle(id: ConversationId, title: string | undefined): void {
    const state = this.load(id);
    if (state === null) {
      throw new Error(`conversation not found: ${id}`);
    }
    const updated: ConversationState = { ...state, id, title };
    saveConversationState(this.home, updated);
    log.info("set conversation title", { id, title });
  }

  /**
   * Archive a conversation by moving `state/sessions/<id>/` to
   * `state/sessions/archive/<id>/`. Does not edit bindings.
   */
  archive(id: ConversationId): void {
    validateConversationId(id);
    const src = sessionDir(this.home, id);
    if (!existsSync(src)) {
      throw new Error(`conversation not found or already archived: ${id}`);
    }
    const archiveBase = archiveDir(this.home);
    mkdirSync(archiveBase, { recursive: true });
    const dst = join(archiveBase, id);
    if (existsSync(dst)) {
      throw new Error(`conversation ${id} is already archived`);
    }
    renameSync(src, dst);
    log.info("archived conversation", { id });
  }

  /** Delete a conversation and its artifacts. Used to roll back an empty
   * creation whose bootstrap admission was rejected (shutdown). */
  deleteConversation(id: ConversationId): void {
    validateConversationId(id);
    const src = sessionDir(this.home, id);
    const archivePath = join(archiveDir(this.home), id);
    try {
      if (existsSync(src)) {
        rmSync(src, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      if (existsSync(archivePath)) {
        rmSync(archivePath, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    log.info("deleted conversation", { id });
  }

  allocateId(): ConversationId {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const id = makeConversationId();
      if (!existsSync(sessionDir(this.home, id)) && !existsSync(join(archiveDir(this.home), id))) {
        return id;
      }
    }
    throw new Error("unable to allocate a unique conversation id");
  }
}
