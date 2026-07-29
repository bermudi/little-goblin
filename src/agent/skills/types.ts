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
 * Default policy used until `surface-skill-policy` introduces per-Surface
 * selection: Goblin all, environment all, host none.
 */
export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  goblin: { mode: "all" },
  environment: { mode: "all" },
  host: { mode: "none" },
};

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

/** A skill selected by the resolver, with source provenance and canonical path. */
export interface ResolvedSkill {
  /** Catalog authority that supplied this skill. */
  readonly source: SkillSource;
  /** Stable skill name from the SKILL.md frontmatter. */
  readonly name: string;
  /** Canonical absolute path to the SKILL.md file. */
  readonly filePath: string;
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
