/**
 * On-disk persistence for subagent metadata.
 *
 * `meta.json` is the durable record of a subagent's lifecycle: where its
 * pi session lives, who spawned it, what state it ended in. Every transition
 * is committed via `writeMetaAtomic` (tmp + rename) so a crash mid-write
 * never leaves a partial file behind.
 *
 * This module is the persistence boundary. JSON is parsed as `unknown`, then
 * validated before any metadata can influence revival. Missing files are the
 * only absence case; malformed records and filesystem failures propagate.
 */

import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../fs.ts";
import { boundedError, log } from "../log.ts";
import { VALID_NAME_RE } from "./validation.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentsRoot,
} from "./paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type SubagentInstance,
  type SubagentMeta,
  type SubagentRole,
} from "./types.ts";

const SAFE_SUBAGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
const SUBAGENT_STATUSES = ["running", "completed", "cancelled", "error"] as const;

const timestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "must be a valid timestamp",
);

/**
 * Current persisted ActiveScope has only the surface-derived routing facts.
 * The legacy record added one audit-only member with its historical object/null
 * shape. It is accepted at the disk boundary, then removed before any value
 * enters the current TypeScript domain type or is written back.
 */
const activeScopeFieldsSchema = z.object({
  chatId: z.number().int(),
  topicScope: z.union([
    z.literal("general"),
    z.object({ topicId: z.number().int() }).strict(),
  ]),
});

const currentActiveScopeSchema = activeScopeFieldsSchema.strict();
const legacyActiveScopeSchema = activeScopeFieldsSchema
  .extend({
    namedAgent: z
      .object({ name: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

const persistedActiveScopeSchema = z.union([
  currentActiveScopeSchema,
  legacyActiveScopeSchema,
]);

const subagentMetaSchema = z
  .object({
    id: z.string().min(1).regex(SAFE_SUBAGENT_ID_RE, "must be a safe instance ID"),
    role: z.enum(["generic", "named"]),
    name: z.string().nullable(),
    spawnedBy: z.string().min(1).nullable(),
    activeScope: persistedActiveScopeSchema,
    depth: z.number().int().min(1).max(MAX_SUBAGENT_DEPTH),
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    status: z.enum(SUBAGENT_STATUSES).optional(),
    errorMessage: z.string().optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.role === "generic" && meta.name !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "generic records must have name = null",
      });
    }
    if (meta.role === "named" && (meta.name === null || !VALID_NAME_RE.test(meta.name))) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "named records must have a valid named-agent name",
      });
    }
    if (meta.status === "error" && meta.errorMessage === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["errorMessage"],
        message: "error records must include errorMessage",
      });
    }
    if (meta.status !== "error" && meta.errorMessage !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["errorMessage"],
        message: "errorMessage is only valid when status = error",
      });
    }
  });

type PersistedSubagentMeta = z.infer<typeof subagentMetaSchema>;
type PersistedActiveScope = z.infer<typeof persistedActiveScopeSchema>;

/** Strip the legacy audit-only persona field before it can become authority. */
function normalizeActiveScope(scope: PersistedActiveScope): SubagentMeta["activeScope"] {
  return {
    chatId: scope.chatId,
    topicScope: scope.topicScope,
  };
}

function normalizeSubagentMeta(meta: PersistedSubagentMeta): SubagentMeta {
  return {
    ...meta,
    activeScope: normalizeActiveScope(meta.activeScope),
  };
}

export class SubagentMetadataError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Invalid subagent metadata at ${path}: ${detail}`);
    this.name = "SubagentMetadataError";
    this.path = path;
  }
}

export class SubagentMetadataAmbiguityError extends Error {
  readonly id: string;
  readonly paths: readonly string[];

  constructor(id: string, paths: readonly string[]) {
    super(`Ambiguous subagent metadata for ${id}: ${paths.join(", ")}`);
    this.name = "SubagentMetadataAmbiguityError";
    this.id = id;
    this.paths = paths;
  }
}

function metadataError(path: string, detail: string): SubagentMetadataError {
  const error = new SubagentMetadataError(path, detail);
  log.error("subagent metadata rejected", { path, ...boundedError(error) });
  return error;
}

function metadataAmbiguityError(id: string, paths: readonly string[]): SubagentMetadataAmbiguityError {
  const error = new SubagentMetadataAmbiguityError(id, paths);
  log.error("ambiguous subagent metadata", { id, paths, ...boundedError(error) });
  return error;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function notFound(): Error {
  return new Error("Subagent not found");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "record";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

/** Validate an externally supplied instance ID before it reaches a path helper. */
export function assertSafeSubagentId(id: string): void {
  if (!SAFE_SUBAGENT_ID_RE.test(id)) {
    throw metadataError(
      "<requested-id>",
      "instance ID must be a non-empty single safe path segment",
    );
  }
}

interface MetadataExpectation {
  expectedId?: string;
  expectedRole?: SubagentRole;
  expectedName?: string;
}

interface MetadataCandidate {
  path: string;
  dir: string;
  meta: SubagentMeta;
}

/**
 * Parse and validate one metadata record without exposing disk JSON as typed
 * authority. `expected*` values bind the record to the path being inspected.
 */
export function parseSubagentMeta(
  raw: unknown,
  path: string,
  expected: MetadataExpectation = {},
): SubagentMeta {
  const parsed = subagentMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw metadataError(path, formatIssues(parsed.error));
  }

  const meta = normalizeSubagentMeta(parsed.data);
  if (expected.expectedId !== undefined && meta.id !== expected.expectedId) {
    throw metadataError(path, "record id does not match its requested instance id");
  }
  if (expected.expectedRole !== undefined && meta.role !== expected.expectedRole) {
    throw metadataError(path, "record role does not match its containing instance tree");
  }
  if (expected.expectedName !== undefined && meta.name !== expected.expectedName) {
    throw metadataError(path, "record name does not match its named-agent directory");
  }

  return meta;
}

/**
 * Write JSON to disk atomically (tmp + fsync + rename), after validating the
 * complete record. No caller can persist a value that bypasses this boundary.
 */
export function writeMetaAtomic(path: string, meta: SubagentMeta): void {
  const validated = parseSubagentMeta(meta, path);
  atomicWrite(path, JSON.stringify(validated, null, 2));
}

function readMetaCandidate(
  metaPath: string,
  dir: string,
  expected: MetadataExpectation,
): MetadataCandidate | null {
  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf-8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
    log.error("subagent metadata read failed", { path: metaPath, ...boundedError(err) });
    throw err;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw metadataError(metaPath, "record contains malformed JSON");
    }
    throw err;
  }
  return {
    path: metaPath,
    dir,
    meta: parseSubagentMeta(parsedJson, metaPath, expected),
  };
}

/**
 * Read the existing `meta.json`, merge `patch`, validate the result, and
 * atomically replace it. A missing or corrupt current record is an error, not
 * an invitation to reconstruct durable lifecycle authority from memory.
 *
 * Keys set to `undefined` in `patch` are dropped from the merged record (used
 * to clear stale fields like `errorMessage` on revival).
 */
export function persistMetaPatch(instance: SubagentInstance, patch: Partial<SubagentMeta>): void {
  const current = readMetaCandidate(instance.metaPath, instance.dir, {
    expectedId: instance.id,
    expectedRole: instance.role,
    ...(instance.name === null ? {} : { expectedName: instance.name }),
  });
  if (current === null) {
    throw metadataError(instance.metaPath, "metadata file is missing");
  }

  const mergedInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...current.meta, ...patch })) {
    if (value !== undefined) mergedInput[key] = value;
  }
  const merged = parseSubagentMeta(mergedInput, instance.metaPath, {
    expectedId: instance.id,
    expectedRole: instance.role,
    ...(instance.name === null ? {} : { expectedName: instance.name }),
  });
  writeMetaAtomic(instance.metaPath, merged);
}

/**
 * Locate and parse every candidate `meta.json` for an id.
 *
 * A missing candidate is skipped. A present but malformed or mismatched
 * candidate fails the lookup immediately; it must not be hidden by another
 * valid candidate. If more than one valid candidate exists across the generic
 * and named trees, the id is ambiguous and revival is refused.
 */
export function loadSubagentMeta(home: string, id: string): { dir: string; meta: SubagentMeta } {
  assertSafeSubagentId(id);

  const candidates: MetadataCandidate[] = [];
  const genericResult = readMetaCandidate(
    genericSubagentMetaPath(home, id),
    genericSubagentDir(home, id),
    { expectedId: id, expectedRole: "generic" },
  );
  if (genericResult !== null) candidates.push(genericResult);

  let entries: Dirent[] = [];
  try {
    entries = readdirSync(namedAgentsRoot(home), { withFileTypes: true });
  } catch (err) {
    if (!(isNodeErrnoException(err) && err.code === "ENOENT")) {
      log.error("subagent named-agent tree read failed", {
        path: namedAgentsRoot(home),
        ...boundedError(err),
      });
      throw err;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = namedAgentInstanceDir(home, name, id);
    const metaPath = namedAgentInstanceMetaPath(home, name, id);
    const namedResult = readMetaCandidate(metaPath, dir, {
      expectedId: id,
      expectedRole: "named",
      expectedName: name,
    });
    if (namedResult !== null) candidates.push(namedResult);
  }

  if (candidates.length === 0) throw notFound();
  if (candidates.length > 1) {
    throw metadataAmbiguityError(
      id,
      candidates.map((candidate) => candidate.path).sort(),
    );
  }
  const [candidate] = candidates;
  if (candidate === undefined) {
    // The length guard above makes this unreachable; keep the invariant
    // explicit for strict indexed access and future edits.
    throw notFound();
  }
  return { dir: candidate.dir, meta: candidate.meta };
}

/**
 * Find the most recent `.jsonl` session file inside a directory.
 * Returns `null` when the directory or a session file is absent. Other
 * filesystem failures propagate so permission and I/O problems remain
 * diagnosable.
 */
export function findSessionFile(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") return null;
    log.error("subagent session lookup failed", { path: dir, ...boundedError(err) });
    throw err;
  }

  const newest = files[0];
  return newest === undefined ? null : join(dir, newest);
}
