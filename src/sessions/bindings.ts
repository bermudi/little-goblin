import type { BindingsFile, LegacyBindingsFile, SurfaceId } from "./types.ts";
import { parseSurfaceId } from "../surface.ts";
import { isValidConversationId } from "./conversation.ts";
import { configPath } from "./paths.ts";
import { loadJsonFile, saveJsonFile } from "./state-file.ts";

const DEFAULT_BINDINGS: BindingsFile = {
  version: 1,
  surfaces: {},
};

const DEFAULT_LEGACY_BINDINGS: LegacyBindingsFile = {
  dm: {},
  topics: {},
  supergroups: {},
  guest: {},
};

function pathFor(home: string): string {
  return configPath(home);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalBindings(value: unknown): value is BindingsFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.surfaces)) return false;
  return Object.keys(value).every((key) => key === "version" || key === "surfaces");
}

function isLegacyBindings(value: unknown): value is LegacyBindingsFile {
  if (!isRecord(value) || "version" in value) return false;
  return (
    isRecord(value.dm) ||
    isRecord(value.topics) ||
    isRecord(value.supergroups) ||
    isRecord(value.guest)
  );
}

function assertCanonicalBindings(value: unknown, path: string): asserts value is BindingsFile {
  if (!isCanonicalBindings(value)) {
    throw new Error(`invalid canonical bindings file at ${path}`);
  }
}

/**
 * Load the canonical bindings authority. Missing state is an empty map; every
 * present file must be current-version, structurally valid authority. Legacy
 * state belongs to the offline migration command and is never silently
 * replaced by runtime writes.
 */
export function loadBindings(home: string): BindingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown>(path, structuredClone(DEFAULT_BINDINGS));
  if (isLegacyBindings(raw)) {
    throw new Error(`legacy bindings file at ${path} requires offline migration`);
  }
  assertCanonicalBindings(raw, path);
  validateBindings(raw);
  return raw;
}

/** Load only canonical bindings while planning the offline Surface migration. */
export function loadCanonicalBindingsForMigration(home: string): BindingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown>(path, structuredClone(DEFAULT_BINDINGS));
  if (isLegacyBindings(raw)) return structuredClone(DEFAULT_BINDINGS);
  assertCanonicalBindings(raw, path);
  validateBindings(raw);
  return raw;
}

/**
 * Save canonical bindings atomically via `atomicWrite` (tmp + fsync + rename).
 * Validates the at-most-one-binding-per-Conversation rule before writing.
 */
export function saveBindings(home: string, bindings: BindingsFile): void {
  assertCanonicalBindings(bindings, pathFor(home));
  validateBindings(bindings);
  saveJsonFile(pathFor(home), bindings);
}

/**
 * Validate that a bindings object respects the exact canonical schema and the
 * at-most-one-binding-per-Conversation invariant.
 */
export function validateBindings(bindings: BindingsFile): void {
  assertCanonicalBindings(bindings, "bindings");
  const seen = new Map<string, SurfaceId>();
  for (const [surfaceId, conversationId] of Object.entries(bindings.surfaces)) {
    parseSurfaceId(surfaceId);
    if (!isValidConversationId(conversationId)) {
      throw new Error(`invalid conversation id bound to ${surfaceId}: ${String(conversationId)}`);
    }
    const existing = seen.get(conversationId);
    if (existing !== undefined) {
      throw new Error(
        `conversation ${conversationId} is already bound to ${existing}; cannot bind to ${surfaceId}`,
      );
    }
    seen.set(conversationId, surfaceId as SurfaceId);
  }
}

/**
 * Persistent SurfaceId-to-ConversationId map.
 *
 * The file is the single source of truth for bindings. `save` validates the
 * at-most-one-binding-per-Conversation rule before writing.
 */
export interface BindingStore {
  load(): BindingsFile;
  save(bindings: BindingsFile): void;
}

export class FileBindingStore implements BindingStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  load(): BindingsFile {
    return loadBindings(this.home);
  }

  save(bindings: BindingsFile): void {
    saveBindings(this.home, bindings);
  }
}

/**
 * Load the legacy pre-Surface bindings shape. Used only by migration.
 *
 * Returns an empty legacy shape only when the file is missing or already
 * canonical. A malformed legacy file fails the offline migration.
 */
export function loadLegacyBindings(home: string): LegacyBindingsFile {
  const path = pathFor(home);
  const raw = loadJsonFile<unknown | undefined>(path, undefined);
  if (raw === undefined || isCanonicalBindings(raw)) return structuredClone(DEFAULT_LEGACY_BINDINGS);
  if (!isLegacyBindings(raw)) {
    throw new Error(`invalid legacy bindings file at ${path}`);
  }
  return {
    dm: raw.dm ?? {},
    topics: raw.topics ?? {},
    supergroups: raw.supergroups ?? {},
    guest: raw.guest ?? {},
  };
}
