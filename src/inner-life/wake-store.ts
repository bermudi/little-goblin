/**
 * Deployment-owned wake-record store for private reflection (decision 0035).
 *
 * One light-sleep batch is one durable, versioned wake record under
 * `state/inner-life/wakes/<wakeId>.json`. The record carries stable identity,
 * the source Conversation window, immutable bounded transcript input with
 * event-time provenance, the code-selected capability profile, lifecycle
 * state, and the persisted attempt count. This module owns record I/O
 * exclusively; callers never touch the files.
 *
 * Persistence discipline:
 * - initial reservation uses exclusive creation (`"wx"`): an atomic
 *   no-overwrite reservation, not a replacement. A duplicate window lands on
 *   the same deterministic id and either coalesces (same input fingerprint)
 *   or is rejected as a conflict.
 * - every later transition uses mode-preserving tmp + fsync + rename
 *   replacement (`atomicWrite`), so readers only ever see complete records.
 *
 * Failure discipline (fail loud): absence (ENOENT) is expected and returns
 * null; corrupt JSON, unknown versions, invalid ids, and every non-ENOENT
 * filesystem error propagate with bounded, wake-identity-bearing diagnostics.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "../fs.ts";
import { boundedError, log } from "../log.ts";
import { parseSurfaceId } from "../surface.ts";
import { SAFE_WAKE_ID_RE, wakeRecordPath, wakesDir } from "./paths.ts";

// ---------------------------------------------------------------------------
// Bounds and constants
// ---------------------------------------------------------------------------

export const WAKE_RECORD_VERSION = 1;

/** Serialized transcript input cap: 256 KiB of UTF-8 JSON for `input.lines`. */
export const MAX_WAKE_INPUT_BYTES = 256 * 1024;

/** Total persisted reflection attempts per wake before the batch stays failed. */
export const MAX_WAKE_ATTEMPTS = 3;

/**
 * Default bound on captured lines per wake. Mirrors the existing configured
 * light-sleep line batch limit (`GOBLIN_MEMORY_DREAM_MAX_MODEL_LINES`,
 * default 100); callers may pass the deployment's configured value.
 */
export const DEFAULT_MAX_WAKE_INPUT_LINES = 100;

/** Bounded failure diagnostics: no unbounded free text in records. */
export const MAX_WAKE_FAILURE_REASON_CHARS = 2000;

/** Maximum number of accepted fact intents in one wake. */
export const MAX_FACT_PROPOSALS = 32;

/** Maximum length of one accepted fact excerpt, in characters. */
export const MAX_FACT_TEXT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface WakeProfile {
  readonly id: string;
  readonly version: number;
}

/**
 * The code-owned version-1 private-facts profile. The only capability profile
 * a wake record may carry in this slice; model output can never mint another.
 */
export const PRIVATE_FACTS_PROFILE: WakeProfile = { id: "private-facts", version: 1 };

function isKnownWakeProfile(profile: WakeProfile): boolean {
  return profile.id === PRIVATE_FACTS_PROFILE.id && profile.version === PRIVATE_FACTS_PROFILE.version;
}

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

const wakeRoleSchema = z.enum(["user", "assistant", "toolResult", "unknown"]);

const surfaceIdSchema = z.string().min(1).refine((value) => {
  try {
    parseSurfaceId(value);
    return true;
  } catch {
    return false;
  }
}, "must be a canonical SurfaceId");

// Persisted timestamps are pinned to the canonical `new Date().toISOString()`
// shape every in-repo producer emits. The regex alone would accept shape-valid
// nonsense (month 13, hour 25), so `Date.parse` stays as the semantic check —
// but never again as the only one: it tolerates locale-dependent formats like
// "March 5, 2026" that are not ISO timestamps at all.
const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const timestampSchema = z.string().refine(
  (value) => ISO_UTC_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value)),
  "must be a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
);

const wakeInputLineSchema = z.object({
  index: z.number().int().min(0),
  role: wakeRoleSchema,
  text: z.string(),
  ts: timestampSchema,
  sourceSurfaceId: surfaceIdSchema.optional(),
}).strict();

const wakeProfileSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
}).strict();

const wakeStateSchema = z.enum(["reserved", "reflecting", "applying", "completed", "failed"]);

const wakeInputSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters"),
  lines: z.array(wakeInputLineSchema).min(1),
}).strict();

/**
 * One accepted effect intent, persisted in the wake before it enters
 * MemoryStore (issue #67). Effect keys are derived from the wake id so the
 * canonical receipt key is stable across recovery; `confidence` is the
 * code-assigned model-judgment confidence the memory policy applies.
 */
export interface AcceptedIntent {
  readonly effectKey: string;
  readonly kind: "fact";
  readonly target: "memory" | "user";
  /** Index of the cited user line inside the captured input. */
  readonly lineIndex: number;
  /** Verbatim contiguous excerpt of the cited line. */
  readonly text: string;
  readonly confidence: number;
}

const acceptedIntentSchema = z.object({
  effectKey: z.string().regex(
    /^wake_[0-9a-f]{16}:effect:[0-9]+$/,
    "must be wake_<16 hex>:effect:<n>",
  ),
  kind: z.literal("fact"),
  target: z.enum(["memory", "user"]),
  lineIndex: z.number().int().min(0),
  text: z.string().min(1).max(MAX_FACT_TEXT_CHARS),
  confidence: z.number().finite().gt(0).lte(1),
}).strict();

function lineWindowIssues(
  lines: WakeInputLine[],
  afterLine: number,
  beforeLine: number,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]!;
    if (i > 0 && current.index <= lines[i - 1]!.index) {
      issues.push({
        path: `input.lines.${i}.index`,
        message: "line indexes must be strictly increasing",
      });
    }
    if (current.index < afterLine || current.index >= beforeLine) {
      issues.push({
        path: `input.lines.${i}.index`,
        message: "line index must lie inside [afterLine, beforeLine)",
      });
    }
  }
  return issues;
}

const wakeRecordSchema = z.object({
  version: z.literal(WAKE_RECORD_VERSION),
  wakeId: z.string().regex(SAFE_WAKE_ID_RE, "must be a canonical wake id"),
  source: z.object({
    conversationId: z.string().min(1).max(200),
    afterLine: z.number().int().min(0),
    beforeLine: z.number().int().min(0),
  }).strict(),
  profile: wakeProfileSchema,
  createdAt: timestampSchema,
  state: wakeStateSchema,
  attempts: z.number().int().min(0).max(MAX_WAKE_ATTEMPTS),
  input: wakeInputSchema,
  // Effect-outcome bookkeeping stays reserved for the host units of issue
  // #67; canonical outcomes live in MemoryStore's receipt table.
  acceptedIntents: z.array(acceptedIntentSchema).max(MAX_FACT_PROPOSALS),
  effectOutcomes: z.array(z.unknown()).max(0),
  failure: z.object({ reason: z.string().min(1).max(MAX_WAKE_FAILURE_REASON_CHARS) }).strict().nullable(),
}).strict().superRefine((record, ctx) => {
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: "custom", path: [path], message });
  };

  if (record.source.afterLine >= record.source.beforeLine) {
    issue("source", "afterLine must be strictly below beforeLine");
  }
  if (!isKnownWakeProfile(record.profile)) {
    issue("profile", `unknown wake profile ${record.profile.id}/v${record.profile.version}`);
  }

  const { lines } = record.input;
  for (const lineIssue of lineWindowIssues(lines, record.source.afterLine, record.source.beforeLine)) {
    ctx.addIssue({ code: "custom", path: [lineIssue.path], message: lineIssue.message });
  }

  if (record.input.fingerprint !== computeFingerprint(record.profile, record.input.lines)) {
    issue("input.fingerprint", "fingerprint does not match the stored input payload");
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(record.input.lines), "utf-8");
  if (serializedBytes > MAX_WAKE_INPUT_BYTES) {
    issue("input.lines", `serialized input is ${serializedBytes} bytes, above the ${MAX_WAKE_INPUT_BYTES}-byte cap`);
  }

  if ((record.state === "reflecting" || record.state === "applying") && record.attempts < 1) {
    issue("attempts", `${record.state} wakes must have recorded at least one attempt`);
  }
  // Accepted intents exist only once reflection has produced them; reserved
  // and mid-reflection records carry none.
  if (record.acceptedIntents.length > 0 && (record.state === "reserved" || record.state === "reflecting")) {
    issue(
      "acceptedIntents",
      `intents are admitted only after reflection completes (state: ${record.state})`,
    );
  }
  // Every intent is identity-bound to this wake and mechanically supported by
  // its cited user line, so persisted intents stay trustworthy across recovery.
  const seenEffectKeys = new Set<string>();
  for (const [i, intent] of record.acceptedIntents.entries()) {
    const intentPath = `acceptedIntents.${i}`;
    if (!intent.effectKey.startsWith(`${record.wakeId}:`)) {
      issue(`${intentPath}.effectKey`, "effect key must be derived from the wake id");
    }
    if (seenEffectKeys.has(intent.effectKey)) {
      issue(`${intentPath}.effectKey`, "duplicate effect key");
    }
    seenEffectKeys.add(intent.effectKey);
    const cited = record.input.lines.find((l) => l.index === intent.lineIndex);
    if (cited === undefined) {
      issue(`${intentPath}.lineIndex`, "cited line is outside the captured input");
    } else if (cited.role !== "user") {
      issue(`${intentPath}.lineIndex`, `cited line is role ${cited.role}; only user lines are eligible`);
    } else if (!cited.text.includes(intent.text)) {
      issue(`${intentPath}.text`, "text is not a verbatim excerpt of the cited line");
    }
  }
  const hasFailure = record.failure !== null;
  if (record.state === "failed" && !hasFailure) {
    issue("failure", "failed wakes must record a bounded failure reason");
  }
  if (record.state !== "failed" && hasFailure) {
    issue("failure", `only failed wakes may record a failure reason (state: ${record.state})`);
  }
});

export type WakeRole = z.infer<typeof wakeRoleSchema>;
export type WakeInputLine = z.infer<typeof wakeInputLineSchema>;
export type WakeState = z.infer<typeof wakeStateSchema>;
export type WakeRecord = z.infer<typeof wakeRecordSchema>;
export type WakeFailure = NonNullable<WakeRecord["failure"]>;

// ---------------------------------------------------------------------------
// Reservation input
// ---------------------------------------------------------------------------

const wakeReservationRequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  afterLine: z.number().int().min(0),
  beforeLine: z.number().int().min(0),
  profile: wakeProfileSchema,
  lines: z.array(wakeInputLineSchema).min(1),
}).strict();

export interface WakeReservationInput extends z.infer<typeof wakeReservationRequestSchema> {}

export type WakeTransition =
  | { kind: "begin-attempt" }
  | { kind: "begin-application"; intents: AcceptedIntent[] }
  | { kind: "fail"; reason: string }
  | { kind: "complete" };

export interface WakeReservationOutcome {
  readonly record: WakeRecord;
  /** True when an existing reservation for the same window and input was reused. */
  readonly coalesced: boolean;
  /** True when this call created the wake and invoked the reflection callback. */
  readonly reflectionRan: boolean;
  readonly reflectionResult?: unknown;
}

/** Structurally validated reservation request with derived identity. */
interface ParsedReservation {
  readonly wakeId: string;
  readonly path: string;
  readonly conversationId: string;
  readonly afterLine: number;
  readonly beforeLine: number;
  readonly profile: WakeProfile;
  readonly lines: WakeInputLine[];
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WakeRecordError extends Error {
  readonly wakeId: string;
  readonly path: string;

  constructor(wakeId: string, path: string, detail: string) {
    super(`Invalid wake record ${wakeId} at ${path}: ${detail}`);
    this.name = "WakeRecordError";
    this.wakeId = wakeId;
    this.path = path;
  }
}

export class WakeReservationConflictError extends Error {
  readonly wakeId: string;
  readonly path: string;
  readonly storedFingerprint: string;
  readonly requestedFingerprint: string;

  constructor(
    wakeId: string,
    path: string,
    storedFingerprint: string,
    requestedFingerprint: string,
  ) {
    super(
      `Wake reservation conflict for ${wakeId} at ${path}: window already holds input fingerprint ` +
        `${storedFingerprint}, refusing conflicting input fingerprint ${requestedFingerprint}`,
    );
    this.name = "WakeReservationConflictError";
    this.wakeId = wakeId;
    this.path = path;
    this.storedFingerprint = storedFingerprint;
    this.requestedFingerprint = requestedFingerprint;
  }
}

function recordError(wakeId: string, path: string, detail: string): WakeRecordError {
  const error = new WakeRecordError(wakeId, path, detail);
  log.error("wake record rejected", { wakeId, path, ...boundedError(error) });
  return error;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const location = i.path.length > 0 ? i.path.join(".") : "record";
      return `${location}: ${i.message}`;
    })
    .join("; ");
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Identity and fingerprints
// ---------------------------------------------------------------------------

/**
 * Deterministic wake identity for one source window. Duplicate reservations
 * for the same window derive the same id and land on the same file, so
 * coalescing and conflict detection need no secondary index.
 */
function computeWakeId(conversationId: string, afterLine: number, beforeLine: number): string {
  const digest = createHash("sha256")
    .update(`wake/v${WAKE_RECORD_VERSION}|${conversationId}|${afterLine}|${beforeLine}`)
    .digest("hex");
  return `wake_${digest.slice(0, 16)}`;
}

/** Stable payload identity over the profile and the captured input lines. */
function computeFingerprint(profile: WakeProfile, lines: WakeInputLine[]): string {
  return createHash("sha256").update(JSON.stringify({ profile, lines })).digest("hex");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface WakeRecordLimits {
  maxInputLines: number;
}

/** Parse and validate one wake record without exposing disk JSON as typed authority. */
export function parseWakeRecord(
  raw: unknown,
  path: string,
  expectedWakeId?: string,
  limits?: WakeRecordLimits,
): WakeRecord {
  const parsed = wakeRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw recordError(expectedWakeId ?? "<unresolved>", path, formatIssues(parsed.error));
  }
  const record = parsed.data;
  if (expectedWakeId !== undefined && record.wakeId !== expectedWakeId) {
    throw recordError(expectedWakeId, path, "record wake id does not match its requested id");
  }
  if (limits !== undefined && record.input.lines.length > limits.maxInputLines) {
    throw recordError(
      record.wakeId,
      path,
      `line count ${record.input.lines.length} exceeds the configured batch limit ${limits.maxInputLines}`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface WakeStoreOptions {
  /**
   * Maximum captured lines per wake record. Defaults to the existing
   * light-sleep batch-limit default; deployments pass their configured value.
   */
  maxInputLines?: number;
}

/**
 * The only module that performs wake-record I/O. The store owns persistence
 * and validation; lifecycle policy (when to schedule, retry, or reconcile)
 * lives in the inner-life host, not here.
 */
export class WakeStore {
  private readonly maxInputLines: number;

  constructor(
    readonly home: string,
    options: WakeStoreOptions = {},
  ) {
    this.maxInputLines = options.maxInputLines ?? DEFAULT_MAX_WAKE_INPUT_LINES;
  }

  /**
   * Durably reserve one wake for a source window, then — only for the caller
   * that created the reservation — invoke the injected reflection callback
   * with the durable record.
   *
   * Overlapping triggers for the same window coalesce onto the existing
   * record and never run a second reflection. The same window with different
   * input (transcript lines or profile) is rejected as a conflict — the
   * fingerprint covers both — because an occupied window reports the conflict
   * it actually has. A fresh reservation only mints authority for a
   * code-selected, known profile. A failed reservation throws before any
   * callback runs.
   */
  async reserve(
    input: WakeReservationInput,
    runReflection?: (record: WakeRecord) => Promise<unknown>,
  ): Promise<WakeReservationOutcome> {
    const request = this.parseReservationRequest(input);
    const path = request.path;

    try {
      mkdirSync(wakesDir(this.home), { recursive: true });
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") {
        log.error("wake directory creation failed", { ...boundedError(err) });
        throw err;
      }
    }

    // Occupied window: coalesce or conflict on the payload fingerprint,
    // before any fresh-mint authority check applies. `"wx"` below still
    // guards the race where two processes pass this check together.
    if (existsSync(path)) {
      const existing = this.read(request.wakeId);
      if (existing === null) {
        throw recordError(request.wakeId, path, "record disappeared while reading");
      }
      return this.coalesceOrConflict(request, existing, path);
    }

    // Fresh mint: authority gate and full cross-check before any file exists.
    const record = this.buildRecord(request);
    parseWakeRecord(record, path, request.wakeId, { maxInputLines: this.maxInputLines });
    const json = JSON.stringify(record, null, 2);

    let fd: number;
    try {
      // Exclusive creation: an atomic no-overwrite reservation. The file is
      // created with 0o600; transcript excerpts are private user data.
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if (errnoCode(err) === "EEXIST") {
        const winner = this.read(request.wakeId);
        if (winner === null) {
          throw recordError(request.wakeId, path, "exclusive create hit EEXIST but the record is unreadable");
        }
        return this.coalesceOrConflict(request, winner, path);
      }
      log.error("wake reservation create failed", {
        wakeId: request.wakeId,
        path,
        ...boundedError(err),
      });
      throw err;
    }

    try {
      writeFileSync(fd, json, "utf-8");
      fsyncSync(fd);
    } catch (err) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort: a leftover partial file is rejected loudly as a
        // corrupt record by every strict reader, failing closed.
      }
      log.error("wake reservation write failed; partial record removed", {
        wakeId: request.wakeId,
        path,
        ...boundedError(err),
      });
      throw err;
    } finally {
      closeSync(fd);
    }

    // Read back: only a complete, valid, durable record is exposed.
    const durable = this.read(request.wakeId);
    if (durable === null) {
      throw recordError(request.wakeId, path, "record missing after exclusive creation");
    }

    if (runReflection === undefined) {
      return { record: durable, coalesced: false, reflectionRan: false };
    }
    const reflectionResult = await runReflection(durable);
    return { record: durable, coalesced: false, reflectionRan: true, reflectionResult };
  }

  /**
   * List every persisted wake id in deterministic (sorted) order. Absence of
   * the wakes directory — a deployment with no wakes yet — is expected and
   * returns an empty list. A `.json` entry whose name is not a canonical wake
   * id fails closed: reconciliation must never silently skip a record it
   * cannot name.
   */
  listWakeIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(wakesDir(this.home));
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return [];
      log.error("wake directory listing failed", { ...boundedError(err) });
      throw err;
    }
    const ids: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!SAFE_WAKE_ID_RE.test(id)) {
        const path = join(wakesDir(this.home), name);
        throw recordError(id, path, "wake record file name is not a canonical wake id");
      }
      ids.push(id);
    }
    return ids.sort();
  }

  /**
   * Read one wake record. Absence (ENOENT) is expected and returns null;
   * corrupt JSON, unknown versions, invalid records, and non-ENOENT
   * filesystem failures propagate with wake-identity-bearing diagnostics.
   */
  read(wakeId: string): WakeRecord | null {
    const path = wakeRecordPath(this.home, wakeId);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return null;
      log.error("wake record read failed", { wakeId, path, ...boundedError(err) });
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw recordError(wakeId, path, "record contains malformed JSON");
      }
      throw err;
    }

    return parseWakeRecord(parsedJson, path, wakeId, { maxInputLines: this.maxInputLines });
  }

  /**
   * Apply one lifecycle transition. Identity, source window, profile, input,
   * and creation time are immutable by construction: only lifecycle state,
   * the attempt count, and (on failure) the bounded failure reason ever
   * change, and the result is fully revalidated before and after the
   * mode-preserving replacement write.
   */
  applyTransition(wakeId: string, transition: WakeTransition): WakeRecord {
    const path = wakeRecordPath(this.home, wakeId);
    const current = this.read(wakeId);
    if (current === null) {
      throw recordError(wakeId, path, "wake record not found");
    }

    const next = this.transitionedRecord(current, transition, path);
    parseWakeRecord(next, path, wakeId, { maxInputLines: this.maxInputLines });

    try {
      atomicWrite(path, JSON.stringify(next, null, 2));
    } catch (err) {
      log.error("wake record transition write failed", {
        wakeId,
        path,
        ...boundedError(err),
      });
      throw err;
    }

    const durable = this.read(wakeId);
    if (durable === null) {
      throw recordError(wakeId, path, "record missing after transition write");
    }
    return durable;
  }

  // -------------------------------------------------------------------------

  private parseReservationRequest(input: WakeReservationInput): ParsedReservation {
    const parsed = wakeReservationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw recordError("<unresolved>", "<unresolved>", formatIssues(parsed.error));
    }
    const request = parsed.data;
    const wakeId = computeWakeId(request.conversationId, request.afterLine, request.beforeLine);
    const path = wakeRecordPath(this.home, wakeId);

    if (request.afterLine >= request.beforeLine) {
      throw recordError(wakeId, path, "afterLine must be strictly below beforeLine");
    }
    if (request.lines.length > this.maxInputLines) {
      throw recordError(
        wakeId,
        path,
        `line count ${request.lines.length} exceeds the configured batch limit ${this.maxInputLines}`,
      );
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(request.lines), "utf-8");
    if (serializedBytes > MAX_WAKE_INPUT_BYTES) {
      // Oversize input is a recorded failure, never silent truncation.
      throw recordError(
        wakeId,
        path,
        `serialized input is ${serializedBytes} bytes, above the ${MAX_WAKE_INPUT_BYTES}-byte cap`,
      );
    }
    const windowIssues = lineWindowIssues(request.lines, request.afterLine, request.beforeLine);
    if (windowIssues.length > 0) {
      throw recordError(
        wakeId,
        path,
        windowIssues.map((i) => `${i.path}: ${i.message}`).join("; "),
      );
    }

    return {
      wakeId,
      path,
      conversationId: request.conversationId,
      afterLine: request.afterLine,
      beforeLine: request.beforeLine,
      profile: request.profile,
      lines: request.lines,
      fingerprint: computeFingerprint(request.profile, request.lines),
    };
  }

  private buildRecord(request: ParsedReservation): WakeRecord {
    if (!isKnownWakeProfile(request.profile)) {
      throw recordError(
        request.wakeId,
        request.path,
        `unknown wake profile ${request.profile.id}/v${request.profile.version}`,
      );
    }
    return {
      version: WAKE_RECORD_VERSION,
      wakeId: request.wakeId,
      source: {
        conversationId: request.conversationId,
        afterLine: request.afterLine,
        beforeLine: request.beforeLine,
      },
      profile: request.profile,
      createdAt: new Date().toISOString(),
      state: "reserved",
      attempts: 0,
      input: { fingerprint: request.fingerprint, lines: request.lines },
      acceptedIntents: [],
      effectOutcomes: [],
      failure: null,
    };
  }

  private coalesceOrConflict(
    request: ParsedReservation,
    existing: WakeRecord,
    path: string,
  ): WakeReservationOutcome {
    if (
      existing.source.conversationId !== request.conversationId ||
      existing.source.afterLine !== request.afterLine ||
      existing.source.beforeLine !== request.beforeLine
    ) {
      throw recordError(request.wakeId, path, "wake id collision: id maps to a different source window");
    }
    if (existing.input.fingerprint !== request.fingerprint) {
      const conflict = new WakeReservationConflictError(
        request.wakeId,
        path,
        existing.input.fingerprint,
        request.fingerprint,
      );
      log.error("wake reservation conflict", {
        wakeId: request.wakeId,
        path,
        ...boundedError(conflict),
      });
      throw conflict;
    }
    return { record: existing, coalesced: true, reflectionRan: false };
  }

  private transitionedRecord(
    current: WakeRecord,
    transition: WakeTransition,
    path: string,
  ): WakeRecord {
    switch (transition.kind) {
      case "begin-attempt": {
        if (current.state !== "reserved" && current.state !== "reflecting") {
          throw recordError(
            current.wakeId,
            path,
            `cannot begin an attempt from state ${current.state}`,
          );
        }
        if (current.attempts >= MAX_WAKE_ATTEMPTS) {
          throw recordError(
            current.wakeId,
            path,
            `attempt budget exhausted after ${current.attempts} attempts; the batch stays failed`,
          );
        }
        return { ...current, state: "reflecting", attempts: current.attempts + 1 };
      }
      case "begin-application": {
        if (current.state !== "reflecting") {
          throw recordError(
            current.wakeId,
            path,
            `cannot begin application from state ${current.state}`,
          );
        }
        if (current.acceptedIntents.length > 0) {
          throw recordError(current.wakeId, path, "intents already recorded for this wake");
        }
        return { ...current, state: "applying", acceptedIntents: transition.intents };
      }
      case "fail": {
        if (current.state !== "reflecting" && current.state !== "applying") {
          throw recordError(
            current.wakeId,
            path,
            `cannot fail from state ${current.state}`,
          );
        }
        const reason = transition.reason;
        if (reason.length < 1 || reason.length > MAX_WAKE_FAILURE_REASON_CHARS) {
          throw recordError(
            current.wakeId,
            path,
            `failure reason must be 1..${MAX_WAKE_FAILURE_REASON_CHARS} characters`,
          );
        }
        return { ...current, state: "failed", failure: { reason } };
      }
      case "complete": {
        if (current.state !== "reflecting" && current.state !== "applying") {
          throw recordError(
            current.wakeId,
            path,
            `cannot complete from state ${current.state}`,
          );
        }
        return { ...current, state: "completed" };
      }
    }
  }
}
