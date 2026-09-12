import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryStore } from "../memory/store.ts";
import { MemoryBudget } from "../memory/budget.ts";
import type { MemoryEffectOutcome, MemoryFactEffect } from "../memory/policy.ts";
import type { Config } from "../config.ts";
import { atomicWrite } from "../fs.ts";
import { memoryDreamingCursorPath } from "../sessions/paths.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { ReflectionEngine, type ReflectionModelRequest } from "./reflection.ts";
import {
  PRIVATE_FACTS_PROFILE,
  WakeRecordError,
  WakeStore,
  type AcceptedIntent,
  type WakeInputLine,
  type WakeRecord,
  type WakeReservationInput,
  type WakeRole,
  type WakeState,
  type WakeTransition,
} from "./wake-store.ts";
import { wakeRecordPath, wakesDir } from "./paths.ts";
import {
  AdmissionClosedError,
  ReflectionHost,
  type ReconciliationMemoryStore,
  type ReflectionCursorState,
  type ReflectionCursorStore,
} from "./recovery.ts";

/**
 * Recovery verifier for Litespec #67 unit "Reconcile interrupted private
 * reflection".
 *
 * Scenarios (exact names from the issue):
 * - [C1] immutable-reflection-retry-budget-and-exhaustion
 * - [C1] accepted-intents-are-replayed-not-regenerated
 * - [C1] unavailable-model-consumes-bounded-attempt-with-no-fallback
 * - [C2] restart-at-every-effect-and-checkpoint-boundary
 * - [C2] overlapping-trigger-cannot-bypass-pending-window
 * - [C3] corrupt-profile-record-and-receipt-block-admission
 *
 * Every scenario drives REAL persisted state: actual wake files under
 * `state/inner-life/wakes/`, actual SQLite memory databases with effect
 * receipts, and actual cursor files — across reconstructed host instances
 * (fresh WakeStore / MemoryStore / ReflectionHost objects over the same
 * home). Model boundaries are deterministic injected fakes; no live or paid
 * provider call exists on any path here.
 */

const TS = "2026-01-01T00:00:00.000Z";
const CONVERSATION = "conversation-a";
const BEFORE_LINE = 3;
const MADRID_SURFACE = surfaceId(dmSurface(4242));

function line(index: number, role: WakeRole, text: string, sourceSurfaceId?: string): WakeInputLine {
  return sourceSurfaceId === undefined
    ? { index, role, text, ts: TS }
    : { index, role, text, ts: TS, sourceSurfaceId };
}

function wakeLines(): WakeInputLine[] {
  return [
    line(0, "user", "I live in Madrid", MADRID_SURFACE),
    line(1, "assistant", "You live in Madrid."),
    line(2, "user", "I use NixOS on my laptop", MADRID_SURFACE),
  ];
}

function reservationInput(overrides: Partial<WakeReservationInput> = {}): WakeReservationInput {
  return {
    conversationId: CONVERSATION,
    afterLine: 0,
    beforeLine: BEFORE_LINE,
    profile: PRIVATE_FACTS_PROFILE,
    lines: wakeLines(),
    ...overrides,
  };
}

interface FactProposal {
  target: "memory" | "user";
  line: number;
  text: string;
}

const DEFAULT_PROPOSALS: FactProposal[] = [
  { target: "memory", line: 0, text: "I live in Madrid" },
  { target: "user", line: 2, text: "I use NixOS on my laptop" },
];

function factEnvelope(proposals: FactProposal[]): string {
  return JSON.stringify({
    version: 1,
    proposals: proposals.map((p) => ({ kind: "fact", ...p })),
  });
}

/** Deterministic counting model boundary. Never touches a provider. */
class FakeReflectionModel {
  calls = 0;
  readonly requests: ReflectionModelRequest[] = [];

  constructor(
    private readonly respond: (request: ReflectionModelRequest, call: number) => string | Promise<string>,
  ) {}

  readonly invoker = async (request: ReflectionModelRequest): Promise<string> => {
    this.calls += 1;
    this.requests.push(request);
    return this.respond(request, this.calls);
  };
}

function workingModel(proposals: FactProposal[] = DEFAULT_PROPOSALS): FakeReflectionModel {
  return new FakeReflectionModel(() => factEnvelope(proposals));
}

function failingModel(): FakeReflectionModel {
  return new FakeReflectionModel(() => {
    throw new Error("provider exploded");
  });
}

/** Model that must never be invoked; used to prove intents are not regenerated. */
function sentinelModel(): FakeReflectionModel {
  return new FakeReflectionModel(() => {
    throw new Error("sentinel: reconciliation re-ran the model; accepted intents must be replayed");
  });
}

// ---------------------------------------------------------------------------
// Real-file cursor store (mirrors the existing light-sleep cursor location)
// ---------------------------------------------------------------------------

class FileCursorStore implements ReflectionCursorStore {
  constructor(readonly home: string) {}

  read(conversationId: string): ReflectionCursorState | null {
    let raw: string;
    try {
      raw = readFileSync(memoryDreamingCursorPath(this.home, conversationId), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ReflectionCursorState>;
      if (typeof parsed.processedLines === "number" && typeof parsed.lastDreamedAt === "string") {
        return { processedLines: parsed.processedLines, lastDreamedAt: parsed.lastDreamedAt };
      }
    } catch {
      // malformed cursor file behaves as absent for the monotonic check
    }
    return null;
  }

  write(conversationId: string, cursor: ReflectionCursorState): void {
    atomicWrite(memoryDreamingCursorPath(this.home, conversationId), JSON.stringify(cursor));
  }
}

/** Records every committed cursor write so monotonicity is checkable. */
class RecordingCursorStore implements ReflectionCursorStore {
  constructor(
    private readonly inner: ReflectionCursorStore,
    readonly writes: Array<{ conversationId: string; processedLines: number }>,
  ) {}

  read(conversationId: string): ReflectionCursorState | null {
    return this.inner.read(conversationId);
  }

  write(conversationId: string, cursor: ReflectionCursorState): void {
    this.inner.write(conversationId, cursor);
    this.writes.push({ conversationId, processedLines: cursor.processedLines });
  }
}

/** Wraps a cursor store to inject a process stop before/after the write. */
class StoppingCursorStore implements ReflectionCursorStore {
  constructor(
    private readonly inner: ReflectionCursorStore,
    private readonly stop: Error,
    private readonly position: "before" | "after",
  ) {}

  read(conversationId: string): ReflectionCursorState | null {
    return this.inner.read(conversationId);
  }

  write(conversationId: string, cursor: ReflectionCursorState): void {
    if (this.position === "before") throw this.stop;
    this.inner.write(conversationId, cursor);
    throw this.stop;
  }
}

/** Wraps the memory seam to inject a process stop after the SQLite commit. */
class StopAfterCommitMemory implements ReconciliationMemoryStore {
  private armed = true;

  constructor(
    private readonly inner: MemoryStore,
    private readonly stop: Error,
  ) {}

  async applyFactEffect(effect: MemoryFactEffect): Promise<MemoryEffectOutcome> {
    const outcome = await this.inner.applyFactEffect(effect);
    if (this.armed) {
      this.armed = false;
      throw this.stop;
    }
    return outcome;
  }

  readEffectReceipts() {
    return this.inner.readEffectReceipts();
  }
}

// ---------------------------------------------------------------------------
// Host construction and stop injection
// ---------------------------------------------------------------------------

type StopPoint =
  | "before-intent-persistence"
  | "after-intent-persistence"
  | "before-sqlite-commit"
  | "after-sqlite-commit"
  | "before-wake-outcome-update"
  | "after-wake-outcome-update"
  | "before-cursor-update"
  | "after-cursor-update";

const STOP_POINTS: StopPoint[] = [
  "before-intent-persistence",
  "after-intent-persistence",
  "before-sqlite-commit",
  "after-sqlite-commit",
  "before-wake-outcome-update",
  "after-wake-outcome-update",
  "before-cursor-update",
  "after-cursor-update",
];

interface HostHandle {
  host: ReflectionHost;
  wakeStore: WakeStore;
  store: MemoryStore;
}

function installTransitionStop(
  wakeStore: WakeStore,
  kind: WakeTransition["kind"],
  stop: Error,
  position: "before" | "after",
): void {
  const original = wakeStore.applyTransition.bind(wakeStore);
  spyOn(wakeStore, "applyTransition").mockImplementation(
    (wakeId: string, transition: WakeTransition): WakeRecord => {
      if (transition.kind === kind) {
        if (position === "before") throw stop;
        original(wakeId, transition);
        throw stop;
      }
      return original(wakeId, transition);
    },
  );
}

function makeHost(
  dir: string,
  opts: {
    model: FakeReflectionModel;
    writes: Array<{ conversationId: string; processedLines: number }>;
    stop?: { point: StopPoint; error: Error };
  },
): HostHandle {
  const wakeStore = new WakeStore(dir);
  const store = new MemoryStore(dir, undefined, { budget: new MemoryBudget() });
  let memory: ReconciliationMemoryStore = store;
  let cursors: ReflectionCursorStore = new RecordingCursorStore(new FileCursorStore(dir), opts.writes);

  const stop = opts.stop;
  if (stop !== undefined) {
    switch (stop.point) {
      case "before-intent-persistence":
        installTransitionStop(wakeStore, "begin-application", stop.error, "before");
        break;
      case "after-intent-persistence":
        installTransitionStop(wakeStore, "begin-application", stop.error, "after");
        break;
      case "before-wake-outcome-update":
        installTransitionStop(wakeStore, "complete", stop.error, "before");
        break;
      case "after-wake-outcome-update":
        installTransitionStop(wakeStore, "complete", stop.error, "after");
        break;
      case "before-sqlite-commit": {
        // Inside the canonical transaction: the mutation is rolled back and
        // the receipt never commits (unit-3 spy seam, real mid-transaction).
        const target = store as unknown as { insertEffectReceipt: () => void };
        spyOn(target, "insertEffectReceipt").mockImplementation(() => {
          throw stop.error;
        });
        break;
      }
      case "after-sqlite-commit":
        memory = new StopAfterCommitMemory(store, stop.error);
        break;
      case "before-cursor-update":
      case "after-cursor-update":
        cursors = new StoppingCursorStore(
          cursors,
          stop.error,
          stop.point === "before-cursor-update" ? "before" : "after",
        );
        break;
    }
  }

  const engine = new ReflectionEngine({ invoker: opts.model.invoker, deadlineMs: 10_000 });
  const host = new ReflectionHost({ wakeStore, memory, cursors, reflection: engine });
  return { host, wakeStore, store };
}

// ---------------------------------------------------------------------------
// Persisted-state inspection helpers
// ---------------------------------------------------------------------------

function onlyWakeId(dir: string): string {
  const names = readdirSync(wakesDir(dir)).filter((n) => n.endsWith(".json"));
  if (names.length !== 1) {
    throw new Error(`expected exactly one wake record in ${dir}, found ${names.length}`);
  }
  return names[0]!.replace(/\.json$/, "");
}

interface ReceiptRow {
  effect_key: string;
  payload_hash: string;
  outcome: string;
  entry_id: string | null;
}

function effectReceipts(store: MemoryStore): ReceiptRow[] {
  return store.db.database
    .query<ReceiptRow, []>(
      "SELECT effect_key, payload_hash, outcome, entry_id FROM memory_effect_receipts ORDER BY effect_key",
    )
    .all();
}

interface CuratedRow {
  id: string;
  text: string;
  updated_at: number;
}

function curatedRows(store: MemoryStore, scope: string): CuratedRow[] {
  return store.db.database
    .query<CuratedRow, { $scope: string }>(
      `SELECT id, text, updated_at FROM memory_entries
       WHERE scope = $scope AND entry_kind IN ('memory', 'user')
       ORDER BY id`,
    )
    .all({ $scope: scope });
}

function readCursor(dir: string): ReflectionCursorState | null {
  return new FileCursorStore(dir).read(CONVERSATION);
}

/** Persist an interrupted in-flight attempt shape directly on the record. */
async function prebuildReflectingAttempt(dir: string, attempts: number): Promise<string> {
  const wakeStore = new WakeStore(dir);
  await wakeStore.reserve(reservationInput());
  const wakeId = onlyWakeId(dir);
  for (let i = 0; i < attempts; i++) {
    wakeStore.applyTransition(wakeId, { kind: "begin-attempt" });
  }
  return wakeId;
}

async function waitForModelCalls(model: FakeReflectionModel, calls: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (model.calls >= calls) return;
    await Bun.sleep(5);
  }
  throw new Error(`model did not reach ${calls} calls (observed ${model.calls})`);
}

function expectKind(outcome: MemoryEffectOutcome, kind: "added" | "updated" | "rejected"): void {
  expect(outcome.kind).toBe(kind);
}

describe("private reflection recovery", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-recovery-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("immutable-reflection-retry-budget-and-exhaustion", async () => {
    const dir = join(home, "budget");
    mkdirSync(dir, { recursive: true });
    const writes: Array<{ conversationId: string; processedLines: number }> = [];
    const model = failingModel();
    const first = makeHost(dir, { model, writes });
    await first.host.reconcile();

    // Each reconciliation pass consumes exactly ONE persisted attempt and
    // re-sends the recorded immutable input — never a regenerated one.
    const firstAttempt = await first.host.processWindow(reservationInput());
    expect(firstAttempt.coalesced).toBe(false);
    expect(firstAttempt.blocked).toBe(true);
    const secondAttempt = await first.host.processWindow(reservationInput());
    expect(secondAttempt.coalesced).toBe(true);
    expect(secondAttempt.blocked).toBe(true);
    const inFlight = first.wakeStore.read(onlyWakeId(dir));
    expect(inFlight?.state).toBe("reflecting");
    expect(inFlight?.attempts).toBe(2);

    // The third failure exhausts the total budget: explicitly failed.
    const exhausted = await first.host.processWindow(reservationInput());
    expect(exhausted.blocked).toBe(true);
    const failedRecord = first.wakeStore.read(onlyWakeId(dir));
    expect(failedRecord?.state).toBe("failed");
    expect(failedRecord?.attempts).toBe(3);
    expect(failedRecord?.failure).not.toBeNull();
    expect(failedRecord?.failure?.reason).toContain("provider");
    expect(failedRecord!.failure!.reason.length).toBeLessThanOrEqual(2000);

    // Exactly three invocations, every one carrying the SAME captured input
    // and code-owned instructions: retry replays, it does not regenerate.
    expect(model.calls).toBe(3);
    expect(model.requests).toHaveLength(3);
    const prompts = model.requests.map((r) => r.userPrompt);
    expect(new Set(prompts).size).toBe(1);
    expect(new Set(model.requests.map((r) => r.systemPrompt)).size).toBe(1);
    for (const l of wakeLines()) {
      expect(prompts[0]).toContain(l.text);
    }

    // Exhausted attempts keep failure durable: no memory, no receipts, no
    // cursor movement.
    expect(effectReceipts(first.store)).toHaveLength(0);
    expect(curatedRows(first.store, "general")).toHaveLength(0);
    expect(curatedRows(first.store, "user")).toHaveLength(0);
    expect(readCursor(dir)).toBeNull();
    expect(writes).toHaveLength(0);

    // A fresh host with a working model must NOT resurrect the failed batch:
    // no new attempt, no replacement, no cursor advancement.
    const recoveredModel = workingModel();
    const second = makeHost(dir, { model: recoveredModel, writes });
    const report = await second.host.reconcile();
    expect(report.failed).toEqual([onlyWakeId(dir)]);
    expect(recoveredModel.calls).toBe(0);
    const afterRestart = second.wakeStore.read(onlyWakeId(dir));
    expect(afterRestart?.state).toBe("failed");
    expect(afterRestart?.attempts).toBe(3);
    expect(readCursor(dir)).toBeNull();
    expect(effectReceipts(second.store)).toHaveLength(0);

    // An overlapping trigger for the failed window coalesces and stays
    // blocked: no automatic replacement of the failed batch.
    const retrigger = await second.host.processWindow(reservationInput());
    expect(retrigger.coalesced).toBe(true);
    expect(retrigger.blocked).toBe(true);
    expect(recoveredModel.calls).toBe(0);
    expect(readCursor(dir)).toBeNull();

    // Budget is TOTAL across reconstructed hosts: a wake interrupted after
    // two persisted attempts gets exactly one more, and success on the last
    // budget unit still completes and advances the cursor.
    const twoSpent = join(home, "two-spent");
    mkdirSync(twoSpent, { recursive: true });
    const wakeId2 = await prebuildReflectingAttempt(twoSpent, 2);
    const writes2: Array<{ conversationId: string; processedLines: number }> = [];
    const lastChance = makeHost(twoSpent, { model: workingModel(), writes: writes2 });
    const lastReport = await lastChance.host.reconcile();
    expect(lastReport.completed).toEqual([wakeId2]);
    const completedRecord = lastChance.wakeStore.read(wakeId2);
    expect(completedRecord?.state).toBe("completed");
    expect(completedRecord?.attempts).toBe(3);
    expect(writes2).toEqual([{ conversationId: CONVERSATION, processedLines: BEFORE_LINE }]);

    // Three persisted attempts with no success stay failed without another
    // model call.
    const allSpent = join(home, "all-spent");
    mkdirSync(allSpent, { recursive: true });
    const wakeId3 = await prebuildReflectingAttempt(allSpent, 3);
    const writes3: Array<{ conversationId: string; processedLines: number }> = [];
    const noBudget = makeHost(allSpent, { model: workingModel(), writes: writes3 });
    const noBudgetReport = await noBudget.host.reconcile();
    expect(noBudgetReport.failed).toEqual([wakeId3]);
    const noBudgetRecord = noBudget.wakeStore.read(wakeId3);
    expect(noBudgetRecord?.state).toBe("failed");
    expect(noBudgetRecord?.attempts).toBe(3);
    expect(noBudgetRecord?.failure?.reason).toContain("attempt budget exhausted");
    expect(readCursor(allSpent)).toBeNull();
    noBudget.store.close();
    lastChance.store.close();
    second.store.close();
    first.store.close();

    // A cancelled attempt (shutdown fencing) is resumable, not failed: it
    // consumes the attempt, leaves the wake unfinished, and a later pass
    // finishes it from the recorded input.
    const cancelledDir = join(home, "cancelled");
    mkdirSync(cancelledDir, { recursive: true });
    const writesC: Array<{ conversationId: string; processedLines: number }> = [];
    const cancelledModel = workingModel();
    const cancelledHost = makeHost(cancelledDir, { model: cancelledModel, writes: writesC });
    await cancelledHost.host.reconcile();
    const cancelled = await cancelledHost.host.processWindow(reservationInput(), AbortSignal.abort());
    expect(cancelled.blocked).toBe(true);
    const cancelledRecord = cancelledHost.wakeStore.read(onlyWakeId(cancelledDir));
    expect(cancelledRecord?.state).toBe("reflecting");
    expect(cancelledRecord?.attempts).toBe(1);
    expect(cancelledModel.calls).toBe(0);
    expect(readCursor(cancelledDir)).toBeNull();
    const resumed = await cancelledHost.host.processWindow(reservationInput());
    expect(resumed.blocked).toBe(false);
    expect(resumed.record.state).toBe("completed");
    expect(resumed.record.attempts).toBe(2);
    expect(cancelledModel.calls).toBe(1);
    expect(readCursor(cancelledDir)?.processedLines).toBe(BEFORE_LINE);
    cancelledHost.store.close();
  });

  it("accepted-intents-are-replayed-not-regenerated", async () => {
    // Case A: intents persisted, no effect applied yet. A reconstructed host
    // replays the recorded intents; the model is never invoked again.
    const dirA = join(home, "intents-no-receipts");
    mkdirSync(dirA, { recursive: true });
    const writesA: Array<{ conversationId: string; processedLines: number }> = [];
    const crashA = new Error("injected stop: after intent persistence");
    const firstA = makeHost(dirA, {
      model: workingModel(),
      writes: writesA,
      stop: { point: "after-intent-persistence", error: crashA },
    });
    await firstA.host.reconcile();
    let caughtA: unknown;
    try {
      await firstA.host.processWindow(reservationInput());
      throw new Error("expected the injected stop");
    } catch (err) {
      caughtA = err;
    }
    expect(caughtA).toBe(crashA);
    firstA.store.close();

    // The intents exist only in the durable wake record on disk.
    const persisted = new WakeStore(dirA).read(onlyWakeId(dirA));
    expect(persisted?.state).toBe("applying");
    expect(persisted?.acceptedIntents).toHaveLength(2);
    const recordedIntents: AcceptedIntent[] = persisted!.acceptedIntents;
    expect(recordedIntents.map((i) => i.effectKey)).toEqual([
      `${onlyWakeId(dirA)}:effect:0`,
      `${onlyWakeId(dirA)}:effect:1`,
    ]);

    const sentinelA = sentinelModel();
    const secondA = makeHost(dirA, { model: sentinelA, writes: writesA });
    const reportA = await secondA.host.reconcile();
    expect(reportA.completed).toEqual([onlyWakeId(dirA)]);
    expect(sentinelA.calls).toBe(0);
    expect(secondA.wakeStore.read(onlyWakeId(dirA))?.state).toBe("completed");
    // Every accepted fact reached memory exactly once, keyed by the recorded
    // stable identity.
    const receiptsA = effectReceipts(secondA.store);
    expect(receiptsA.map((r) => r.effect_key)).toEqual(recordedIntents.map((i) => i.effectKey));
    expectKind(JSON.parse(receiptsA[0]!.outcome) as MemoryEffectOutcome, "added");
    expectKind(JSON.parse(receiptsA[1]!.outcome) as MemoryEffectOutcome, "added");
    expect(curatedRows(secondA.store, "general").map((r) => r.text)).toEqual(["I live in Madrid"]);
    expect(curatedRows(secondA.store, "user").map((r) => r.text)).toEqual(["I use NixOS on my laptop"]);
    expect(readCursor(dirA)?.processedLines).toBe(BEFORE_LINE);
    secondA.store.close();

    // Case B: the first effect already committed its receipt before the stop.
    // Recovery replays that receipt verbatim (no second mutation) and applies
    // only the missing one — again without the model.
    const dirB = join(home, "intents-partial-receipts");
    mkdirSync(dirB, { recursive: true });
    const writesB: Array<{ conversationId: string; processedLines: number }> = [];
    const crashB = new Error("injected stop: after sqlite commit");
    const firstB = makeHost(dirB, {
      model: workingModel(),
      writes: writesB,
      stop: { point: "after-sqlite-commit", error: crashB },
    });
    await firstB.host.reconcile();
    let caughtB: unknown;
    try {
      await firstB.host.processWindow(reservationInput());
      throw new Error("expected the injected stop");
    } catch (err) {
      caughtB = err;
    }
    expect(caughtB).toBe(crashB);
    const partialReceipts = effectReceipts(firstB.store);
    expect(partialReceipts).toHaveLength(1);
    expect(partialReceipts[0]!.effect_key).toBe(`${onlyWakeId(dirB)}:effect:0`);
    const committedOutcome = JSON.parse(partialReceipts[0]!.outcome) as MemoryEffectOutcome;
    expectKind(committedOutcome, "added");
    const committedEntryId = (committedOutcome as { entryId: string }).entryId;
    firstB.store.close();

    const sentinelB = sentinelModel();
    const secondB = makeHost(dirB, { model: sentinelB, writes: writesB });
    const reportB = await secondB.host.reconcile();
    expect(reportB.completed).toEqual([onlyWakeId(dirB)]);
    expect(sentinelB.calls).toBe(0);
    const receiptsB = effectReceipts(secondB.store);
    expect(receiptsB).toHaveLength(2);
    // The committed effect replays its recorded outcome — same receipt, same
    // entry, no duplicate add.
    const replayed = receiptsB.find((r) => r.effect_key === `${onlyWakeId(dirB)}:effect:0`);
    expect(JSON.parse(replayed!.outcome)).toEqual(committedOutcome);
    expect(replayed!.entry_id).toBe(committedEntryId);
    expect(curatedRows(secondB.store, "general")).toHaveLength(1);
    expect(curatedRows(secondB.store, "user")).toHaveLength(1);
    expect(readCursor(dirB)?.processedLines).toBe(BEFORE_LINE);
    secondB.store.close();
  });

  it("unavailable-model-consumes-bounded-attempt-with-no-fallback", async () => {
    const dir = join(home, "unavailable");
    mkdirSync(dir, { recursive: true });
    const writes: Array<{ conversationId: string; processedLines: number }> = [];
    // The deployment's single configured selection is unavailable; the host
    // consumes the bounded attempt budget and never selects a fallback.
    const unavailableConfig = { modelName: "definitely-unavailable-model", goblinHome: dir } as Config;
    const engine = new ReflectionEngine({ config: unavailableConfig, deadlineMs: 10_000 });
    const wakeStore = new WakeStore(dir);
    const store = new MemoryStore(dir, undefined, { budget: new MemoryBudget() });
    const host = new ReflectionHost({
      wakeStore,
      memory: store,
      cursors: new RecordingCursorStore(new FileCursorStore(dir), writes),
      reflection: engine,
    });
    await host.reconcile();

    const wakeId = onlyWakeId(dir);
    const observedStates: WakeState[] = [];
    const observedAttempts: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      const outcome = await host.processWindow(reservationInput());
      expect(outcome.blocked).toBe(true);
      const record = wakeStore.read(wakeId);
      observedStates.push(record!.state);
      observedAttempts.push(record!.attempts);
    }
    // Three passes consume the three persisted attempts; the fourth finds the
    // batch explicitly failed and makes no further attempt.
    expect(observedStates).toEqual(["reflecting", "reflecting", "failed", "failed"]);
    expect(observedAttempts).toEqual([1, 2, 3, 3]);
    const failed = wakeStore.read(wakeId);
    expect(failed?.failure?.reason).toContain("config-unavailable");
    expect(effectReceipts(store)).toHaveLength(0);
    expect(readCursor(dir)).toBeNull();
    expect(writes).toHaveLength(0);
    store.close();

    // A reconstructed host reconciles the failed batch without retrying it,
    // and admission still opens (only that window is blocked).
    const secondStore = new MemoryStore(dir, undefined, { budget: new MemoryBudget() });
    const secondHost = new ReflectionHost({
      wakeStore: new WakeStore(dir),
      memory: secondStore,
      cursors: new RecordingCursorStore(new FileCursorStore(dir), writes),
      reflection: engine,
    });
    const report = await secondHost.reconcile();
    expect(report.failed).toEqual([wakeId]);
    expect(secondHost.isAdmitted).toBe(true);
    const afterRestart = new WakeStore(dir).read(wakeId);
    expect(afterRestart?.state).toBe("failed");
    expect(afterRestart?.attempts).toBe(3);
    secondStore.close();
  });

  it("restart-at-every-effect-and-checkpoint-boundary", async () => {
    // What the durable state looks like immediately after each injected stop,
    // and what one reconstruct-and-reconcile pass must do from there.
    interface StopExpectation {
      state: WakeState;
      attempts: number;
      intents: number;
      receipts: number;
      cursorWritten: boolean;
      recoveryAttempts: number;
      recoveryModelCalls: number;
    }
    const EXPECTED: Record<StopPoint, StopExpectation> = {
      "before-intent-persistence": { state: "reflecting", attempts: 1, intents: 0, receipts: 0, cursorWritten: false, recoveryAttempts: 2, recoveryModelCalls: 1 },
      "after-intent-persistence": { state: "applying", attempts: 1, intents: 2, receipts: 0, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "before-sqlite-commit": { state: "applying", attempts: 1, intents: 2, receipts: 0, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "after-sqlite-commit": { state: "applying", attempts: 1, intents: 2, receipts: 1, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "before-wake-outcome-update": { state: "applying", attempts: 1, intents: 2, receipts: 2, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "after-wake-outcome-update": { state: "completed", attempts: 1, intents: 2, receipts: 2, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "before-cursor-update": { state: "completed", attempts: 1, intents: 2, receipts: 2, cursorWritten: false, recoveryAttempts: 1, recoveryModelCalls: 0 },
      "after-cursor-update": { state: "completed", attempts: 1, intents: 2, receipts: 2, cursorWritten: true, recoveryAttempts: 1, recoveryModelCalls: 0 },
    };

    for (const point of STOP_POINTS) {
      const dir = join(home, point);
      mkdirSync(dir, { recursive: true });
      const stopError = new Error(`injected stop: ${point}`);
      const writes: Array<{ conversationId: string; processedLines: number }> = [];
      const crashModel = workingModel();
      const crashing = makeHost(dir, {
        model: crashModel,
        writes,
        stop: { point, error: stopError },
      });
      await crashing.host.reconcile();
      // A near-duplicate already in memory: the first accepted fact must
      // UPDATE that entry in place, making duplicate updates observable.
      const seeded = await crashing.store.add("general", "I live in Madrid");
      expect(seeded.ok).toBe(true);
      const seededId = curatedRows(crashing.store, "general")[0]!.id;

      let caught: unknown;
      try {
        await crashing.host.processWindow(reservationInput());
        throw new Error(`expected the injected stop at ${point}`);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(stopError);
      expect(crashModel.calls).toBe(1);
      const wakeId = onlyWakeId(dir);
      const expected = EXPECTED[point];

      // Durable state exactly at the named boundary.
      const crashed = new WakeStore(dir).read(wakeId);
      expect(crashed?.state).toBe(expected.state);
      expect(crashed?.attempts).toBe(expected.attempts);
      expect(crashed?.acceptedIntents).toHaveLength(expected.intents);
      const receiptsAfterCrash = effectReceipts(crashing.store);
      expect(receiptsAfterCrash).toHaveLength(expected.receipts);
      if (point === "after-sqlite-commit") {
        expect(receiptsAfterCrash[0]!.effect_key).toBe(`${wakeId}:effect:0`);
        expect(JSON.parse(receiptsAfterCrash[0]!.outcome)).toEqual({
          kind: "updated",
          entryId: seededId,
          preservedExisting: false,
        });
      }
      expect(readCursor(dir) !== null).toBe(expected.cursorWritten);
      crashing.store.close();

      // Reconstructed host: real wake files + real SQLite over the same home.
      const recoveredModel = workingModel();
      const recovered = makeHost(dir, { model: recoveredModel, writes });
      const report = await recovered.host.reconcile();
      expect(report.completed).toEqual([wakeId]);
      expect(report.failed).toEqual([]);
      expect(report.unfinished).toEqual([]);
      expect(recoveredModel.calls).toBe(expected.recoveryModelCalls);

      // Convergence: no duplicate adds, no duplicate updates, no skipped
      // accepted facts, cursor advanced exactly once and never backward.
      const finalRecord = recovered.wakeStore.read(wakeId);
      expect(finalRecord?.state).toBe("completed");
      expect(finalRecord?.attempts).toBe(expected.recoveryAttempts);
      const finalReceipts = effectReceipts(recovered.store);
      expect(finalReceipts).toHaveLength(2);
      expect(finalReceipts.map((r) => r.effect_key)).toEqual([`${wakeId}:effect:0`, `${wakeId}:effect:1`]);
      expect(JSON.parse(finalReceipts[0]!.outcome)).toEqual({
        kind: "updated",
        entryId: seededId,
        preservedExisting: false,
      });
      expect(finalReceipts[0]!.entry_id).toBe(seededId);
      expectKind(JSON.parse(finalReceipts[1]!.outcome) as MemoryEffectOutcome, "added");
      const generalRows = curatedRows(recovered.store, "general");
      expect(generalRows).toHaveLength(1);
      expect(generalRows[0]!.id).toBe(seededId);
      expect(generalRows[0]!.text).toBe("I live in Madrid");
      const userRows = curatedRows(recovered.store, "user");
      expect(userRows).toHaveLength(1);
      expect(userRows[0]!.text).toBe("I use NixOS on my laptop");
      expect(finalReceipts[1]!.entry_id).toBe(userRows[0]!.id);
      expect(readCursor(dir)?.processedLines).toBe(BEFORE_LINE);
      expect(writes).toEqual([{ conversationId: CONVERSATION, processedLines: BEFORE_LINE }]);

      // Repeated reconstruction is a no-op: replay returns recorded outcomes,
      // the update is not reapplied, the cursor does not move again.
      const updatedAtBefore = generalRows[0]!.updated_at;
      const idempotentModel = sentinelModel();
      const idempotent = makeHost(dir, { model: idempotentModel, writes });
      const idempotentReport = await idempotent.host.reconcile();
      expect(idempotentReport.completed).toEqual([wakeId]);
      expect(idempotentModel.calls).toBe(0);
      expect(effectReceipts(idempotent.store)).toHaveLength(2);
      const generalAfter = curatedRows(idempotent.store, "general");
      expect(generalAfter[0]!.updated_at).toBe(updatedAtBefore);
      expect(writes).toEqual([{ conversationId: CONVERSATION, processedLines: BEFORE_LINE }]);
      idempotent.store.close();
      recovered.store.close();
    }

    // A cursor already past the wake's window is never moved backward.
    const backwardDir = join(home, "backward-cursor");
    mkdirSync(backwardDir, { recursive: true });
    const writesBackward: Array<{ conversationId: string; processedLines: number }> = [];
    new FileCursorStore(backwardDir).write(CONVERSATION, {
      processedLines: 10,
      lastDreamedAt: TS,
    });
    const backward = makeHost(backwardDir, { model: workingModel(), writes: writesBackward });
    await backward.host.reconcile();
    const backwardOutcome = await backward.host.processWindow(reservationInput());
    expect(backwardOutcome.blocked).toBe(false);
    expect(backwardOutcome.record.state).toBe("completed");
    expect(readCursor(backwardDir)?.processedLines).toBe(10);
    expect(writesBackward).toHaveLength(0);
    backward.store.close();
  });

  it("overlapping-trigger-cannot-bypass-pending-window", async () => {
    const dir = join(home, "overlap");
    mkdirSync(dir, { recursive: true });
    const writes: Array<{ conversationId: string; processedLines: number }> = [];
    // The first reflection parks inside the model boundary; an overlapping
    // trigger for the same window must wait on the unfinished wake instead of
    // bypassing it with new work.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parkedModel = new FakeReflectionModel(() => gate.then(() => factEnvelope(DEFAULT_PROPOSALS)));
    const host = makeHost(dir, { model: parkedModel, writes });
    await host.host.reconcile();

    const firstTrigger = host.host.processWindow(reservationInput());
    await waitForModelCalls(parkedModel, 1);

    const secondTrigger = host.host.processWindow(reservationInput());
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([firstTrigger, secondTrigger]);
    expect(firstOutcome.coalesced).toBe(false);
    expect(firstOutcome.blocked).toBe(false);
    expect(secondOutcome.coalesced).toBe(true);
    expect(secondOutcome.blocked).toBe(false);
    // Exactly one reflection for the window; the overlapping trigger finished
    // the pending work instead of bypassing it.
    expect(parkedModel.calls).toBe(1);
    expect(onlyWakeId(dir)).toBe(firstOutcome.record.wakeId);
    expect(host.wakeStore.read(firstOutcome.record.wakeId)?.state).toBe("completed");
    expect(effectReceipts(host.store)).toHaveLength(2);
    expect(curatedRows(host.store, "general")).toHaveLength(1);
    expect(curatedRows(host.store, "user")).toHaveLength(1);
    expect(readCursor(dir)?.processedLines).toBe(BEFORE_LINE);
    expect(writes).toEqual([{ conversationId: CONVERSATION, processedLines: BEFORE_LINE }]);

    // Racing triggers in the same tick coalesce onto the completed wake: no
    // second reflection, no duplicate memory, no extra cursor write.
    const [raceA, raceB] = await Promise.all([
      host.host.processWindow(reservationInput()),
      host.host.processWindow(reservationInput()),
    ]);
    expect(raceA.coalesced).toBe(true);
    expect(raceB.coalesced).toBe(true);
    expect(raceA.blocked).toBe(false);
    expect(raceB.blocked).toBe(false);
    expect(parkedModel.calls).toBe(1);
    expect(effectReceipts(host.store)).toHaveLength(2);
    expect(writes).toEqual([{ conversationId: CONVERSATION, processedLines: BEFORE_LINE }]);
    host.store.close();

    // A pending FAILED window cannot be bypassed either: a later trigger with
    // a working model coalesces onto the failed batch, runs nothing, and
    // leaves the cursor untouched.
    const blockedDir = join(home, "blocked-window");
    mkdirSync(blockedDir, { recursive: true });
    const blockedWrites: Array<{ conversationId: string; processedLines: number }> = [];
    const failing = makeHost(blockedDir, { model: failingModel(), writes: blockedWrites });
    await failing.host.reconcile();
    for (let pass = 0; pass < 3; pass++) {
      const attempt = await failing.host.processWindow(reservationInput());
      expect(attempt.blocked).toBe(true);
    }
    const failedOutcome = await failing.host.processWindow(reservationInput());
    expect(failedOutcome.blocked).toBe(true);
    expect(failedOutcome.record.state).toBe("failed");
    failing.store.close();

    const laterModel = workingModel();
    const later = makeHost(blockedDir, { model: laterModel, writes: blockedWrites });
    const laterReport = await later.host.reconcile();
    expect(laterReport.failed).toEqual([onlyWakeId(blockedDir)]);
    const bypass = await later.host.processWindow(reservationInput());
    expect(bypass.coalesced).toBe(true);
    expect(bypass.blocked).toBe(true);
    expect(bypass.record.state).toBe("failed");
    expect(laterModel.calls).toBe(0);
    expect(effectReceipts(later.store)).toHaveLength(0);
    expect(readCursor(blockedDir)).toBeNull();
    expect(blockedWrites).toHaveLength(0);
    later.store.close();
  });

  it("corrupt-profile-record-and-receipt-block-admission", async () => {
    // Corrupt JSON: admission fails closed, naming the wake.
    const corruptDir = join(home, "corrupt-json");
    mkdirSync(join(corruptDir, "state", "inner-life", "wakes"), { recursive: true });
    writeFileSync(join(wakesDir(corruptDir), "wake_0123456789abcdef.json"), "{not json");
    const corrupt = makeHost(corruptDir, { model: workingModel(), writes: [] });
    expect(corrupt.host.isAdmitted).toBe(false);
    let corruptError: unknown;
    try {
      await corrupt.host.reconcile();
      throw new Error("expected reconciliation to fail closed");
    } catch (err) {
      corruptError = err;
    }
    expect(corruptError).toBeInstanceOf(WakeRecordError);
    expect((corruptError as Error).message).toContain("wake_0123456789abcdef");
    expect((corruptError as Error).message).toContain("malformed JSON");
    expect(corrupt.host.isAdmitted).toBe(false);
    await expect(corrupt.host.processWindow(reservationInput())).rejects.toThrow(AdmissionClosedError);
    corrupt.store.close();

    // A structurally valid record carrying an unsupported profile is
    // corruption too: admission fails closed with the wake identity.
    const profileDir = join(home, "unsupported-profile");
    mkdirSync(join(profileDir, "state", "inner-life", "wakes"), { recursive: true });
    const seededStore = new WakeStore(profileDir);
    await seededStore.reserve(reservationInput());
    const profileWakeId = onlyWakeId(profileDir);
    const rawRecord = JSON.parse(
      readFileSync(wakeRecordPath(profileDir, profileWakeId), "utf-8"),
    ) as { profile: unknown; input: { lines: unknown; fingerprint: string } };
    const foreignProfile = { id: "proactive-contact", version: 1 };
    rawRecord.profile = foreignProfile;
    rawRecord.input.fingerprint = createHash("sha256")
      .update(JSON.stringify({ profile: foreignProfile, lines: rawRecord.input.lines }))
      .digest("hex");
    writeFileSync(wakeRecordPath(profileDir, profileWakeId), JSON.stringify(rawRecord, null, 2));
    const foreign = makeHost(profileDir, { model: workingModel(), writes: [] });
    let profileError: unknown;
    try {
      await foreign.host.reconcile();
      throw new Error("expected the unsupported profile to fail admission");
    } catch (err) {
      profileError = err;
    }
    expect(profileError).toBeInstanceOf(WakeRecordError);
    expect((profileError as Error).message).toContain(profileWakeId);
    expect((profileError as Error).message).toContain("proactive-contact");
    expect(foreign.host.isAdmitted).toBe(false);
    foreign.store.close();

    // Corrupt canonical receipts block admission with the effect identifier:
    // a syntactically valid wrong-shape outcome is corruption, not a replay.
    const receiptDir = join(home, "corrupt-receipt");
    mkdirSync(receiptDir, { recursive: true });
    const receiptWrites: Array<{ conversationId: string; processedLines: number }> = [];
    const healthy = makeHost(receiptDir, { model: workingModel(), writes: receiptWrites });
    await healthy.host.reconcile();
    const healthyOutcome = await healthy.host.processWindow(reservationInput());
    expect(healthyOutcome.blocked).toBe(false);
    healthy.store.close();
    const effectKeys = effectReceipts(
      new MemoryStore(receiptDir, undefined, { budget: new MemoryBudget() }),
    ).map((r) => r.effect_key);
    expect(effectKeys).toHaveLength(2);

    const tamperedStore = new MemoryStore(receiptDir, undefined, { budget: new MemoryBudget() });
    const originalOutcomes = new Map(
      effectReceipts(tamperedStore).map((r) => [r.effect_key, r.outcome]),
    );
    const setOutcome = (effectKey: string, outcome: string): void => {
      tamperedStore.db.database
        .query("UPDATE memory_effect_receipts SET outcome = $outcome WHERE effect_key = $key")
        .run({ $outcome: outcome, $key: effectKey });
    };

    // Wrong shape but valid JSON: must fail closed, not replay verbatim.
    setOutcome(effectKeys[0]!, JSON.stringify({ kind: "added" }));
    const wrongShape = makeHost(receiptDir, { model: workingModel(), writes: receiptWrites });
    let shapeError: unknown;
    try {
      await wrongShape.host.reconcile();
      throw new Error("expected the corrupt receipt to fail admission");
    } catch (err) {
      shapeError = err;
    }
    expect((shapeError as Error).message).toContain("corrupt memory effect receipt");
    expect((shapeError as Error).message).toContain(effectKeys[0]!);
    expect(wrongShape.host.isAdmitted).toBe(false);
    wrongShape.store.close();

    // Non-JSON outcome: same fail-closed treatment, naming the effect.
    setOutcome(effectKeys[0]!, originalOutcomes.get(effectKeys[0]!)!);
    setOutcome(effectKeys[1]!, "this is not json");
    const nonJson = makeHost(receiptDir, { model: workingModel(), writes: receiptWrites });
    let jsonError: unknown;
    try {
      await nonJson.host.reconcile();
      throw new Error("expected the corrupt receipt to fail admission");
    } catch (err) {
      jsonError = err;
    }
    expect((jsonError as Error).message).toContain("corrupt memory effect receipt");
    expect((jsonError as Error).message).toContain(effectKeys[1]!);
    expect(nonJson.host.isAdmitted).toBe(false);
    nonJson.store.close();

    // Repairing the receipt restores admission — fail closed is not sticky.
    setOutcome(effectKeys[1]!, originalOutcomes.get(effectKeys[1]!)!);
    const repaired = makeHost(receiptDir, { model: workingModel(), writes: receiptWrites });
    const repairedReport = await repaired.host.reconcile();
    expect(repairedReport.completed).toEqual([onlyWakeId(receiptDir)]);
    expect(repaired.host.isAdmitted).toBe(true);
    repaired.store.close();

    // An unreadable wake record (EACCES) fails admission; the wake
    // identifier is carried by the record path in the error.
    const unreadableDir = join(home, "unreadable");
    mkdirSync(unreadableDir, { recursive: true });
    const unreadableWrites: Array<{ conversationId: string; processedLines: number }> = [];
    const seededUnreadable = makeHost(unreadableDir, { model: workingModel(), writes: unreadableWrites });
    await seededUnreadable.host.reconcile();
    await seededUnreadable.host.processWindow(reservationInput());
    seededUnreadable.store.close();
    const unreadableId = onlyWakeId(unreadableDir);
    const unreadablePath = wakeRecordPath(unreadableDir, unreadableId);
    chmodSync(unreadablePath, 0o000);
    try {
      const blocked = makeHost(unreadableDir, { model: workingModel(), writes: [] });
      let unreadableError: unknown;
      try {
        await blocked.host.reconcile();
        throw new Error("expected the unreadable record to fail admission");
      } catch (err) {
        unreadableError = err;
      }
      expect((unreadableError as Error).message).toContain(unreadablePath);
      expect(blocked.host.isAdmitted).toBe(false);
      blocked.store.close();
    } finally {
      chmodSync(unreadablePath, 0o600);
    }

    // Validation runs BEFORE any recovery: one corrupt record leaves a healthy
    // interrupted wake untouched and un-attempted.
    const mixedDir = join(home, "mixed");
    mkdirSync(mixedDir, { recursive: true });
    const mixedWrites: Array<{ conversationId: string; processedLines: number }> = [];
    const mixedHealthy = makeHost(mixedDir, { model: workingModel(), writes: mixedWrites });
    await mixedHealthy.host.reconcile();
    await mixedHealthy.wakeStore.reserve(reservationInput());
    mixedHealthy.wakeStore.applyTransition(onlyWakeId(mixedDir), { kind: "begin-attempt" });
    mixedHealthy.store.close();
    writeFileSync(
      join(wakesDir(mixedDir), "wake_ffffffffffffffff.json"),
      "{ broken",
    );
    const mixedModel = sentinelModel();
    const mixed = makeHost(mixedDir, { model: mixedModel, writes: mixedWrites });
    let mixedError: unknown;
    try {
      await mixed.host.reconcile();
      throw new Error("expected the corrupt record to fail admission");
    } catch (err) {
      mixedError = err;
    }
    expect(mixedError).toBeInstanceOf(WakeRecordError);
    expect((mixedError as Error).message).toContain("wake_ffffffffffffffff");
    expect(mixedModel.calls).toBe(0);
    const untouched = new WakeStore(mixedDir).read(onlyWakeId(mixedDir));
    expect(untouched?.state).toBe("reflecting");
    expect(untouched?.attempts).toBe(1);
    expect(readCursor(mixedDir)).toBeNull();
  });
});
