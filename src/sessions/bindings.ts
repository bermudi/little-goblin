import type { BindingsFile, LegacyBindingsFile } from "./types.ts";
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

function isCanonicalBindings(value: unknown): value is BindingsFile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.surfaces === "object" && v.surfaces !== null;
}

function isLegacyBindings(value: unknown): value is LegacyBindingsFile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return !("version" in v) && (
    typeof v.dm === "object" ||
    typeof v.topics === "object" ||
    typeof v.supergroups === "object" ||
    typeof v.guest === "object"
  );
}

/**
 * Load the canonical bindings file (state/bindings.json). Returns the default
 * empty canonical shape when the file is missing or malformed.
 *
 * A legacy file (no `version: 1`) is treated as missing; the migration path
 * must read it via `loadLegacyBindings` and convert it before the manager
 * uses this loader.
 */
export function loadBindings(home: string): BindingsFile {
  const raw = loadJsonFile<BindingsFile | LegacyBindingsFile>(pathFor(home), structuredClone(DEFAULT_BINDINGS));
  if (isCanonicalBindings(raw)) {
    return raw;
  }
  return structuredClone(DEFAULT_BINDINGS);
}

/**
 * Save canonical bindings atomically via `atomicWrite` (tmp + fsync + rename).
 */
export function saveBindings(home: string, bindings: BindingsFile): void {
  saveJsonFile(pathFor(home), bindings);
}

/**
 * Load the legacy pre-Surface bindings shape. Used only by migration.
 *
 * Returns a default empty legacy shape when the file is missing, malformed,
 * or already canonical.
 */
export function loadLegacyBindings(home: string): LegacyBindingsFile {
  const raw = loadJsonFile<BindingsFile | LegacyBindingsFile>(pathFor(home), structuredClone(DEFAULT_LEGACY_BINDINGS));
  if (isLegacyBindings(raw)) {
    return {
      dm: raw.dm ?? {},
      topics: raw.topics ?? {},
      supergroups: raw.supergroups ?? {},
      guest: raw.guest ?? {},
    };
  }
  return structuredClone(DEFAULT_LEGACY_BINDINGS);
}
