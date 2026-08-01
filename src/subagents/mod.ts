/**
 * Subagent runtime — public entry point.
 *
 * The runtime is split across cohesive modules:
 *
 *   - `runner.ts`        — `SubagentRunner` compatibility lifecycle owner
 *   - `execution.ts`     — coordinator-side memory/tool/terminal transitions
 *   - `host.ts`          — opaque Pi execution lease and Pi resource mechanics
 *   - `meta.ts`          — `meta.json` persistence + exact history lookup
 *   - `named-agents.ts`  — loader-free named-agent definition loading
 *   - `paths.ts`         — `~/goblin/...` path helpers
 *   - `types.ts`         — shared lifecycle definitions
 *
 * Current behavior is exercised by `mod.test.ts` and `test/*.suite.ts`.
 */

export {
  SubagentRunner,
  type SubagentMemoryStoreFactory,
  type SubagentToolFactory,
} from "./runner.ts";
export {
  PiSubagentHost,
  SubagentExecutionStoppedError,
  SubagentExecutionQuiescenceError,
  type PiSubagentHostOptions,
  type SubagentHost,
  type SubagentExecution,
  type SubagentCustomMessage,
  type SubagentInvocation,
  type SubagentPreparation,
  type SubagentHistory,
  type SubagentResourcePreparation,
} from "./host.ts";

export type {
  GenericSubagentInheritance,
  NamedAgentDefinition,
  SpawnOptions,
  SubagentHandle,
  SubagentHistoryTarget,
  SubagentInfo,
  SubagentInstance,
  SubagentMeta,
  SubagentStatus,
} from "./types.ts";
