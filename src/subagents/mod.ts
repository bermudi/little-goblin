/**
 * Subagent runtime — public entry point.
 *
 * The runtime is split across cohesive modules:
 *
 *   - `runner.ts`        — `SubagentRunner` class (lifecycle orchestrator)
 *   - `execution.ts`     — drives an instance to a terminal state
 *   - `meta.ts`          — `meta.json` persistence + session-file lookup
 *   - `named-agents.ts`  — named-agent loading + ResourceLoader construction
 *   - `paths.ts`         — `~/goblin/...` path helpers
 *   - `types.ts`         — shared type definitions
 *
 * Current behavior is exercised by `mod.test.ts` and `test/*.suite.ts`.
 * Historical design: `specs/changes/archive/2026-04-26-subagent-runtime/`.
 */

export { SubagentRunner, type SubagentToolFactory } from "./runner.ts";

// Convenience re-export so callers can pull everything from one entry point.
export type {
  GenericSubagentInheritance,
  NamedAgentDefinition,
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
  SubagentStatus,
} from "./types.ts";
