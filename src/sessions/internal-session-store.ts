import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import {
  assertInternalSessionId,
  assertInternalSessionState,
  createInternalSessionState,
  type InternalSessionId,
  type InternalSessionState,
} from "./internal-session.ts";
import { metricsPath, sessionDir, transcriptPath } from "./paths.ts";
import { loadInternalSessionState, saveInternalSessionState } from "./state.ts";

function ensureEmptyFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function ensureInternalArtifacts(home: string, id: InternalSessionId): void {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  ensureEmptyFile(transcriptPath(home, id));
  ensureEmptyFile(metricsPath(home, id));
  ensureEmptyFile(join(dir, "events.jsonl"));
}

/**
 * Persistence owner for Surface-free internal runtime compatibility state.
 *
 * Internal sessions are not Conversations and never participate in bindings,
 * ConversationLifecycle, or ConversationStore enumeration. This store owns
 * their reserved identity validation and complete on-disk artifact creation.
 */
export class InternalSessionStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /** Ensure an internal runtime record and its JSONL artifacts exist. */
  ensure(id: InternalSessionId): InternalSessionState {
    assertInternalSessionId(id);
    const existing = loadInternalSessionState(this.home, id);
    if (existing !== null) {
      assertInternalSessionState(existing);
      ensureInternalArtifacts(this.home, id);
      return existing;
    }

    ensureInternalArtifacts(this.home, id);
    const state = createInternalSessionState(id);
    saveInternalSessionState(this.home, state);
    log.debug("ensured internal session", { id });
    return state;
  }
}
