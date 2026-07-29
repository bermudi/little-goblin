/**
 * Skill catalog resolution module barrel.
 *
 * Deep module per decision 0034: explicit, scoped skill catalogs with no
 * ambient pi discovery. The resolver maps a SkillPolicy and an
 * ExecutionEnvironment to a frozen ResolvedSkillSet of selected skill files.
 */

export {
  DEFAULT_SKILL_POLICY,
  SkillResolutionError,
  isValidSkillName,
  normalizeSelectedNames,
} from "./types.ts";

export type {
  ResolvedSkill,
  ResolvedSkillDiagnostic,
  ResolvedSkillSet,
  SkillName,
  SkillPolicy,
  SkillSource,
  SourceSelection,
} from "./types.ts";

export { resolveSkillSet } from "./resolver.ts";
