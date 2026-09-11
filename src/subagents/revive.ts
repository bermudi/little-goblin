/**
 * Revival machinery for `SubagentRunner.revive`.
 *
 * Owns:
 *   - the revive-specific rejection type (`SubagentReviveRejectedError`)
 *   - the admission stage (`admitRevival`): every validation the prologue of a
 *     revive performs before any delegated-work reservation or Pi lease,
 *     returned as a validated plan the rest of revive consumes
 *
 * The revive latch itself lives on `SubagentRunner` — it guards runner-owned
 * instance state and is acquired/released/transferred there.
 */

import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { boundedError, log } from "../log.ts";
import {
  DelegatedWorkHost,
  type AttachedDelegatedWorkOwnership,
  type DelegatedRuntimeContext,
  type DelegatedWorkRecord,
} from "../delegated-work/mod.ts";
import type {
  CapturedMemoryContext,
  SurfaceMemoryAuthority,
  SurfaceMemoryCaller,
} from "../memory/mod.ts";
import { environmentCwd, environmentsEqual, personalEnvironment } from "../sessions/environment.ts";
import { topicScopeDir } from "../memory/paths.ts";
import { findSessionFile } from "./meta.ts";
import { loadNamedAgent, NamedAgentNotFoundError } from "./named-agents.ts";
import { namedAgentDir } from "./paths.ts";
import type {
  GenericSubagentInheritance,
  NamedAgentDefinition,
  SubagentHistoryTarget,
  SubagentRole,
} from "./types.ts";

/** Expected user-facing refusal to start a revived invocation. */
export class SubagentReviveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentReviveRejectedError";
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function assertTopicDirectory(home: string, id: string, chatId: number, topicId: number): void {
  const path = topicScopeDir(home, chatId, topicId);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new SubagentReviveRejectedError(
        `Subagent '${id}' topic scope (${chatId}/${topicId}) no longer exists; cannot revive`,
      );
    }
    throw err;
  }
  if (!stats.isDirectory()) {
    throw new SubagentReviveRejectedError(
      `Subagent '${id}' topic scope (${chatId}/${topicId}) is not a directory; cannot revive`,
    );
  }
}

export function genericExecutionCwd(
  inheritance: GenericSubagentInheritance | null,
  home: string,
): string {
  if (inheritance === null) {
    throw new Error("generic subagent requires inherited execution authority");
  }
  return environmentCwd(inheritance.executionEnvironment, home);
}

/**
 * A validated revival plan — every value the post-admission stages of
 * `revive` consume. Produced only after all checks pass; each rejection keeps
 * its exact error type and message.
 */
export interface ReviveAdmission {
  /** Host-owned record for the revived run. */
  record: DelegatedWorkRecord;
  role: SubagentRole;
  displayName: string | null;
  /** Reviving runtime's captured Surface authority for the new invocation. */
  authority: SurfaceMemoryAuthority;
  caller: SurfaceMemoryCaller;
  /** Bridged attached ownership for the revival invocation. */
  delegatedOwnership: AttachedDelegatedWorkOwnership;
  runDir: string;
  /** Exact lexical history target — the host opens this file verbatim. */
  history: SubagentHistoryTarget;
  cwd: string;
  definition: NamedAgentDefinition | null;
  /** Inheritance authority normalized by role: non-null only for generic revivals. */
  inheritance: GenericSubagentInheritance | null;
}

/**
 * Admission stage of `revive`: validates the captured memory authority, the
 * host-owned record, delegated-context agreement, the topic scope directory,
 * and the named-agent definition, and resolves cwd/history — returning the
 * validated plan or throwing the same rejection the inline prologue did.
 */
export function admitRevival(options: {
  goblinHome: string;
  delegatedWorkHost: DelegatedWorkHost;
  parentCapture: CapturedMemoryContext;
  inheritance: GenericSubagentInheritance | null;
  id: string;
  delegatedContext?: DelegatedRuntimeContext;
}): ReviveAdmission {
  const { goblinHome, delegatedWorkHost, parentCapture, inheritance, id } = options;

  if (
    parentCapture.kind !== "surface" ||
    parentCapture.authority.kind !== "surface" ||
    typeof parentCapture.authority.sourceSurfaceId !== "string"
  ) {
    const err = new Error(
      `Revival requires a Surface-backed parent memory context, got ${parentCapture.kind ?? typeof parentCapture}`,
    );
    log.warn("subagent revive rejected: invalid parent authority", boundedError(err));
    throw err;
  }

  // Load the host-owned record. Legacy two-tree lookups are no longer
  // performed at runtime; offline migration moved them into the new store.
  const record = delegatedWorkHost.loadRecord(id);
  if (record === null) {
    throw new SubagentReviveRejectedError("Subagent not found");
  }
  if (record.kind === "external-agent") {
    log.warn("subagent revive rejected: external-agent record", { runId: id });
    throw new SubagentReviveRejectedError("External-agent records cannot be revived as Pi subagents");
  }

  const role: SubagentRole = record.kind === "generic-subagent" ? "generic" : "named";
  const displayName = record.name;

  // A generic revival without the reviving runtime's environment/manifest
  // authority would either run under the wrong CWD or re-run discovery.
  // Both violate decision 0034 and the execution-environment contract.
  if (role === "generic" && inheritance === null) {
    throw new Error(
      `Generic subagent '${id}' revival requires the reviving runtime's resolved skill manifest and execution environment`,
    );
  }

  const runDir = delegatedWorkHost.runDir(id);

  // Find the persisted session file inside the subagent's run directory.
  const sessionFile = findSessionFile(runDir);
  if (sessionFile === null) {
    throw new SubagentReviveRejectedError("Subagent not found");
  }

  // Revival is a new invocation: it inherits the reviving parent runtime's
  // captured Surface authority.
  const authority = parentCapture.authority;
  const caller: SurfaceMemoryCaller =
    role === "named" && displayName !== null
      ? { kind: "named-subagent", name: displayName }
      : { kind: "anonymous-subagent" };

  // Production callers always provide a delegated runtime context. Tests and
  // legacy callers that omit it are bridged to an attached ownership derived
  // from the captured authority.
  let effectiveContext: DelegatedRuntimeContext;
  if (options.delegatedContext !== undefined) {
    effectiveContext = options.delegatedContext;
  } else {
    effectiveContext = {
      ownerConversationId: authority.sourceSurfaceId,
      runtimeId: DelegatedWorkHost.newRuntimeId(),
      originSurfaceId: authority.sourceSurfaceId,
      executionEnvironment: role === "generic" && inheritance !== null
        ? inheritance.executionEnvironment
        : personalEnvironment(),
    };
  }
  const delegatedOwnership: AttachedDelegatedWorkOwnership = {
    ...effectiveContext,
    lifetime: "attached",
    ownershipEpochId: randomUUID(),
  };

  if (delegatedOwnership.originSurfaceId !== authority.sourceSurfaceId) {
    throw new Error("delegated revival Surface does not match captured memory authority");
  }
  if (role === "generic" && inheritance !== null && !environmentsEqual(
    inheritance.executionEnvironment,
    delegatedOwnership.executionEnvironment,
  )) {
    throw new Error("generic delegated revival environment differs from inherited authority");
  }

  // Validate that the topic directory exists if the subagent has a topic scope.
  // This catches archived topics and rejects regular files masquerading as
  // scope containers. Only ENOENT is treated as absence; other stat errors
  // remain diagnostic and propagate to the caller.
  if (authority.activeScope.topicScope !== "general") {
    const chatId = authority.activeScope.chatId;
    const topicId = authority.activeScope.topicScope.topicId;
    assertTopicDirectory(goblinHome, id, chatId, topicId);
  }

  // Determine cwd from the new invocation's authority, just as spawn() does.
  const cwd =
    role === "named" && displayName !== null
      ? namedAgentDir(goblinHome, displayName)
      : genericExecutionCwd(inheritance, goblinHome);

  // Preserve the exact lexical history target. The Pi host opens exactly this
  // file and does not rediscover a latest history.
  const history = { kind: "open" as const, sessionDir: runDir, sessionFile };

  // Rebuild the named-agent definition if the subagent is named.
  let definition: NamedAgentDefinition | null = null;
  if (role === "named" && displayName !== null) {
    try {
      definition = loadNamedAgent(goblinHome, displayName);
    } catch (err) {
      if (err instanceof NamedAgentNotFoundError) {
        throw new SubagentReviveRejectedError(
          `Named agent '${displayName}' definition missing; cannot revive`,
        );
      }
      throw err;
    }
  }

  return {
    record,
    role,
    displayName,
    authority,
    caller,
    delegatedOwnership,
    runDir,
    history,
    cwd,
    definition,
    inheritance: role === "generic" ? inheritance : null,
  };
}
