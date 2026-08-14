/**
 * Skill catalog resolution types.
 *
 * Decision 0034 establishes four scoped skill catalogs (Goblin, environment,
 * host, named-agent) and a per-Surface selection policy. This module owns the
 * DTOs that cross the resolver boundary. Named-agent catalogs are isolated by
 * the subagent loader and do not flow through this resolver.
 */

/** A skill catalog authority selected by a Surface's SkillPolicy. */
export type SkillSource = "goblin" | "environment" | "host";

/** Stable source order used by policy validation, formatting, and fingerprints. */
export const SKILL_SOURCES: readonly SkillSource[] = ["goblin", "environment", "host"];

/**
 * Agent Skills name validation. Mirrors pi's frontmatter name rule:
 * lowercase alphanumeric and hyphens, bounded length.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A validated skill name used in `selected` SourceSelection. */
export type SkillName = string;

/** True when a string is a valid Agent Skills name. */
export function isValidSkillName(value: unknown): value is SkillName {
  return typeof value === "string" && SKILL_NAME_PATTERN.test(value);
}

/**
 * How a Surface selects skills from one source.
 *
 * - `all` — every skill in the catalog.
 * - `none` — no skills from this catalog.
 * - `selected` — only the named skills; a name absent from the catalog is an
 *   error after resolution.
 */
export type SourceSelection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "selected"; names: readonly SkillName[] };

/**
 * Per-Surface skill selection policy. Each source is selected independently.
 * The resolver applies the policy after loading catalogs and before producing
 * the frozen ResolvedSkillSet.
 */
export type SkillPolicy = Record<SkillSource, SourceSelection>;

/**
 * Default policy: Goblin all, environment all, host none.
 *
 * This object is treated as immutable by callers. Use {@link cloneSkillPolicy}
 * when returning it from a mutable settings boundary.
 */
export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  goblin: { mode: "all" },
  environment: { mode: "all" },
  host: { mode: "none" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Normalize a `selected` names list at the input boundary: validate each name,
 * sort, and deduplicate. Throws on the first invalid name so the caller surfaces
 * a configuration error before resolution begins.
 */
export function normalizeSelectedNames(
  source: SkillSource,
  raw: readonly string[],
): SkillName[] {
  const seen = new Set<SkillName>();
  for (const name of raw) {
    if (!isValidSkillName(name)) {
      throw new SkillResolutionError(
        `invalid skill name in ${source} selection: ${JSON.stringify(name)}`,
      );
    }
    seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Normalize a complete policy at a command/configuration boundary.
 * `selected` is deliberately non-empty; `none` expresses an empty source.
 * Duplicate command arguments are harmless and become one canonical name.
 */
export function normalizeSkillPolicy(raw: unknown): SkillPolicy {
  if (!isRecord(raw) || !hasExactKeys(raw, SKILL_SOURCES)) {
    throw new SkillResolutionError("skill policy must contain goblin, environment, and host selections");
  }

  const policy = {} as SkillPolicy;
  for (const source of SKILL_SOURCES) {
    const rawSelection = raw[source];
    if (!isRecord(rawSelection) || typeof rawSelection.mode !== "string") {
      throw new SkillResolutionError(`invalid ${source} skill selection`);
    }

    if (rawSelection.mode === "all" || rawSelection.mode === "none") {
      if (!hasExactKeys(rawSelection, ["mode"])) {
        throw new SkillResolutionError(`${source} ${rawSelection.mode} selection has unexpected fields`);
      }
      policy[source] = { mode: rawSelection.mode };
      continue;
    }

    if (rawSelection.mode !== "selected" || !hasExactKeys(rawSelection, ["mode", "names"])) {
      throw new SkillResolutionError(`invalid ${source} skill selection mode`);
    }
    if (!Array.isArray(rawSelection.names) || rawSelection.names.some((name) => typeof name !== "string")) {
      throw new SkillResolutionError(`invalid ${source} selected skill names`);
    }
    const names = normalizeSelectedNames(source, rawSelection.names as string[]);
    if (names.length === 0) {
      throw new SkillResolutionError(`${source} selected skill list cannot be empty; use none instead`);
    }
    policy[source] = { mode: "selected", names };
  }
  return policy;
}

/**
 * Validate the exact persisted DTO. Runtime settings are canonical authority,
 * so duplicate or unsorted names are rejected rather than silently rewritten.
 */
export function validateSkillPolicy(value: unknown, label = "skillPolicy"): asserts value is SkillPolicy {
  const normalized = normalizeSkillPolicy(value);
  // normalizeSkillPolicy rejects non-records before returning. Keep the
  // assertion local so the exact persisted-shape checks below stay explicit.
  const record = value as Record<string, unknown>;
  for (const source of SKILL_SOURCES) {
    const original = record[source];
    const canonical = normalized[source];
    if (canonical.mode === "selected" && isRecord(original)) {
      const names = original.names;
      if (JSON.stringify(names) !== JSON.stringify(canonical.names)) {
        throw new SkillResolutionError(`${label}.${source}.names must be sorted and unique`);
      }
    }
  }
}

/** Return a detached policy suitable for crossing a settings/runtime boundary. */
export function cloneSkillPolicy(policy: SkillPolicy): SkillPolicy {
  const canonical = normalizeSkillPolicy(policy);
  return {
    goblin: canonical.goblin.mode === "selected"
      ? { mode: "selected", names: [...canonical.goblin.names] }
      : { ...canonical.goblin },
    environment: canonical.environment.mode === "selected"
      ? { mode: "selected", names: [...canonical.environment.names] }
      : { ...canonical.environment },
    host: canonical.host.mode === "selected"
      ? { mode: "selected", names: [...canonical.host.names] }
      : { ...canonical.host },
  };
}

/** Stable identity for a canonical policy, independent of object identity. */
export function skillPolicyFingerprint(policy: SkillPolicy): string {
  return JSON.stringify(normalizeSkillPolicy(policy));
}

/** A skill selected by the resolver, with source provenance and canonical path. */
export interface ResolvedSkill {
  /** Catalog authority that supplied this skill. */
  readonly source: SkillSource;
  /** Stable skill name from the SKILL.md frontmatter. */
  readonly name: string;
  /** Canonical absolute path to the SKILL.md file. */
  readonly filePath: string;
  /** Immutable bytes captured while the runtime plan was prepared. */
  readonly snapshot?: ResolvedSkillSnapshot;
}

export interface ResolvedSkillSnapshot {
  /** Path of the selected skill file relative to its skill directory. */
  readonly entryPath: string;
  /** Skill-directory resources, encoded so snapshots remain plain immutable data. */
  readonly files: readonly {
    readonly relativePath: string;
    readonly base64: string;
  }[];
}

/**
 * Diagnostic produced while loading a skill catalog. Mirrors pi's
 * SkillDiagnostic shape with source provenance attached.
 */
export interface ResolvedSkillDiagnostic {
  readonly source: SkillSource;
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** Frozen, immutable result of skill catalog resolution. */
export interface ResolvedSkillSet {
  /** Selected skills in stable order, after policy filtering and conflict checks. */
  readonly skills: readonly ResolvedSkill[];
  /** Non-fatal diagnostics from pi's skill parser, with source provenance. */
  readonly diagnostics: readonly ResolvedSkillDiagnostic[];
  /**
   * Stable fingerprint over canonical environment identity, canonical policy,
   * and selected `{source,name,filePath}` tuples. Skill bodies are not hashed.
   */
  readonly fingerprint: string;
}

/** Error raised when skill resolution cannot produce a coherent set. */
export class SkillResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolutionError";
  }
}
