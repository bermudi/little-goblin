import { personalEnvironment, type ExecutionEnvironment } from "./environment.ts";

/**
 * Reserved identity for a Surface-free background runtime. Delimiters make it
 * disjoint from the ten-hex-character Conversation IDs used by user-visible
 * bindings, so an internal runner cannot silently claim a Conversation ID.
 */
export type InternalSessionId = `__${string}__`;

/**
 * Exact persisted shape for a Surface-free internal runtime. Internal work has
 * no Surface routing, title, preferences, or project authority: those fields
 * would make a compatibility record look like a user-visible Conversation.
 */
export interface InternalSessionState {
  id: InternalSessionId;
  createdAt: string;
  chatId: 0;
  executionEnvironment: Extract<ExecutionEnvironment, { kind: "personal" }>;
}

export function createInternalSessionState(id: InternalSessionId): InternalSessionState {
  assertInternalSessionId(id);
  return {
    id,
    createdAt: new Date().toISOString(),
    chatId: 0,
    executionEnvironment: personalEnvironment(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInternalSessionId(value: unknown): value is InternalSessionId {
  return typeof value === "string" && /^__.+__$/.test(value);
}

/** Validate an internal ID before it reaches any session filesystem path. */
export function assertInternalSessionId(value: unknown): asserts value is InternalSessionId {
  if (!isInternalSessionId(value)) {
    throw new Error("internal session requires a reserved __…__ identity");
  }
}

function isValidCreatedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isPersonalEnvironment(value: unknown): value is Extract<ExecutionEnvironment, { kind: "personal" }> {
  return isRecord(value) && Object.keys(value).length === 1 && value.kind === "personal";
}

/**
 * Validate the complete internal compatibility record before using it. This
 * deliberately rejects every routing, preference, title, project, and legacy
 * field rather than merely checking the fields internal callers happen to use.
 */
export function assertInternalSessionState(value: unknown): asserts value is InternalSessionState {
  if (!isRecord(value)) {
    throw new Error("internal session state must be an object");
  }

  const validKeys = new Set(["id", "createdAt", "chatId", "executionEnvironment"]);
  for (const key of Object.keys(value)) {
    if (!validKeys.has(key)) {
      throw new Error(`internal session has forbidden field: ${key}`);
    }
  }

  assertInternalSessionId(value.id);
  if (!isValidCreatedAt(value.createdAt)) {
    throw new Error("internal session has missing or invalid createdAt");
  }
  if (value.chatId !== 0) {
    throw new Error("internal session requires chatId: 0");
  }
  if (!isPersonalEnvironment(value.executionEnvironment)) {
    throw new Error("internal session requires the exact personal executionEnvironment");
  }
}

