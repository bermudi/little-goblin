/**
 * Host-owned record store for delegated work.
 *
 * Every delegated run has one stable record under
 * `state/delegated-work/runs/<id>/record.json`: a validated JSON document with
 * an identity section and an append-only invocation log. The invocation log is
 * the durable authority for attached-lifetime ownership, terminal outcome, and
 * delivery state. This module owns the validated atomic-rewrite persistence
 * discipline that previously lived in `subagents/meta.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../fs.ts";
import { boundedError, log } from "../log.ts";
import { parseSurfaceId } from "../surface.ts";
import { VALID_NAME_RE } from "../subagents/validation.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
  delegatedWorkRunsRoot,
} from "./paths.ts";
import type {
  AttachedDelegatedWorkOwnership,
  DelegatedDeliveryState,
} from "./types.ts";

const SAFE_RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

const SUBAGENT_STATUSES = ["running", "completed", "cancelled", "error", "interrupted"] as const;
const DELIVERY_STATES = ["pending", "delivered", "suppressed"] as const;
const KINDS = ["generic-subagent", "named-subagent"] as const;

const executionEnvironmentSchema = z.union([
  z.object({ kind: z.literal("personal") }).strict(),
  z.object({
    kind: z.literal("project"),
    projectRoot: z.string().min(1).refine(isAbsolute, "must be an absolute path"),
  }).strict(),
]);

const surfaceIdSchema = z.string().min(1).refine((value) => {
  try {
    parseSurfaceId(value);
    return true;
  } catch {
    return false;
  }
}, "must be a canonical SurfaceId");

const timestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "must be a valid timestamp",
);

const delegatedWorkOutcomeSchema = z.union([
  z.object({
    kind: z.literal("success"),
    text: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    errorMessage: z.string(),
  }).strict(),
]);

const delegatedWorkInvocationSchema = z.object({
  index: z.number().int().min(0),
  ownerConversationId: z.string().min(1),
  runtimeId: z.string().min(1),
  ownershipEpochId: z.string().min(1),
  lifetime: z.literal("attached"),
  originSurfaceId: surfaceIdSchema,
  executionEnvironment: executionEnvironmentSchema,
  status: z.enum(SUBAGENT_STATUSES),
  outcome: delegatedWorkOutcomeSchema.nullable(),
  deliveryState: z.enum(DELIVERY_STATES),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
}).strict();

const delegatedWorkRecordSchema = z.object({
  id: z.string().min(1).regex(SAFE_RUN_ID_RE, "must be a safe run ID"),
  kind: z.enum(KINDS),
  name: z.string().nullable(),
  depth: z.number().int().min(1).max(3),
  createdAt: timestampSchema,
  invocations: z.array(delegatedWorkInvocationSchema),
}).strict().superRefine((record, ctx) => {
  if (record.kind === "generic-subagent" && record.name !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "generic-subagent records must have name = null",
    });
  }
  if (record.kind === "named-subagent" && (record.name === null || !VALID_NAME_RE.test(record.name))) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "named-subagent records must have a valid agent name",
    });
  }
  for (let i = 0; i < record.invocations.length; i++) {
    const invocation = record.invocations[i];
    if (invocation === undefined) continue;
    if (invocation.index !== i) {
      ctx.addIssue({
        code: "custom",
        path: ["invocations", i, "index"],
        message: "invocation indices must be contiguous starting at 0",
      });
    }
  }
});

export type DelegatedWorkStatus = z.infer<typeof delegatedWorkRecordSchema>["invocations"][number]["status"];
export type DelegatedWorkKind = z.infer<typeof delegatedWorkRecordSchema>["kind"];
export type DelegatedWorkOutcome = z.infer<typeof delegatedWorkOutcomeSchema>;
export type DelegatedWorkInvocation = z.infer<typeof delegatedWorkInvocationSchema>;
export type DelegatedWorkRecord = z.infer<typeof delegatedWorkRecordSchema>;

export class DelegatedWorkRecordError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Invalid delegated work record at ${path}: ${detail}`);
    this.name = "DelegatedWorkRecordError";
    this.path = path;
  }
}

export class DelegatedWorkRecordNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Delegated work record not found: ${id}`);
    this.name = "DelegatedWorkRecordNotFoundError";
    this.id = id;
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "record";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function recordError(path: string, detail: string): DelegatedWorkRecordError {
  const error = new DelegatedWorkRecordError(path, detail);
  log.error("delegated work record rejected", { path, ...boundedError(error) });
  return error;
}

/** Validate an externally supplied run ID before it reaches a path helper. */
export function assertSafeRunId(id: string): void {
  if (!SAFE_RUN_ID_RE.test(id)) {
    throw recordError("<requested-id>", "run ID must be a non-empty single safe path segment");
  }
}

/** Parse and validate one record without exposing disk JSON as typed authority. */
export function parseDelegatedWorkRecord(
  raw: unknown,
  path: string,
  expectedId?: string,
): DelegatedWorkRecord {
  const parsed = delegatedWorkRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw recordError(path, formatIssues(parsed.error));
  }
  if (expectedId !== undefined && parsed.data.id !== expectedId) {
    throw recordError(path, "record id does not match its requested run id");
  }
  return parsed.data;
}

/** Write a record to disk atomically (tmp + fsync + rename), after validating. */
export function writeRecordAtomic(path: string, record: DelegatedWorkRecord): void {
  const validated = parseDelegatedWorkRecord(record, path);
  atomicWrite(path, JSON.stringify(validated, null, 2));
}

export interface RecordStoreResult {
  readonly record: DelegatedWorkRecord;
  readonly runDir: string;
}

/**
 * Host-owned persistence for delegated-run records.
 *
 * The store does not hold runtime state (registrations, fences, or adapter
 * leases). It only owns validated reads and atomic writes to the record file.
 * Lifecycle policy — when to create, append, terminal-close, or reconcile —
 * lives in `DelegatedWorkHost`.
 */
export class DelegatedWorkRecordStore {
  constructor(readonly home: string) {}

  runDir(id: string): string {
    return delegatedWorkRunDir(this.home, id);
  }

  recordPath(id: string): string {
    return delegatedWorkRecordPath(this.home, id);
  }

  private readRecordFile(id: string): DelegatedWorkRecord | null {
    assertSafeRunId(id);
    const path = this.recordPath(id);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
      log.error("delegated work record read failed", { path, ...boundedError(err) });
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw recordError(path, "record contains malformed JSON");
      }
      throw err;
    }
    return parseDelegatedWorkRecord(parsedJson, path, id);
  }

  /** Load an existing record. `ENOENT` returns null; malformed records propagate. */
  load(id: string): DelegatedWorkRecord | null {
    return this.readRecordFile(id);
  }

  /** Require a record to exist. */
  require(id: string): DelegatedWorkRecord {
    const record = this.load(id);
    if (record === null) throw new DelegatedWorkRecordNotFoundError(id);
    return record;
  }

  /**
   * Create a new record with its first attached invocation.
   *
   * The run directory is not created here; the execution coordinator creates it
   * side-by-side with the Pi session so an empty record never sits without its
   * kind-specific state.
   */
  createRecord(
    id: string,
    kind: DelegatedWorkKind,
    name: string | null,
    depth: number,
    ownership: AttachedDelegatedWorkOwnership,
    startedAt = new Date().toISOString(),
  ): RecordStoreResult {
    assertSafeRunId(id);
    const record: DelegatedWorkRecord = {
      id,
      kind,
      name,
      depth,
      createdAt: startedAt,
      invocations: [{
        index: 0,
        ownerConversationId: ownership.ownerConversationId,
        runtimeId: ownership.runtimeId as string,
        ownershipEpochId: ownership.ownershipEpochId,
        lifetime: ownership.lifetime,
        originSurfaceId: ownership.originSurfaceId as string,
        executionEnvironment: ownership.executionEnvironment,
        status: "running",
        outcome: null,
        deliveryState: "pending",
        startedAt,
        completedAt: null,
      }],
    };
    const path = this.recordPath(id);
    writeRecordAtomic(path, record);
    return { record, runDir: this.runDir(id) };
  }

  /**
   * Append a new invocation to an existing record.
   *
   * Revival is always a new invocation; the prior invocation remains
   * terminally closed. The Pi session continues in the same run directory.
   */
  appendInvocation(
    id: string,
    ownership: AttachedDelegatedWorkOwnership,
    startedAt = new Date().toISOString(),
  ): RecordStoreResult {
    assertSafeRunId(id);
    const current = this.require(id);
    const lastInvocation = current.invocations.at(-1);
    if (lastInvocation !== undefined && lastInvocation.status === "running") {
      throw new Error(
        `Cannot append invocation to ${id}: invocation ${lastInvocation.index} is still running`,
      );
    }
    const nextIndex = current.invocations.length;
    const next: DelegatedWorkRecord = {
      ...current,
      invocations: [
        ...current.invocations,
        {
          index: nextIndex,
          ownerConversationId: ownership.ownerConversationId,
          runtimeId: ownership.runtimeId as string,
          ownershipEpochId: ownership.ownershipEpochId,
          lifetime: ownership.lifetime,
          originSurfaceId: ownership.originSurfaceId as string,
          executionEnvironment: ownership.executionEnvironment,
          status: "running",
          outcome: null,
          deliveryState: "pending",
          startedAt,
          completedAt: null,
        },
      ],
    };
    const path = this.recordPath(id);
    writeRecordAtomic(path, next);
    return { record: next, runDir: this.runDir(id) };
  }

  private updateInvocation(
    record: DelegatedWorkRecord,
    index: number,
    mutate: (invocation: DelegatedWorkInvocation) => DelegatedWorkInvocation,
  ): DelegatedWorkRecord {
    if (index < 0 || index >= record.invocations.length) {
      throw new Error(`Invocation index ${index} out of bounds for record ${record.id}`);
    }
    const invocation = record.invocations[index];
    if (invocation === undefined) {
      throw new Error(`Invocation ${index} of record ${record.id} is undefined`);
    }
    const nextInvocations = [...record.invocations];
    nextInvocations[index] = mutate(invocation);
    return { ...record, invocations: nextInvocations };
  }

  /**
   * Close an invocation with a terminal status, outcome, and delivery state.
   *
   * Only the current (last) invocation is closed; historical entries are never
   * rewritten. Attempting to close a non-running invocation is an error.
   */
  closeInvocation(
    id: string,
    index: number,
    status: Extract<DelegatedWorkStatus, "completed" | "cancelled" | "error" | "interrupted">,
    outcome: DelegatedWorkOutcome | null,
    deliveryState: DelegatedDeliveryState,
    completedAt = new Date().toISOString(),
  ): DelegatedWorkRecord {
    const record = this.require(id);
    const next = this.updateInvocation(record, index, (invocation) => {
      if (invocation.status !== "running") {
        throw new Error(
          `Cannot close invocation ${index} of ${id}: already ${invocation.status}`,
        );
      }
      return {
        ...invocation,
        status,
        outcome,
        deliveryState,
        completedAt,
      };
    });
    writeRecordAtomic(this.recordPath(id), next);
    return next;
  }

  /** Update delivery state without changing terminal status. */
  setDeliveryState(
    id: string,
    index: number,
    deliveryState: DelegatedDeliveryState,
  ): DelegatedWorkRecord {
    const record = this.require(id);
    const next = this.updateInvocation(record, index, (invocation) => ({
      ...invocation,
      deliveryState,
    }));
    writeRecordAtomic(this.recordPath(id), next);
    return next;
  }

  /** List every run id that has a valid record file. Malformed records fail loudly. */
  listIds(): string[] {
    const root = delegatedWorkRunsRoot(this.home);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === "ENOENT") return [];
      log.error("delegated work runs directory read failed", { path: root, ...boundedError(err) });
      throw err;
    }

    const ids: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry);
      // Skip non-directory entries. The record file lives inside the run dir.
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch (err) {
        if (isNodeErrnoException(err) && err.code === "ENOENT") continue;
        throw err;
      }
      ids.push(entry);
    }
    return ids.sort();
  }
}
