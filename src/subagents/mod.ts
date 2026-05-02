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
 * See specs/canon/subagents/spec.md for behavioural requirements and
 * specs/changes/subagent-runtime/ for the original design.
 */

export { SubagentRunner, type SubagentToolFactory } from "./runner.ts";

// Convenience re-export so callers can pull everything from one entry point.
export type {
  NamedAgentDefinition,
  SpawnOptions,
  SubagentHandle,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
  SubagentStatus,
} from "./types.ts";
