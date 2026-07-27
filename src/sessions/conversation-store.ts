import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { environmentsEqual, type ExecutionEnvironment } from "./environment.ts";
import type { ConversationId, ConversationState, SessionState } from "./types.ts";
import { isValidConversationId, makeConversationId, validateConversationId } from "./conversation.ts";
import { isValidExecutionEnvironment, loadConversationState, saveConversationState } from "./state.ts";
import { loadJsonFile } from "./state-file.ts";
import { metricsPath, sessionDir, sessionsDir, statePath, transcriptPath } from "./paths.ts";

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
   * Create a conversation with an explicitly supplied id. The caller must own
   * id allocation and uniqueness (e.g. project-assignment uses a planned id
   * for crash recovery). Throws if the id is already in use.
   */
  createWithId(env: ExecutionEnvironment, id: ConversationId, title?: string): ConversationState {
    validateConversationId(id);
    if (existsSync(sessionDir(this.home, id)) || existsSync(join(sessionsDir(this.home), "archive", id))) {
      throw new Error(`conversation ${id} already exists`);
    }
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

  /**
   * Load a canonical conversation. Returns null if missing; throws if the
   * record exists but lacks a valid execution environment.
   */
  load(id: ConversationId): ConversationState | null {
    return loadConversationState(this.home, id);
  }

  /**
   * List non-archived, non-internal conversations, optionally filtered to a
   * compatible execution environment. Sorted by creation time ascending.
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

      const raw = loadJsonFile<SessionState | null>(statePath(this.home, id), null);
      if (raw === null) continue;
      if (!isValidExecutionEnvironment(raw.executionEnvironment)) continue;
      if (raw.chatId === 0) continue; // internal (e.g. dreaming) conversations are not user-resumable

      if (envFilter !== undefined && !environmentsEqual(raw.executionEnvironment, envFilter)) {
        continue;
      }
      if (raw.id !== undefined && raw.id !== id) {
        throw new Error(`conversation ${id} state file id mismatch: ${String(raw.id)}`);
      }

      states.push({
        id: id as ConversationId,
        createdAt: raw.createdAt,
        title: raw.title,
        executionEnvironment: raw.executionEnvironment,
      });
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
    const archiveBase = join(sessionsDir(this.home), "archive");
    mkdirSync(archiveBase, { recursive: true });
    const dst = join(archiveBase, id);
    if (existsSync(dst)) {
      throw new Error(`conversation ${id} is already archived`);
    }
    renameSync(src, dst);
    log.info("archived conversation", { id });
  }

  allocateId(): ConversationId {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const id = makeConversationId();
      if (!existsSync(sessionDir(this.home, id)) && !existsSync(join(sessionsDir(this.home), "archive", id))) {
        return id;
      }
    }
    throw new Error("unable to allocate a unique conversation id");
  }
}


