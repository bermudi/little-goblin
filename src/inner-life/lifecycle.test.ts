import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "../memory/store.ts";
import { MemoryBudget } from "../memory/budget.ts";
import { transcriptPath, sessionDir } from "../sessions/paths.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { SchedulerLoop, type SchedulerClock, type SchedulerDispatcher } from "../scheduler/loop.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import { runMigrations } from "../migrate.ts";
import { writeStateVersion } from "../state-version.ts";
import type { MemoryEngine } from "../memory/engine.ts";
import type { Config } from "../config.ts";
import type { ConversationState } from "../sessions/mod.ts";
import type { Surface } from "../surface.ts";
import type { ReflectionModelRequest } from "./reflection.ts";
import { PRIVATE_REFLECTION_SYSTEM_PROMPT } from "./reflection.ts";
import { PRIVATE_FACTS_PROFILE, WakeStore, type WakeReservationInput } from "./wake-store.ts";
import { wakesDir } from "./paths.ts";
import { AdmissionClosedError, type ReflectionCursorState } from "./recovery.ts";
import {
  createInnerLifeLifecycle,
  FileReflectionCursorStore,
  type DreamingPhaseQueue,
  type InnerLifeLifecycle,
  type LightSleepTranscripts,
} from "./light-sleep.ts";

/**
 * Lifecycle verifier for Litespec #67 unit "Route light sleep through the
 * private host".
 *
 * Scenarios (exact names from the issue):
 * - [L1] scheduled-fact-reaches-memory-with-no-conversation-or-telegram
 * - [L1] reconciliation-finishes-before-polling-and-timers
 * - [L2] seed-batch-lookback-append-and-global-phase-regressions
 * - [L2] heartbeat-rem-deep-and-sync-remain-independent
 * - [L3] shutdown-fences-admission-and-late-effect-with-bounded-disposal
 * - [L3] source-read-and-cursor-write-failures-preserve-progress
 * - [L4] disabled-memory-and-unavailable-model-do-not-borrow-runtime
 *
 * Every scenario drives REAL persisted state (wake files, SQLite memory,
 * cursor files, transcript files) through the production composition with
 * deterministic fake model/timer boundaries. No live or paid provider call
 * exists on any path here, and no Telegram traffic is generated.
 */

const TS = "2026-07-04T06:00:00.000Z";
const NOW_MS = Date.parse("2026-07-04T12:00:00.000Z");
const EXPIRED_TS = "2026-07-03T00:00:00.000Z"; // 36h before NOW: outside a 24h lookback
const MADRID_SURFACE = surfaceId(dmSurface(4242));

// ---------------------------------------------------------------------------
// Model fake
// ---------------------------------------------------------------------------

interface FactProposal {
  target: "memory" | "user";
  line: number;
  text: string;
}

function factEnvelope(proposals: FactProposal[]): string {
  return JSON.stringify({
    version: 1,
    proposals: proposals.map((p) => ({ kind: "fact", ...p })),
  });
}

const EMPTY_ENVELOPE = JSON.stringify({ version: 1, proposals: [] });

/** Deterministic counting model boundary with optional hold/release. */
class FakeReflectionModel {
  calls = 0;
  readonly requests: ReflectionModelRequest[] = [];
  private holding = false;
  private readonly parked: Array<{ resolve: (v: string) => void }> = [];

  constructor(
    private readonly respond: (request: ReflectionModelRequest, call: number) => string = () =>
      factEnvelope([{ target: "memory", line: 0, text: "I live in Madrid" }]),
  ) {}

  readonly invoker = (request: ReflectionModelRequest): Promise<string> => {
    this.calls += 1;
    this.requests.push(request);
    if (this.holding) {
      return new Promise<string>((resolve) => {
        this.parked.push({ resolve });
      });
    }
    return Promise.resolve(this.respond(request, this.calls));
  };

  /** The next invocation parks until release() (or forever with hangForever). */
  holdNext(): void {
    this.holding = true;
  }

  /** Never resolve parked invocations (shutdown cancellation must still settle). */
  hangForever(): void {
    this.holdNext();
  }

  release(output: string): void {
    this.holding = false;
    for (const parked of this.parked.splice(0)) parked.resolve(output);
  }
}

// ---------------------------------------------------------------------------
// Transcript helpers (real files, the same JSONL shape the writer produces)
// ---------------------------------------------------------------------------

function appendTranscriptLine(
  home: string,
  conversationId: string,
  entry: { role: "user" | "assistant"; text: string; ts?: string; sourceSurfaceId?: string },
): number {
  const path = transcriptPath(home, conversationId);
  mkdirSync(dirname(path), { recursive: true });
  let index = 0;
  if (existsSync(path)) {
    index = readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  }
  const record: Record<string, unknown> = {
    ts: entry.ts ?? TS,
    role: entry.role,
    content: [{ type: "text", text: entry.text }],
  };
  if (entry.sourceSurfaceId !== undefined) record.sourceSurfaceId = entry.sourceSurfaceId;
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  return index;
}

// ---------------------------------------------------------------------------
// Persisted-state inspection helpers
// ---------------------------------------------------------------------------

function wakeIds(home: string): string[] {
  try {
    return readdirSync(wakesDir(home))
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function readWake(home: string, wakeId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(wakesDir(home), `${wakeId}.json`), "utf-8"),
  ) as Record<string, unknown>;
}

function readCursor(home: string, conversationId: string): ReflectionCursorState | null {
  return new FileReflectionCursorStore(home).read(conversationId);
}

interface CuratedRow {
  id: string;
  text: string;
}

function curatedRows(store: MemoryStore, scope: string): CuratedRow[] {
  return store.db.database
    .query<CuratedRow, { $scope: string }>(
      `SELECT id, text FROM memory_entries
       WHERE scope = $scope AND entry_kind IN ('memory', 'user')
       ORDER BY id`,
    )
    .all({ $scope: scope });
}

function effectReceiptCount(store: MemoryStore): number {
  return store.db.database
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_effect_receipts")
    .get()!.n;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Run work with a directory made read-only, restoring permissions even on failure. */
async function runWithReadOnlyDir(path: string, work: () => Promise<void>): Promise<void> {
  chmodSync(path, 0o500);
  try {
    await work();
  } finally {
    chmodSync(path, 0o700);
  }
}

// ---------------------------------------------------------------------------
// Scheduler fakes (deterministic clock and dispatcher)
// ---------------------------------------------------------------------------

interface FakeTimer {
  ms: number;
  callback: () => void;
  cleared: boolean;
  clear(): void;
}

function fakeClock(): { clock: SchedulerClock; timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  return {
    timers,
    clock: {
      now: () => NOW_MS,
      setInterval: (callback, ms) => {
        const timer: FakeTimer = {
          ms,
          callback,
          cleared: false,
          clear: () => {
            timer.cleared = true;
          },
        };
        timers.push(timer);
        return timer;
      },
    },
  };
}

function fakeDispatcher(): SchedulerDispatcher & {
  calls: { conversation: ConversationState; surface: Surface; content: string }[];
} {
  const calls: { conversation: ConversationState; surface: Surface; content: string }[] = [];
  return {
    calls,
    runtimeAdmissionOpen: () => true,
    enqueueScheduledTurn(conversation, surface, content) {
      calls.push({ conversation, surface, content });
      return true;
    },
    // NOTE: no enqueueInternalTurn — the private-host path must not need one.
  };
}

/** Counting wrapper around the lifecycle's lightSleep seam. */
function spyLightSleep(lifecycle: InnerLifeLifecycle): {
  spy: { calls: number };
  seam: { runPass(): Promise<void> };
} {
  const spy = { calls: 0 };
  return {
    spy,
    seam: {
      runPass: async () => {
        spy.calls += 1;
        await lifecycle.lightSleep.runPass();
      },
    },
  };
}

function minimalConfig(modelName: string, home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName,
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
    favorites: [],
    voiceName: "test-voice",
  };
}

/** Fake memory engine for scheduler REM/deep/sync wiring (sentinels on the old light-sleep path). */
function fakeMemoryEngine(): MemoryEngine & {
  readonly syncCalls: number;
  readonly remCalls: number;
  readonly deepCalls: number;
} {
  const state = { syncCalls: 0, remCalls: 0, deepCalls: 0 };
  return {
    get syncCalls() {
      return state.syncCalls;
    },
    get remCalls() {
      return state.remCalls;
    },
    get deepCalls() {
      return state.deepCalls;
    },
    syncTranscripts: async () => {
      state.syncCalls += 1;
      return { indexed: 0, removed: 0, inserted: 0 };
    },
    dreaming: {
      runLightSleep: async () => {
        throw new Error("sentinel: light sleep must not route through DreamingPipeline");
      },
      setExtractor: () => {
        throw new Error("sentinel: no dreaming extractor may be installed for light sleep");
      },
      runRemSleep: async () => {
        state.remCalls += 1;
      },
      runDeepSleep: async () => {
        state.deepCalls += 1;
      },
    },
  } as unknown as MemoryEngine & {
    readonly syncCalls: number;
    readonly remCalls: number;
    readonly deepCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle fixture
// ---------------------------------------------------------------------------

interface LifecycleFixture {
  lifecycle: InnerLifeLifecycle;
  store: MemoryStore;
  model: FakeReflectionModel;
  errors: Array<{ conversationId: string; err: unknown }>;
  metrics: { counters: Array<{ name: string; scope: string | null; delta: number }> };
}

function makeLifecycle(
  dir: string,
  opts: {
    conversations?: { list(): ReadonlyArray<{ id: string }> };
    model?: FakeReflectionModel;
    config?: Config;
    lookbackHours?: number;
    batchLimitLines?: number;
    phases?: DreamingPhaseQueue;
    transcripts?: LightSleepTranscripts;
  } = {},
): LifecycleFixture {
  const model = opts.model ?? new FakeReflectionModel();
  const store = new MemoryStore(dir, undefined, { budget: new MemoryBudget() });
  const errors: Array<{ conversationId: string; err: unknown }> = [];
  const counters: Array<{ name: string; scope: string | null; delta: number }> = [];
  const lifecycle = createInnerLifeLifecycle({
    home: dir,
    memory: store,
    conversations: opts.conversations ?? { list: () => [] },
    model: { invoker: model.invoker, deadlineMs: 10_000 },
    ...(opts.config !== undefined ? { config: opts.config, model: undefined } : {}),
    ...(opts.phases !== undefined ? { phases: opts.phases } : {}),
    ...(opts.transcripts !== undefined ? { transcripts: opts.transcripts } : {}),
    lookbackHours: opts.lookbackHours ?? 24,
    batchLimitLines: opts.batchLimitLines ?? 100,
    now: () => new Date(NOW_MS),
    onConversationError: (conversationId, err) => errors.push({ conversationId, err }),
    metrics: {
      incrementCounter: (name, scope, delta = 1) => counters.push({ name, scope, delta }),
    },
  });
  return { lifecycle, store, model, errors, metrics: { counters } };
}

// ---------------------------------------------------------------------------

describe("private reflection lifecycle", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-lifecycle-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("scheduled-fact-reaches-memory-with-no-conversation-or-telegram", async () => {
    const dir = join(home, "scheduled");
    mkdirSync(dir, { recursive: true });
    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });
    appendTranscriptLine(dir, conversationId, { role: "assistant", text: "Noted." });

    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
    });
    const report = await fixture.lifecycle.reconcile();
    expect(report.completed).toEqual([]);
    expect(fixture.lifecycle.host.isAdmitted).toBe(true);
    // A pre-existing checkpoint: the conversation has a backlog to drain.
    new FileReflectionCursorStore(dir).write(conversationId, { processedLines: 0, lastDreamedAt: TS });

    const clockState = fakeClock();
    const dispatcher = fakeDispatcher();
    const scheduler = new SchedulerLoop({
      store: new ScheduleStore(dir),
      lifecycle: { resolveCurrent: async () => null },
      dispatcher,
      clock: clockState.clock,
      home: dir,
      lightSleep: fixture.lifecycle.lightSleep,
      tickIntervalMs: 101,
      transcriptSyncIntervalMs: Number.POSITIVE_INFINITY,
      dreamingLightIntervalMs: 1000,
      dreamingRemIntervalMs: Number.POSITIVE_INFINITY,
      dreamingDeepIntervalMs: Number.POSITIVE_INFINITY,
    });
    scheduler.start();

    // Real light-sleep scheduling: the installed memory timer signals the
    // private host, and the fact is stored through it.
    const lightTimer = clockState.timers.find((timer) => timer.ms === 1000);
    expect(lightTimer).toBeDefined();
    lightTimer!.callback();
    await waitFor(
      () => readCursor(dir, conversationId)?.processedLines === 2,
      "the scheduled pass to drain the window",
    );

    // The fact reached canonical memory through the private host.
    const rows = curatedRows(fixture.store, "general");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("I live in Madrid");
    expect(effectReceiptCount(fixture.store)).toBe(1);

    // The wake record completed under state/inner-life/wakes.
    expect(wakeIds(dir)).toHaveLength(1);
    const record = readWake(dir, wakeIds(dir)[0]!);
    expect(record.state).toBe("completed");
    expect(record.profile).toEqual(PRIVATE_FACTS_PROFILE);

    // The model boundary received ONLY the code-owned prompt and captured
    // input: no tools, no history, no Telegram destination.
    expect(fixture.model.requests).toHaveLength(1);
    const request = fixture.model.requests[0]!;
    expect(Object.keys(request).sort()).toEqual(["signal", "systemPrompt", "userPrompt"]);
    expect(request.systemPrompt).toBe(PRIVATE_REFLECTION_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("I live in Madrid");

    // No dreaming internal conversation runtime was created or reused.
    expect(existsSync(sessionDir(dir, "__goblin_dreaming__"))).toBe(false);
    // No Surface dispatch and no Telegram output: the scheduler never
    // enqueued a scheduled turn, and the dispatcher has no internal-turn seam.
    expect(dispatcher.calls).toHaveLength(0);
    expect((dispatcher as unknown as Record<string, unknown>).enqueueInternalTurn).toBeUndefined();

    scheduler.stop();
    fixture.lifecycle.dispose();
  });

  it("reconciliation-finishes-before-polling-and-timers", async () => {
    const dir = join(home, "reconcile-first");
    mkdirSync(dir, { recursive: true });
    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });
    appendTranscriptLine(dir, conversationId, { role: "assistant", text: "Noted." });

    // An interrupted reflection from a previous boot: reserved, one attempt
    // begun, no outcome yet.
    const wakeStore = new WakeStore(dir);
    const input: WakeReservationInput = {
      conversationId,
      afterLine: 0,
      beforeLine: 2,
      profile: PRIVATE_FACTS_PROFILE,
      lines: [
        { index: 0, role: "user", text: "I live in Madrid", ts: TS, sourceSurfaceId: MADRID_SURFACE },
        { index: 1, role: "assistant", text: "Noted.", ts: TS },
      ],
    };
    await wakeStore.reserve(input);
    const wakeId = wakeIds(dir)[0]!;
    wakeStore.applyTransition(wakeId, { kind: "begin-attempt" });

    const model = new FakeReflectionModel();
    model.holdNext();
    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      model,
    });

    // Before reconciliation the deployment admits nothing: a timer-fired
    // light-sleep pass is skipped entirely (no seeding, no new wake, no
    // model call). This is the gate that keeps reconciliation ahead of the
    // memory timers and Telegram polling in startup order.
    expect(fixture.lifecycle.host.isAdmitted).toBe(false);
    await fixture.lifecycle.lightSleep.runPass();
    expect(readCursor(dir, conversationId)).toBeNull();
    expect(wakeIds(dir)).toEqual([wakeId]);
    expect(model.calls).toBe(0);

    // Reconciliation is in flight (model held): the pass stays skipped and
    // the interrupted wake is not double-driven.
    const reconciling = fixture.lifecycle.reconcile();
    await waitFor(() => model.calls === 1, "reconciliation to reach the model");
    expect(readWake(dir, wakeId).attempts).toBe(2);
    await fixture.lifecycle.lightSleep.runPass();
    expect(wakeIds(dir)).toEqual([wakeId]);
    expect(model.calls).toBe(1);
    expect(readCursor(dir, conversationId)).toBeNull();

    model.release(factEnvelope([{ target: "memory", line: 0, text: "I live in Madrid" }]));
    const report = await reconciling;
    expect(report.completed).toEqual([wakeId]);
    expect(fixture.lifecycle.host.isAdmitted).toBe(true);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(2);
    expect(curatedRows(fixture.store, "general")).toHaveLength(1);

    // After reconciliation the timer path works and converges without
    // re-reflecting the completed window.
    await fixture.lifecycle.lightSleep.runPass();
    expect(model.calls).toBe(1);
    expect(wakeIds(dir)).toEqual([wakeId]);
    expect(curatedRows(fixture.store, "general")).toHaveLength(1);

    fixture.lifecycle.dispose();
  });

  it("seed-batch-lookback-append-and-global-phase-regressions", async () => {
    const dir = join(home, "backlog");
    mkdirSync(dir, { recursive: true });
    const conversations = new ConversationStore(dir);
    const kept = conversations.create(personalEnvironment());
    const archived = conversations.create(personalEnvironment());
    conversations.archive(archived.id);
    const conversationId = kept.id;

    const model = new FakeReflectionModel();
    const phases = ((): DreamingPhaseQueue & { order: string[] } => {
      const order: string[] = [];
      let tail: Promise<void> = Promise.resolve();
      return {
        order,
        runExclusivePhase: async <T,>(fn: () => Promise<T>): Promise<T> => {
          const run = async (): Promise<T> => {
            order.push("enter");
            try {
              return await fn();
            } finally {
              order.push("exit");
            }
          };
          const next = tail.then(run, run);
          tail = next.then(() => undefined, () => undefined);
          return next;
        },
      };
    })();

    const fixture = makeLifecycle(dir, {
      conversations,
      model,
      batchLimitLines: 1,
      phases,
    });
    await fixture.lifecycle.reconcile();

    // Fresh-cursor seeding: a conversation with no cursor seeds to the
    // current transcript end and extracts nothing.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "seed one" });
    appendTranscriptLine(dir, conversationId, { role: "assistant", text: "seed two" });
    appendTranscriptLine(dir, conversationId, { role: "user", text: "seed three" });
    await fixture.lifecycle.lightSleep.runPass();
    expect(readCursor(dir, conversationId)?.processedLines).toBe(3);
    expect(model.calls).toBe(0);
    expect(wakeIds(dir)).toEqual([]);
    // Enumeration regression: only non-archived Conversations are visited.
    expect(readCursor(dir, archived.id)).toBeNull();

    // Finite batch draining: one line per wake, sequential windows.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "batch line A" });
    appendTranscriptLine(dir, conversationId, { role: "user", text: "batch line B" });
    await fixture.lifecycle.lightSleep.runPass();
    expect(model.calls).toBe(2);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(5);
    expect(wakeIds(dir)).toHaveLength(2);
    const windows = wakeIds(dir).map((id) => {
      const source = readWake(dir, id).source as { afterLine: number; beforeLine: number };
      return { afterLine: source.afterLine, beforeLine: source.beforeLine };
    });
    expect(windows).toContainEqual({ afterLine: 3, beforeLine: 4 });
    expect(windows).toContainEqual({ afterLine: 4, beforeLine: 5 });

    // Lookback filtering: an expired line is warned and counted, never
    // reflected; the fresh sibling line is still extracted.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "too old", ts: EXPIRED_TS });
    appendTranscriptLine(dir, conversationId, { role: "user", text: "fresh after expiry" });
    await fixture.lifecycle.lightSleep.runPass();
    expect(fixture.metrics.counters).toContainEqual({
      name: "memory_dreaming_expired_lines_total",
      scope: null,
      delta: 1,
    });
    expect(model.calls).toBe(3);
    expect(model.requests[2]!.userPrompt).toContain("fresh after expiry");
    expect(model.requests[2]!.userPrompt).not.toContain("too old");
    expect(readCursor(dir, conversationId)?.processedLines).toBe(7);

    // Append-during-reflection: the snapshot is finite. Lines appended while
    // a batch is in flight wait for a later snapshot.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "in-flight batch" });
    model.holdNext();
    const draining = fixture.lifecycle.lightSleep.runPass();
    await waitFor(() => model.calls === 4, "the held batch reflection");
    appendTranscriptLine(dir, conversationId, { role: "user", text: "arrived during reflection" });
    model.release(EMPTY_ENVELOPE);
    await draining;
    expect(readCursor(dir, conversationId)?.processedLines).toBe(8);
    // The next finite snapshot picks the appended line up.
    await fixture.lifecycle.lightSleep.runPass();
    expect(model.calls).toBe(5);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(9);

    // Global dreaming-phase coordination: light-sleep work serializes on the
    // same queue as REM/deep and never overlaps a queued phase.
    let releaseRem!: () => void;
    const remDone = new Promise<void>((resolve) => {
      releaseRem = resolve;
    });
    const rem = phases.runExclusivePhase(async () => {
      phases.order.push("rem");
      await remDone;
    });
    await waitFor(() => phases.order.includes("rem"), "the queued REM phase");
    appendTranscriptLine(dir, conversationId, { role: "user", text: "after rem" });
    const lightWork = fixture.lifecycle.lightSleep.runPass();
    await Bun.sleep(20);
    expect(model.calls).toBe(5); // still parked behind the REM phase
    releaseRem();
    await Promise.all([rem, lightWork]);
    expect(model.calls).toBe(6);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(10);
    // Every light-sleep conversation pass ran inside the phase queue.
    expect(phases.order.filter((entry) => entry === "enter").length).toBeGreaterThanOrEqual(6);

    // Per-Conversation serialization: overlapping passes coalesce; the
    // window reflects once and the trailing pending pass finds no backlog.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "overlap probe" });
    await Promise.all([
      fixture.lifecycle.lightSleep.runPass(),
      fixture.lifecycle.lightSleep.runPass(),
    ]);
    expect(model.calls).toBe(7);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(11);

    fixture.lifecycle.dispose();
  });

  // W5 direct-fix regression (issue #67 closure review): a legacy pre-sidecar
  // cursor must survive the offline migration and drive the first light-sleep
  // pass over the remaining backlog — never a fresh seed at transcript end.
  it("migrated-legacy-cursor-drains-remaining-lines-not-transcript-end", async () => {
    const dir = join(home, "legacy-migrated");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeStateVersion(dir, 5);

    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, { role: "user", text: "already reflected one" });
    appendTranscriptLine(dir, conversationId, { role: "assistant", text: "already reflected two" });
    appendTranscriptLine(dir, conversationId, { role: "user", text: "already reflected three" });
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });
    appendTranscriptLine(dir, conversationId, { role: "assistant", text: "Noted." });

    // A pre-sidecar deployment cursor: the first three lines are processed.
    mkdirSync(sessionDir(dir, conversationId), { recursive: true });
    writeFileSync(
      join(sessionDir(dir, conversationId), "memory-reflection.json"),
      JSON.stringify({ processedLines: 3, lastReflectedAt: TS }),
    );

    // Offline upgrade: the legacy cursor converts into the sidecar the
    // private-host adapter reads.
    runMigrations(dir);
    expect(readCursor(dir, conversationId)).toEqual({ processedLines: 3, lastDreamedAt: TS });

    const model = new FakeReflectionModel(() =>
      factEnvelope([{ target: "memory", line: 3, text: "I live in Madrid" }]),
    );
    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      model,
    });
    await fixture.lifecycle.reconcile();
    await fixture.lifecycle.lightSleep.runPass();

    // The unprocessed backlog was reflected, not skipped: the wake covers
    // exactly lines 3–4 and the cursor advanced from the legacy value.
    expect(readCursor(dir, conversationId)?.processedLines).toBe(5);
    expect(fixture.model.calls).toBe(1);
    expect(fixture.model.requests[0]!.userPrompt).toContain("I live in Madrid");
    expect(fixture.model.requests[0]!.userPrompt).not.toContain("already reflected");
    expect(curatedRows(fixture.store, "general").map((row) => row.text)).toEqual(["I live in Madrid"]);
    const record = readWake(dir, wakeIds(dir)[0]!);
    expect(record.state).toBe("completed");
    const source = record.source as { afterLine: number; beforeLine: number };
    expect(source.afterLine).toBe(3);
    expect(source.beforeLine).toBe(5);

    fixture.lifecycle.dispose();
  });

  it("heartbeat-rem-deep-and-sync-remain-independent", async () => {
    const dir = join(home, "independent");
    mkdirSync(dir, { recursive: true });
    const conversationStore = new ConversationStore(dir);
    const conversation = conversationStore.create(personalEnvironment());
    const surface = dmSurface(100);

    const memoryEngine = fakeMemoryEngine();
    const fixture = makeLifecycle(dir, { conversations: conversationStore });
    const light = spyLightSleep(fixture.lifecycle);

    const clockState = fakeClock();
    const dispatcher = fakeDispatcher();
    const scheduler = new SchedulerLoop({
      store: new ScheduleStore(dir),
      lifecycle: { resolveCurrent: async () => conversation },
      dispatcher,
      clock: clockState.clock,
      home: dir,
      memoryEngine,
      lightSleep: light.seam,
      tickIntervalMs: 101,
      transcriptSyncIntervalMs: 202,
      dreamingLightIntervalMs: 1000,
    });
    scheduler.start();

    // All five timers installed: tick, transcript sync, light sleep, and the
    // two aligned REM/deep initial timers.
    expect(clockState.timers).toHaveLength(5);
    for (const ms of [101, 202, 1000]) {
      expect(clockState.timers.some((timer) => timer.ms === ms)).toBe(true);
    }
    const aligned = clockState.timers.filter((timer) => ![101, 202, 1000].includes(timer.ms));
    expect(aligned).toHaveLength(2);

    // Transcript sync keeps its interval behavior.
    clockState.timers.find((timer) => timer.ms === 202)!.callback();
    await waitFor(() => memoryEngine.syncCalls === 1, "transcript sync");

    // REM and deep sleep keep their aligned-timer behavior and never touch
    // the private host.
    for (const timer of aligned) timer.callback();
    await waitFor(
      () => memoryEngine.remCalls === 1 && memoryEngine.deepCalls === 1,
      "REM and deep sleep",
    );

    // The light timer signals the private host, not the dreaming pipeline.
    clockState.timers.find((timer) => timer.ms === 1000)!.callback();
    await waitFor(() => light.spy.calls === 1, "the light-sleep pass signal");
    expect(fixture.model.calls).toBe(0);

    // Heartbeat scheduling is unchanged.
    const store = new ScheduleStore(dir);
    store.setHeartbeat({
      surface,
      enabled: true,
      now: new Date(NOW_MS - 1800_000).toISOString(),
    });
    await scheduler.tick();
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.content.startsWith("[heartbeat]")).toBe(true);
    expect(fixture.model.calls).toBe(0);

    scheduler.stop();
    fixture.lifecycle.dispose();
  });

  it("shutdown-fences-admission-and-late-effect-with-bounded-disposal", async () => {
    const dir = join(home, "shutdown");
    mkdirSync(dir, { recursive: true });
    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });

    const model = new FakeReflectionModel(() =>
      factEnvelope([{ target: "memory", line: 0, text: "I live in Madrid" }]),
    );
    model.hangForever();
    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      model,
    });
    await fixture.lifecycle.reconcile();
    // A pre-existing checkpoint: the pass has a window to reflect on.
    new FileReflectionCursorStore(dir).write(conversationId, { processedLines: 0, lastDreamedAt: TS });

    const draining = fixture.lifecycle.lightSleep.runPass();
    await waitFor(() => model.calls === 1, "the in-flight reflection");

    // Shutdown closes wake admission synchronously (no await, no promise).
    const closed = fixture.lifecycle.close();
    expect(closed).toBeUndefined();
    expect(fixture.lifecycle.host.isAdmitted).toBe(false);

    // Disposal settles promptly even though the model invocation hangs
    // forever: cancellation releases the reflection boundary well inside the
    // 5-second bound.
    const startedAt = Date.now();
    await fixture.lifecycle.settle();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(5000);

    // The cancelled attempt stays resumable: no memory effect, no cursor
    // advancement, no completion.
    expect(wakeIds(dir)).toHaveLength(1);
    const record = readWake(dir, wakeIds(dir)[0]!);
    expect(record.state).toBe("reflecting");
    expect(record.attempts).toBe(1);
    expect(effectReceiptCount(fixture.store)).toBe(0);
    expect(curatedRows(fixture.store, "general")).toHaveLength(0);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(0);

    // Late model output after shutdown is fenced: resolving the hung
    // invocation now must not write memory.
    model.release(factEnvelope([{ target: "memory", line: 0, text: "I live in Madrid" }]));
    await draining;
    await Bun.sleep(20);
    expect(effectReceiptCount(fixture.store)).toBe(0);
    expect(curatedRows(fixture.store, "general")).toHaveLength(0);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(0);

    // New wake work is refused after close.
    const lateInput: WakeReservationInput = {
      conversationId,
      afterLine: 0,
      beforeLine: 1,
      profile: PRIVATE_FACTS_PROFILE,
      lines: [
        { index: 0, role: "user", text: "I live in Madrid", ts: TS, sourceSurfaceId: MADRID_SURFACE },
      ],
    };
    await expect(fixture.lifecycle.host.processWindow(lateInput)).rejects.toThrow(AdmissionClosedError);

    // close() is idempotent; settle() with no active drives resolves.
    fixture.lifecycle.close();
    await fixture.lifecycle.settle();
    fixture.lifecycle.dispose();
  });

  it("source-read-and-cursor-write-failures-preserve-progress", async () => {
    const dir = join(home, "source-failures");
    mkdirSync(dir, { recursive: true });
    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });
    appendTranscriptLine(dir, conversationId, { role: "user", text: "second line" });

    const cursors = new FileReflectionCursorStore(dir);
    const conversationSessionDir = sessionDir(dir, conversationId);

    // Source read failure: observable, progress unadvanced, no wake, no
    // model call, and not an empty successful batch.
    const readFailure = Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES" });
    const brokenReads: LightSleepTranscripts = {
      countLines: () => 2,
      readAfter: () => {
        throw readFailure;
      },
    };
    cursors.write(conversationId, { processedLines: 0, lastDreamedAt: TS });
    const broken = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      transcripts: brokenReads,
    });
    await broken.lifecycle.reconcile();
    await broken.lifecycle.lightSleep.runPass();
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]!.conversationId).toBe(conversationId);
    expect(broken.errors[0]!.err).toBe(readFailure);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(0);
    expect(wakeIds(dir)).toEqual([]);
    expect(broken.model.calls).toBe(0);
    broken.lifecycle.dispose();

    // Cursor write failure at the wake-completion checkpoint (real EACCES on
    // the checkpoint directory): the failure is observable, the durable wake
    // outcome stands, and no progress is silently recorded.
    const model = new FakeReflectionModel();
    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      model,
    });
    await fixture.lifecycle.reconcile();
    const callsAfterFixtureReconcile = model.calls;
    await runWithReadOnlyDir(conversationSessionDir, () => fixture.lifecycle.lightSleep.runPass());
    expect(fixture.errors).toHaveLength(1);
    expect((fixture.errors[0]!.err as Error).message).toContain("EACCES");
    // The wake completed durably; only the checkpoint is missing.
    expect(wakeIds(dir)).toHaveLength(1);
    expect(readWake(dir, wakeIds(dir)[0]!).state).toBe("completed");
    expect(curatedRows(fixture.store, "general")).toHaveLength(1);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(0);

    // A healed checkpoint converges: reconciliation repairs the completed-
    // but-uncheckpointed wake before admission (no new reflection, no
    // duplicate memory), and a pass finds no backlog left.
    const callsBeforeHeal = model.calls;
    const healed = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      model,
    });
    await healed.lifecycle.reconcile();
    await healed.lifecycle.lightSleep.runPass();
    expect(callsBeforeHeal).toBe(callsAfterFixtureReconcile + 1);
    expect(model.calls).toBe(callsBeforeHeal);
    expect(wakeIds(dir)).toHaveLength(1);
    expect(curatedRows(fixture.store, "general")).toHaveLength(1);
    expect(effectReceiptCount(fixture.store)).toBe(1);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(2);

    // An expired-only batch whose skip-checkpoint write fails (real EACCES)
    // is an observed error, never a quiet empty successful batch.
    appendTranscriptLine(dir, conversationId, { role: "user", text: "stale", ts: EXPIRED_TS });
    const errorsBeforeSkipProbe = healed.errors.length;
    await runWithReadOnlyDir(conversationSessionDir, () => healed.lifecycle.lightSleep.runPass());
    expect(healed.errors).toHaveLength(errorsBeforeSkipProbe + 1);
    expect((healed.errors[errorsBeforeSkipProbe]!.err as Error).message).toContain("EACCES");
    expect(readCursor(dir, conversationId)?.processedLines).toBe(2);
    // The retried skip checkpoint advances without a wake or model call.
    await healed.lifecycle.lightSleep.runPass();
    expect(healed.errors).toHaveLength(errorsBeforeSkipProbe + 1);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(3);
    expect(model.calls).toBe(callsBeforeHeal);

    // Seeding write failure (real EACCES inside the new conversation's own
    // session directory): observable, cursor stays absent, no reflection.
    const freshConversation = "conversation-b";
    appendTranscriptLine(dir, freshConversation, { role: "user", text: "fresh seed" });
    const freshSessionDir = sessionDir(dir, freshConversation);
    const seeder = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }, { id: freshConversation }] },
      model,
    });
    await seeder.lifecycle.reconcile();
    const errorsBeforeSeedProbe = seeder.errors.length;
    await runWithReadOnlyDir(freshSessionDir, () => seeder.lifecycle.lightSleep.runPass());
    expect(seeder.errors).toHaveLength(errorsBeforeSeedProbe + 1);
    expect(seeder.errors[errorsBeforeSeedProbe]!.conversationId).toBe(freshConversation);
    expect((seeder.errors[errorsBeforeSeedProbe]!.err as Error).message).toContain("EACCES");
    expect(readCursor(dir, freshConversation)).toBeNull();
    expect(model.calls).toBe(callsBeforeHeal);

    fixture.lifecycle.dispose();
    healed.lifecycle.dispose();
    seeder.lifecycle.dispose();
  });

  it("disabled-memory-and-unavailable-model-do-not-borrow-runtime", async () => {
    // Memory-disabled deployment: the scheduler wires no light-sleep timer,
    // signals no passes, and no wake storage is created.
    const disabledDir = join(home, "memory-disabled");
    mkdirSync(disabledDir, { recursive: true });
    const clockState = fakeClock();
    const scheduler = new SchedulerLoop({
      store: new ScheduleStore(disabledDir),
      lifecycle: { resolveCurrent: async () => null },
      dispatcher: fakeDispatcher(),
      clock: clockState.clock,
      home: disabledDir,
      tickIntervalMs: 101,
      dreamingLightIntervalMs: 1000,
      transcriptSyncIntervalMs: Number.POSITIVE_INFINITY,
      dreamingRemIntervalMs: Number.POSITIVE_INFINITY,
      dreamingDeepIntervalMs: Number.POSITIVE_INFINITY,
    });
    scheduler.start();
    expect(clockState.timers.map((timer) => timer.ms)).toEqual([101]);
    await scheduler.tick();
    scheduler.stop();
    expect(existsSync(join(disabledDir, "state", "inner-life"))).toBe(false);

    // Configured-but-unavailable model: every attempt records the failure
    // with no fallback model and no borrowed conversation runtime.
    const dir = join(home, "unavailable-model");
    mkdirSync(dir, { recursive: true });
    const conversationId = "conversation-a";
    appendTranscriptLine(dir, conversationId, {
      role: "user",
      text: "I live in Madrid",
      sourceSurfaceId: MADRID_SURFACE,
    });
    const fixture = makeLifecycle(dir, {
      conversations: { list: () => [{ id: conversationId }] },
      config: minimalConfig("definitely-unavailable-model", dir),
    });
    await fixture.lifecycle.reconcile();
    // A pre-existing checkpoint: the pass has a window to reflect on.
    new FileReflectionCursorStore(dir).write(conversationId, { processedLines: 0, lastDreamedAt: TS });
    // The injected seam must be unused when a config-driven engine is selected.
    expect(fixture.model.calls).toBe(0);
    for (let i = 0; i < 3; i++) {
      await fixture.lifecycle.lightSleep.runPass();
    }
    expect(wakeIds(dir)).toHaveLength(1);
    const record = readWake(dir, wakeIds(dir)[0]!);
    expect(record.state).toBe("failed");
    expect(record.attempts).toBe(3);
    const failure = (record.failure as { reason: string }).reason;
    expect(failure).toContain("config-unavailable");
    expect(failure).toContain('Unknown MODEL_NAME "definitely-unavailable-model"');
    expect(effectReceiptCount(fixture.store)).toBe(0);
    expect(curatedRows(fixture.store, "general")).toHaveLength(0);
    expect(readCursor(dir, conversationId)?.processedLines).toBe(0);
    // The dreaming internal conversation runtime was never borrowed: no
    // internal session artifacts exist anywhere under the home.
    expect(existsSync(sessionDir(dir, "__goblin_dreaming__"))).toBe(false);

    fixture.lifecycle.dispose();
  });
});
