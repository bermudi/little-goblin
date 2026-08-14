/**
 * Skill catalog resolution module barrel.
 *
 * Deep module per decision 0034: explicit, scoped skill catalogs with no
 * ambient pi discovery. The resolver maps a SkillPolicy and an
 * ExecutionEnvironment to a frozen ResolvedSkillSet of selected skill files.
 */

export {
  DEFAULT_SKILL_POLICY,
  SKILL_SOURCES,
  SkillResolutionError,
  cloneSkillPolicy,
  isValidSkillName,
  normalizeSelectedNames,
  normalizeSkillPolicy,
  skillPolicyFingerprint,
  validateSkillPolicy,
} from "./types.ts";

export type {
  ResolvedSkill,
  ResolvedSkillDiagnostic,
  ResolvedSkillSet,
  ResolvedSkillSnapshot,
  SkillName,
  SkillPolicy,
  SkillSource,
  SourceSelection,
} from "./types.ts";

export {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_SNAPSHOT_ENTRIES,
  MAX_SKILL_SNAPSHOT_BYTES,
  MAX_SKILL_SNAPSHOT_CONCURRENCY,
  MAX_TOTAL_SKILL_SNAPSHOT_BYTES,
  resolveSkillSet,
} from "./resolver.ts";
export type { ResolveSkillSetOptions } from "./resolver.ts";

export { materializeSkillSnapshot } from "./materializer.ts";
