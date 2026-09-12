import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, MemoryEffectConflictError } from "../memory/store.ts";
import { memoryDreamingCursorPath } from "../sessions/paths.ts";
import { MemoryBudget } from "../memory/budget.ts";
import { EmbeddingProvider } from "../memory/embeddings.ts";
import { MemoryDatabase } from "../memory/db.ts";
import { MEMORY_SCHEMA_VERSION } from "../memory/schema.ts";
import { MemoryArtifactStore } from "../memory/artifacts.ts";
import {
  dreamDiaryPath,
  memoryDbPath,
  quarantinePath,
  quarantineRotatedPath,
} from "../memory/paths.ts";
import type {
  MemoryEffectOutcome,
  MemoryEffectRejectionReason,
  MemoryFactEffect,
} from "../memory/policy.ts";
import { runMigrations } from "../migrate.ts";
import {
  CURRENT_STATE_VERSION,
  readStateVersion,
  writeStateVersion,
} from "../state-version.ts";
import { log } from "../log.ts";
import { dmSurface, topicSurface, surfaceId } from "../surface.ts";
import {
  PRIVATE_FACTS_PROFILE,
  WakeStore,
  type AcceptedIntent,
  type WakeInputLine,
  type WakeRole,
} from "./wake-store.ts";
import { wakesDir } from "./paths.ts";
import { applyInnerLifeLayout, planInnerLifeLayout } from "./layout-migration.ts";

/**
 * Memory-effects verifier for Litespec #67 unit "Commit replay-safe memory
 * effects".
 *
 * Scenarios (exact names from the issue):
 * - [M1] add-and-duplicate-update-share-atomic-receipt
 * - [M1] replay-and-conflicting-payload-key
 * - [M2] fact-policy-scope-budget-and-safety-matrix
 * - [M2] database-error-rolls-back-receipt-and-memory
 * - [M3] absent-failed-hanging-embedding-and-artifact-failure-after-commit
 * - [M4] offline-upgrade-preserves-memory-and-cursors
 * - [M4] invalid-upgrade-input-and-startup-version-gate
 *
 * All embedding boundaries are deterministic fakes injected through the
 * MemoryStore deps seam; no live or paid provider call exists on any path
 * here. The hanging fake reproduces the production EmbeddingProvider fetch
 * deadline semantics (a hung call rejects after its deadline).
 */

const TS = "2026-01-01T00:00:00.000Z";
const BUDGET_ENV = { GOBLIN_MEMORY_BUDGET_CHARS: "5000" };

function line(index: number, role: WakeRole, text: string, sourceSurfaceId?: string): WakeInputLine {
  return sourceSurfaceId === undefined
    ? { index, role, text, ts: TS }
    : { index, role, text, ts: TS, sourceSurfaceId };
}

function factEffect(overrides: Partial<MemoryFactEffect> = {}): MemoryFactEffect {
  return {
    effectKey: `wake_${"a".repeat(16)}:effect:0`,
    target: "memory",
    text: "I live in Madrid",
    confidence: 0.9,
    source: {
      session: "conversation-a",
      lineIndex: 0,
      sourceSurfaceId: surfaceId(dmSurface(4242)),
    },
    ...overrides,
  };
}

function expectRejected(
  outcome: MemoryEffectOutcome,
  reason: MemoryEffectRejectionReason,
): { message: string } {
  if (outcome.kind !== "rejected") {
    throw new Error(`expected rejected outcome, got: ${JSON.stringify(outcome)}`);
  }
  expect(outcome.reason).toBe(reason);
  expect(outcome.message.length).toBeGreaterThan(0);
  return outcome;
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
  category: string | null;
  confidence: number | null;
  origin: string;
  updated_at: number;
}

function curatedRows(store: MemoryStore, scope: string): CuratedRow[] {
  return store.db.database
    .query<CuratedRow, { $scope: string }>(
      `SELECT id, text, category, confidence, origin, updated_at
       FROM memory_entries
       WHERE scope = $scope AND entry_kind IN ('memory', 'user')
       ORDER BY id`,
    )
    .all({ $scope: scope });
}

function diaryLines(home: string): string[] {
  const path = dreamDiaryPath(home, new Date().toISOString().slice(0, 10));
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.length > 0);
}

class RecordingEmbeddingProvider extends EmbeddingProvider {
  calls = 0;

  override async embedBatch(): Promise<Array<{ hash: string; embedding: Float32Array | null }>> {
    this.calls++;
    return [];
  }

  override async embedEntries(): Promise<Map<string, Float32Array | null>> {
    this.calls++;
    return new Map();
  }
}

class ThrowingEmbeddingProvider extends EmbeddingProvider {
  constructor(db: MemoryDatabase, private readonly failure: Error) {
    super(db);
  }

  override async embedBatch(): Promise<Array<{ hash: string; embedding: Float32Array | null }>> {
    throw this.failure;
  }

  override async embedEntries(): Promise<Map<string, Float32Array | null>> {
    throw this.failure;
  }
}

/**
 * Mirrors the production provider deadline: EmbeddingProvider.fetchEmbeddings
 * aborts a hung embeddings request after its fixed deadline and the call
 * rejects. This fake reproduces exactly that observable behavior with a
 * short deadline so the test never waits on a real timeout.
 */
class DeadlineEmbeddingProvider extends EmbeddingProvider {
  calls = 0;

  constructor(db: MemoryDatabase, private readonly deadlineMs: number) {
    super(db);
  }

  private hung<T>(): Promise<T> {
    this.calls++;
    return new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("embedding provider deadline exceeded")), this.deadlineMs);
    });
  }

  override async embedBatch(): Promise<Array<{ hash: string; embedding: Float32Array | null }>> {
    return this.hung();
  }

  override async embedEntries(): Promise<Map<string, Float32Array | null>> {
    return this.hung();
  }
}

class FailingArtifactStore extends MemoryArtifactStore {
  constructor(home: string, private readonly failure: Error) {
    super(home);
  }

  override appendDreamDiary(): void {
    throw this.failure;
  }

  override appendQuarantine(): void {
    throw this.failure;
  }
}

describe("memory effects", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-memory-effects-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function newStore(
    dir: string,
    deps: { embeddings?: EmbeddingProvider; artifacts?: MemoryArtifactStore } = {},
  ): MemoryStore {
    return new MemoryStore(dir, undefined, { budget: new MemoryBudget(BUDGET_ENV), ...deps });
  }

  it("add-and-duplicate-update-share-atomic-receipt", async () => {
    const store = newStore(home);
    const wakeStore = new WakeStore(home);

    // The accepted intent is persisted in the wake before entering MemoryStore.
    const citedSurface = surfaceId(dmSurface(4242));
    const reservation = await wakeStore.reserve({
      conversationId: "conversation-a",
      afterLine: 0,
      beforeLine: 2,
      profile: PRIVATE_FACTS_PROFILE,
      lines: [
        line(0, "user", "I live in Madrid", citedSurface),
        line(1, "assistant", "You live in Madrid."),
      ],
    });
    const wakeId = wakeStore.applyTransition(reservation.record.wakeId, { kind: "begin-attempt" }).wakeId;
    const intent: AcceptedIntent = {
      effectKey: `${wakeId}:effect:0`,
      kind: "fact",
      target: "memory",
      lineIndex: 0,
      text: "I live in Madrid",
      confidence: 0.9,
    };
    const applying = wakeStore.applyTransition(wakeId, { kind: "begin-application", intents: [intent] });
    expect(applying.state).toBe("applying");
    expect(applying.acceptedIntents).toEqual([intent]);

    // Apply the persisted accepted intent through MemoryStore.
    const persisted = applying.acceptedIntents[0]!;
    const cited = applying.input.lines.find((l) => l.index === persisted.lineIndex)!;
    const added = await store.applyFactEffect({
      effectKey: persisted.effectKey,
      target: persisted.target,
      text: persisted.text,
      confidence: persisted.confidence,
      source: {
        session: applying.source.conversationId,
        lineIndex: persisted.lineIndex,
        sourceSurfaceId: cited.sourceSurfaceId ?? null,
      },
    });
    if (added.kind !== "added") throw new Error(`expected added, got: ${JSON.stringify(added)}`);

    // Row mutation and receipt committed together: the entry carries the fact
    // policy metadata and the receipt records the canonical outcome.
    const rows = curatedRows(store, "general");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(added.entryId);
    expect(rows[0]!.text).toBe("I live in Madrid");
    expect(rows[0]!.category).toBe("fact");
    expect(rows[0]!.origin).toBe("dreaming");
    const receiptsAfterAdd = effectReceipts(store);
    expect(receiptsAfterAdd).toHaveLength(1);
    expect(receiptsAfterAdd[0]!.effect_key).toBe(persisted.effectKey);
    expect(receiptsAfterAdd[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptsAfterAdd[0]!.entry_id).toBe(added.entryId);
    expect(JSON.parse(receiptsAfterAdd[0]!.outcome)).toEqual({
      kind: "added",
      entryId: added.entryId,
    });

    // A near-duplicate of the stored fact updates that entry in place —
    // no second row — and its receipt records the update atomically.
    const duplicate = factEffect({
      effectKey: `${wakeId}:effect:1`,
      text: "I live in Madrid and I love tea",
    });
    const updated = await store.applyFactEffect(duplicate);
    if (updated.kind !== "updated") throw new Error(`expected updated, got: ${JSON.stringify(updated)}`);
    expect(updated.entryId).toBe(added.entryId);
    expect(updated.preservedExisting).toBe(false);
    const rowsAfterUpdate = curatedRows(store, "general");
    expect(rowsAfterUpdate).toHaveLength(1);
    expect(rowsAfterUpdate[0]!.id).toBe(added.entryId);
    expect(rowsAfterUpdate[0]!.text).toBe("I live in Madrid and I love tea");
    expect(rowsAfterUpdate[0]!.updated_at).toBeGreaterThan(rows[0]!.updated_at);
    // The FTS index row mutation happened inside the same commit.
    const fts = store.db.database
      .query<{ text: string }, { $id: string }>("SELECT text FROM memory_index_fts WHERE entry_id = $id")
      .get({ $id: added.entryId });
    expect(fts?.text).toBe("I live in Madrid and I love tea");
    const receiptsAfterUpdate = effectReceipts(store);
    expect(receiptsAfterUpdate).toHaveLength(2);
    expect(JSON.parse(receiptsAfterUpdate.find((r) => r.effect_key === duplicate.effectKey)!.outcome)).toEqual({
      kind: "updated",
      entryId: added.entryId,
      preservedExisting: false,
    });
    store.close();
  });

  it("replay-and-conflicting-payload-key", async () => {
    const base = newStore(home);
    const provider = new RecordingEmbeddingProvider(base.db);
    const store = new MemoryStore(base.db, undefined, {
      budget: new MemoryBudget(BUDGET_ENV),
      embeddings: provider,
      artifacts: new MemoryArtifactStore(home),
    });

    const effect = factEffect();
    const first = await store.applyFactEffect(effect);
    if (first.kind !== "added") throw new Error(`expected added, got: ${JSON.stringify(first)}`);
    const callsAfterFirst = provider.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const diaryCountAfterFirst = diaryLines(home).length;
    expect(diaryCountAfterFirst).toBe(1);

    // Replay with the same key and payload returns the recorded outcome:
    // no repeated mutation, no repeated embedding calls, no new artifacts.
    const replay = await store.applyFactEffect(effect);
    expect(replay).toEqual(first);
    expect(curatedRows(store, "general")).toHaveLength(1);
    expect(effectReceipts(store)).toHaveLength(1);
    expect(provider.calls).toBe(callsAfterFirst);
    expect(diaryLines(home)).toHaveLength(diaryCountAfterFirst);

    // Concurrent application of the same effect converges on one mutation:
    // the second caller replays the committed receipt.
    const concurrent = await Promise.all([
      store.applyFactEffect(factEffect({ effectKey: `wake_${"a".repeat(16)}:effect:9`, text: "I work on little goblin" })),
      store.applyFactEffect(factEffect({ effectKey: `wake_${"a".repeat(16)}:effect:9`, text: "I work on little goblin" })),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(curatedRows(store, "general")).toHaveLength(2);
    expect(effectReceipts(store)).toHaveLength(2);

    // Conflicting payload identity under an already-applied key fails loudly.
    const conflictingText = { ...effect, text: "I speak Spanish" };
    let textConflict: unknown;
    try {
      await store.applyFactEffect(conflictingText);
      throw new Error("expected conflicting key reuse to fail");
    } catch (err) {
      if (!(err instanceof MemoryEffectConflictError)) throw err;
      textConflict = err;
    }
    expect((textConflict as MemoryEffectConflictError).effectKey).toBe(effect.effectKey);
    expect((textConflict as Error).message).toContain(effect.effectKey);

    // Payload identity covers the event-time provenance too: a different
    // source surface under the same key is a conflict, not a scope change.
    const conflictingSource = {
      ...effect,
      source: { ...effect.source, sourceSurfaceId: surfaceId(topicSurface("supergroup", -100, 7)) },
    };
    await expect(store.applyFactEffect(conflictingSource)).rejects.toThrow();

    expect(curatedRows(store, "general")).toHaveLength(2);
    expect(effectReceipts(store)).toHaveLength(2);
    store.close();
  });

  it("fact-policy-scope-budget-and-safety-matrix", async () => {
    const store = newStore(home);
    const threshold = 0.7;
    const key = (n: number): string => `wake_${"c".repeat(16)}:effect:${n}`;
    const apply = (overrides: Partial<MemoryFactEffect>): Promise<MemoryEffectOutcome> =>
      store.applyFactEffect(factEffect(overrides), { confidenceThreshold: threshold });

    // Procedural noise is rejected.
    const noise = await apply({ effectKey: key(1), text: "run the deployment tests" });
    expectRejected(noise, "procedural_noise");

    // Secret-bearing text is rejected by the safety filter.
    const unsafe = await apply({ effectKey: key(2), text: `my key is sk-${"a".repeat(24)}` });
    expectRejected(unsafe, "unsafe");

    // Low-confidence proposals are rejected.
    const lowConfidence = await apply({ effectKey: key(3), confidence: 0.3 });
    expectRejected(lowConfidence, "low_confidence");

    // Named-agent targets are denied (bounded authority, decision 0035).
    const agent = await apply({ effectKey: key(4), target: "agent" });
    expectRejected(agent, "no_agent_authority");

    // Every rejection received a durable receipt; no rows were mutated.
    const rejectionReceipts = effectReceipts(store);
    expect(rejectionReceipts.map((r) => r.effect_key)).toEqual([key(1), key(2), key(3), key(4)]);
    for (const receipt of rejectionReceipts) {
      expect(receipt.entry_id).toBeNull();
      const parsed = JSON.parse(receipt.outcome) as { kind: string };
      expect(parsed.kind).toBe("rejected");
    }
    expect(curatedRows(store, "general")).toHaveLength(0);

    // Replaying a rejection returns the recorded outcome.
    const replayedRejection = await apply({ effectKey: key(1), text: "run the deployment tests" });
    expect(replayedRejection).toEqual(noise);
    expect(effectReceipts(store)).toHaveLength(4);

    // The quarantine audit trail carries the effect identity.
    const quarantineFile = readFileSync(quarantinePath(home), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { effectKey?: string; reason?: string });
    expect(quarantineFile).toHaveLength(4);
    expect(quarantineFile.map((r) => r.effectKey)).toEqual([key(1), key(2), key(3), key(4)]);
    expect(quarantineFile[3]!.reason).toBe("no_agent_authority");

    // Scope: topic-surface provenance projects to the topic scope.
    const topicOutcome = await apply({
      effectKey: key(10),
      source: { session: "conversation-a", lineIndex: 0, sourceSurfaceId: surfaceId(topicSurface("supergroup", -100, 42)) },
    });
    if (topicOutcome.kind !== "added") throw new Error(`expected added, got: ${JSON.stringify(topicOutcome)}`);
    expect(curatedRows(store, "topics/-100/42")).toHaveLength(1);

    // Scope: DM provenance projects to general.
    await apply({
      effectKey: key(11),
      text: "I use Arch daily",
      source: { session: "conversation-a", lineIndex: 0, sourceSurfaceId: surfaceId(dmSurface(77)) },
    });
    expect(curatedRows(store, "general")).toHaveLength(1);

    // Scope: absent provenance falls back to general (decision 0025).
    await apply({
      effectKey: key(12),
      text: "I prefer terse replies",
      source: { session: "conversation-a", lineIndex: 0, sourceSurfaceId: null },
    });
    // Scope: invalid provenance cannot establish a curated target either.
    await apply({
      effectKey: key(13),
      text: "I run NixOS everywhere",
      source: { session: "conversation-a", lineIndex: 0, sourceSurfaceId: "tg:v1:dm:bogus" },
    });
    expect(curatedRows(store, "general")).toHaveLength(3);

    // Scope: the user target writes user-kind entries to the user scope.
    await apply({
      effectKey: key(14),
      target: "user",
      text: "I sign messages as bermudi",
    });
    const userRows = curatedRows(store, "user");
    expect(userRows).toHaveLength(1);
    const userKind = store.db.database
      .query<{ entry_kind: string }, { $scope: string }>("SELECT DISTINCT entry_kind FROM memory_entries WHERE scope = $scope")
      .get({ $scope: "user" });
    expect(userKind?.entry_kind).toBe("user");

    // Budget: overflowing a budget that compaction cannot relieve rejects the
    // effect durably without mutating memory and sets the blocked marker.
    // Fill with user-origin content (not compaction-eligible); the projected
    // total forces eviction of exactly the four dreaming fact rows.
    const fill = await store.add("user", "u".repeat(4974));
    expect(fill.ok).toBe(true);
    // Remove the last dreaming row so nothing evictable remains: the next
    // effect cannot make room and must overflow.
    const removed = await store.remove("user", "I sign messages as bermudi");
    expect(removed.ok).toBe(true);
    const overflow = await apply({ effectKey: key(20), text: "I live in Lisbon year round" });
    const rejectedOverflow = expectRejected(overflow, "budget_exhausted");
    expect(rejectedOverflow.message).toContain("overflow");
    expect(effectReceipts(store).find((r) => r.effect_key === key(20))?.entry_id).toBeNull();
    expect(store.isBudgetBlocked()).toBe(true);
    // The rejected effect mutated nothing: the fill row survives.
    const fillRows = curatedRows(store, "user");
    expect(fillRows).toHaveLength(1);
    expect(fillRows[0]!.text).toBe("u".repeat(4974));
    store.close();
  });

  it("database-error-rolls-back-receipt-and-memory", async () => {
    const store = newStore(home);
    const boom = new Error("injected sqlite failure: index write exploded");
    const target = store as unknown as { insertIndexAndTags: () => void };
    const spy = spyOn(target, "insertIndexAndTags").mockImplementation(() => {
      throw boom;
    });
    let failure: unknown;
    try {
      await store.applyFactEffect(factEffect());
      throw new Error("expected the effect application to fail");
    } catch (err) {
      failure = err;
    } finally {
      spy.mockRestore();
    }

    // The unexpected database error propagates; it is not converted into a
    // successful-looking rejection outcome.
    expect(failure).toBe(boom);
    // The transaction rolled back: no entry row, no receipt, no stale marker.
    expect(curatedRows(store, "general")).toHaveLength(0);
    expect(effectReceipts(store)).toHaveLength(0);
    expect(store.isBudgetBlocked()).toBe(false);

    // The clean tree accepts the same effect again: nothing residue-like
    // blocks a retry.
    const retried = await store.applyFactEffect(factEffect());
    expect(retried.kind).toBe("added");
    expect(curatedRows(store, "general")).toHaveLength(1);
    expect(effectReceipts(store)).toHaveLength(1);
    store.close();
  });

  it("absent-failed-hanging-embedding-and-artifact-failure-after-commit", async () => {
    // Absent embeddings: the canonical effect commits without a provider.
    const absent = newStore(join(home, "absent"));
    const absentOutcome = await absent.applyFactEffect(factEffect());
    expect(absentOutcome.kind).toBe("added");
    const embeddingCount = absent.db.database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_embeddings")
      .get();
    expect(embeddingCount?.count).toBe(0);
    absent.close();

    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    try {
      // Failed provider: the post-commit embedding failure is observable and
      // the canonical mutation neither rolls back nor retries.
      const failedBase = newStore(join(home, "failed"));
      const failedProvider = new ThrowingEmbeddingProvider(
        failedBase.db,
        new Error("embedding endpoint exploded"),
      );
      const failed = new MemoryStore(failedBase.db, undefined, {
        budget: new MemoryBudget(BUDGET_ENV),
        embeddings: failedProvider,
      });
      const failedOutcome = await failed.applyFactEffect(factEffect());
      expect(failedOutcome.kind).toBe("added");
      expect(curatedRows(failed, "general")).toHaveLength(1);
      expect(effectReceipts(failed)).toHaveLength(1);
      const warnMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnMessages.some((m) => m.includes("embedding failed after commit"))).toBe(true);
      failed.close();
      failedBase.close();

      // Hanging provider: canonical completion is bounded by the provider
      // deadline behavior, not held indefinitely. The fake reproduces the
      // production fetch deadline with 40ms; dedup and post-commit refresh
      // each observe one bounded rejection.
      const hangBase = newStore(join(home, "hang"));
      const hangProvider = new DeadlineEmbeddingProvider(hangBase.db, 40);
      const hang = new MemoryStore(hangBase.db, undefined, {
        budget: new MemoryBudget(BUDGET_ENV),
        embeddings: hangProvider,
      });
      const started = Date.now();
      const hangOutcome = await hang.applyFactEffect(factEffect());
      const elapsed = Date.now() - started;
      expect(hangOutcome.kind).toBe("added");
      expect(elapsed).toBeLessThan(5000);
      expect(hangProvider.calls).toBe(2);
      expect(curatedRows(hang, "general")).toHaveLength(1);
      expect(effectReceipts(hang)).toHaveLength(1);
      hang.close();
      hangBase.close();

      // Artifact failure after commit: observable with the effect identity;
      // the canonical outcome is unaffected.
      const artifactDir = join(home, "artifact");
      const artifactFailure = new Error("diary append exploded");
      const artifactStore = newStore(artifactDir, {
        artifacts: new FailingArtifactStore(artifactDir, artifactFailure),
      });
      const artifactOutcome = await artifactStore.applyFactEffect(factEffect());
      expect(artifactOutcome.kind).toBe("added");
      expect(curatedRows(artifactStore, "general")).toHaveLength(1);
      expect(effectReceipts(artifactStore)).toHaveLength(1);
      const artifactWarn = warnSpy.mock.calls
        .map((call) => JSON.stringify(call.map((part) => (typeof part === "string" ? part : JSON.stringify(part)))))
        .join("\n");
      expect(artifactWarn).toContain("append failed after commit");
      expect(artifactWarn).toContain(factEffect().effectKey);
      artifactStore.close();

      // Artifact retries duplicate the audit line, and every duplicate
      // carries the effect identity.
      const retryDir = join(home, "retry");
      const retryStore = newStore(retryDir);
      const retryKey = `wake_${"d".repeat(16)}:effect:0`;
      await retryStore.applyFactEffect(factEffect({ effectKey: retryKey, text: `key sk-${"x".repeat(24)}` }));
      const quarantineLines = readFileSync(quarantinePath(retryDir), "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(quarantineLines).toHaveLength(1);
      const record = JSON.parse(quarantineLines[0]!) as { effectKey?: string };
      expect(record.effectKey).toBe(retryKey);
      const artifacts = new MemoryArtifactStore(retryDir);
      artifacts.appendQuarantine(record);
      const duplicatedLines = readFileSync(quarantinePath(retryDir), "utf-8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { effectKey?: string });
      expect(duplicatedLines).toHaveLength(2);
      expect(duplicatedLines[0]!.effectKey).toBe(retryKey);
      expect(duplicatedLines[1]!.effectKey).toBe(retryKey);

      // Existing artifact retention stays intact: standard locations and the
      // standard 45-day pruning behavior are unchanged by effect artifacts.
      expect(existsSync(quarantinePath(retryDir))).toBe(true);
      expect(diaryLines(retryDir).some((l) => l.includes(`effect=${retryKey}`))).toBe(true);
      const rotated = quarantineRotatedPath(retryDir, "2026-07-01-1");
      writeFileSync(rotated, "{}\n");
      const old = 46 * 24 * 60 * 60 * 1000;
      utimesSync(rotated, new Date(Date.now() - old), new Date(Date.now() - old));
      const pruned = artifacts.pruneAuditArtifacts();
      expect(pruned.quarantine).toBe(1);
      expect(existsSync(rotated)).toBe(false);
      expect(existsSync(quarantinePath(retryDir))).toBe(true);
      retryStore.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("offline-upgrade-preserves-memory-and-cursors", async () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeStateVersion(home, 5);

    // Existing canonical memory at v5.
    const store = newStore(home);
    await store.add("user", "operator prefers short answers");
    const topicScope = { topic: { chatId: -100, topicId: 42 } };
    await store.add(topicScope, "release train leaves Fridays");
    const entryQuery = "SELECT id, scope, entry_kind, text, created_at, updated_at, origin, display_order FROM memory_entries ORDER BY id";
    const rowsBefore = store.db.database.query<Record<string, unknown>, []>(entryQuery).all();
    expect(rowsBefore).toHaveLength(2);
    store.close();

    // Existing light-sleep cursor.
    const cursorDir = join(home, "state", "sessions", "conversation-a");
    mkdirSync(cursorDir, { recursive: true });
    const cursorPath = join(cursorDir, "memory-dreaming-cursor.json");
    const cursorBytes = `${JSON.stringify({ processedLines: 42, lastDreamedAt: "2026-09-01T00:00:00.000Z" }, null, 2)}\n`;
    writeFileSync(cursorPath, cursorBytes);
    expect(existsSync(wakesDir(home))).toBe(false);

    runMigrations(home);

    expect(readStateVersion(home)).toBe(CURRENT_STATE_VERSION);
    // Wake layout added.
    expect(existsSync(wakesDir(home))).toBe(true);
    // Receipt storage added without touching existing memory or cursors.
    const migrated = new MemoryDatabase(memoryDbPath(home));
    const receiptsTable = migrated.database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_effect_receipts'")
      .get();
    expect(receiptsTable?.name).toBe("memory_effect_receipts");
    expect(migrated.getMeta("schema_version")).toBe(String(MEMORY_SCHEMA_VERSION));
    const rowsAfter = migrated.database.query<Record<string, unknown>, []>(entryQuery).all();
    expect(rowsAfter).toEqual(rowsBefore);
    migrated.close();
    expect(readFileSync(cursorPath, "utf-8")).toBe(cursorBytes);

    // The migration took the standard backup path.
    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups).toHaveLength(1);

    // Receipt storage is usable on the migrated home.
    const upgraded = newStore(home);
    const outcome = upgraded.applyFactEffect(factEffect());
    expect((await outcome).kind).toBe("added");
    expect(effectReceipts(upgraded)).toHaveLength(1);
    upgraded.close();
  });

  it("invalid-upgrade-input-and-startup-version-gate", () => {
    const mkHome = (name: string): string => {
      const dir = join(home, name);
      mkdirSync(join(dir, "state"), { recursive: true });
      writeStateVersion(dir, 5);
      return dir;
    };

    // Malformed wake records fail validation before any write happens.
    const wakesHome = mkHome("wakes");
    const seed = newStore(wakesHome);
    seed.close();
    mkdirSync(wakesDir(wakesHome), { recursive: true });
    writeFileSync(join(wakesDir(wakesHome), "wake_0123456789abcdef.json"), "{not json");
    expect(() => runMigrations(wakesHome)).toThrow(/wake_0123456789abcdef/);
    expect(readStateVersion(wakesHome)).toBe(5);
    // Planning failed before the snapshot: the run never reached its
    // write phase.
    expect(readdirSync(wakesHome).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(0);

    // A structurally invalid record is rejected the same way.
    const invalidHome = mkHome("invalid");
    const seedInvalid = newStore(invalidHome);
    seedInvalid.close();
    mkdirSync(wakesDir(invalidHome), { recursive: true });
    writeFileSync(
      join(wakesDir(invalidHome), "wake_0123456789abcdef.json"),
      JSON.stringify({ version: 1, unexpected: true }),
    );
    expect(() => runMigrations(invalidHome)).toThrow();
    expect(readStateVersion(invalidHome)).toBe(5);

    // A corrupt memory database fails validation before writes.
    const corruptHome = mkHome("corrupt");
    mkdirSync(join(corruptHome, "state", "memory"), { recursive: true });
    writeFileSync(memoryDbPath(corruptHome), "this is not a sqlite database");
    expect(() => runMigrations(corruptHome)).toThrow();
    expect(readStateVersion(corruptHome)).toBe(5);
    expect(existsSync(wakesDir(corruptHome))).toBe(false);

    // Ambiguous layout: the inner-life root exists but is not a directory.
    const fileHome = mkHome("file");
    writeFileSync(join(fileHome, "state", "inner-life"), "not a directory");
    expect(() => runMigrations(fileHome)).toThrow(/not a directory/);
    expect(readStateVersion(fileHome)).toBe(5);

    // Startup version gate: an old-version home is refused rather than
    // migrated implicitly; running the offline migration clears the gate.
    const gateHome = mkHome("gate");
    expect(readStateVersion(gateHome)).toBe(5);
    expect(readStateVersion(gateHome)).not.toBe(CURRENT_STATE_VERSION);
    runMigrations(gateHome);
    expect(readStateVersion(gateHome)).toBe(CURRENT_STATE_VERSION);
  });

  // W5 direct-fix regression coverage (issue #67 closure review): the light-
  // sleep cursor adapter reads only the sidecar, so legacy cursor locations
  // must be converted by the offline step-6 migration — otherwise the first
  // pass seeds at transcript end and unprocessed lines are silently skipped.
  function seedLegacyHome(name: string): string {
    const dir = join(home, name);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeStateVersion(dir, 5);
    const seed = newStore(dir);
    seed.close();
    return dir;
  }

  function seedLegacyMetaRow(dir: string, conversationId: string, value: unknown): void {
    const db = new MemoryDatabase(memoryDbPath(dir));
    try {
      db.setMeta(`dreaming_cursor:${conversationId}`, JSON.stringify(value));
    } finally {
      db.close();
    }
  }

  function readSidecarJson(dir: string, conversationId: string): unknown {
    return JSON.parse(readFileSync(memoryDreamingCursorPath(dir, conversationId), "utf-8"));
  }

  it("legacy-light-sleep-cursors-convert-to-the-sidecar", () => {
    const dir = seedLegacyHome("legacy-convert");

    // Legacy reflection-file cursor only (pre-SQLite DreamingPipeline shape).
    const fileOnly = join(dir, "state", "sessions", "conv-file-only");
    mkdirSync(fileOnly, { recursive: true });
    writeFileSync(
      join(fileOnly, "memory-reflection.json"),
      JSON.stringify({ processedLines: 7, lastReflectedAt: "2026-08-01T00:00:00.000Z" }),
    );

    // Legacy memory_meta cursor only (SQLite-era DreamingPipeline shape).
    const metaOnly = join(dir, "state", "sessions", "conv-meta-only");
    mkdirSync(metaOnly, { recursive: true });
    seedLegacyMetaRow(dir, "conv-meta-only", {
      processedLines: 11,
      lastDreamedAt: "2026-08-02T00:00:00.000Z",
    });

    // Both legacy sources conflict: the most conservative (oldest unprocessed)
    // position is preserved, so no span either cursor held open is skipped.
    const both = join(dir, "state", "sessions", "conv-both");
    mkdirSync(both, { recursive: true });
    writeFileSync(
      join(both, "memory-reflection.json"),
      JSON.stringify({ processedLines: 30, lastReflectedAt: "2026-08-03T00:00:00.000Z" }),
    );
    seedLegacyMetaRow(dir, "conv-both", {
      processedLines: 20,
      lastDreamedAt: "2026-08-04T00:00:00.000Z",
    });

    // An already-converted conversation: the sidecar is authoritative and the
    // legacy sources are left exactly as they are.
    const converted = join(dir, "state", "sessions", "conv-sidecar");
    mkdirSync(converted, { recursive: true });
    const sidecarBytes = `${JSON.stringify({ processedLines: 5, lastDreamedAt: "2026-08-05T00:00:00.000Z" })}\n`;
    writeFileSync(memoryDreamingCursorPath(dir, "conv-sidecar"), sidecarBytes);
    writeFileSync(join(converted, "memory-reflection.json"), JSON.stringify({ processedLines: 1 }));
    seedLegacyMetaRow(dir, "conv-sidecar", {
      processedLines: 2,
      lastDreamedAt: "2026-08-06T00:00:00.000Z",
    });

    // A meta row without a session directory protects no transcript lines;
    // the row is left untouched and no directory is fabricated.
    seedLegacyMetaRow(dir, "conv-gone", {
      processedLines: 9,
      lastDreamedAt: "2026-08-07T00:00:00.000Z",
    });

    runMigrations(dir);
    expect(readStateVersion(dir)).toBe(CURRENT_STATE_VERSION);

    expect(readSidecarJson(dir, "conv-file-only")).toEqual({
      processedLines: 7,
      lastDreamedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(readSidecarJson(dir, "conv-meta-only")).toEqual({
      processedLines: 11,
      lastDreamedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(readSidecarJson(dir, "conv-both")).toEqual({
      processedLines: 20,
      lastDreamedAt: "2026-08-04T00:00:00.000Z",
    });

    // Already-converted cursors and legacy sources are unchanged.
    expect(readFileSync(memoryDreamingCursorPath(dir, "conv-sidecar"), "utf-8")).toBe(sidecarBytes);
    expect(existsSync(join(converted, "memory-reflection.json"))).toBe(true);
    expect(existsSync(join(fileOnly, "memory-reflection.json"))).toBe(true);
    expect(existsSync(join(metaOnly, "memory-reflection.json"))).toBe(false);
    expect(existsSync(join(dir, "state", "sessions", "conv-gone"))).toBe(false);

    // Legacy rows survive untouched; the sidecar is authoritative after
    // conversion, so the runtime never consults them.
    const rows = new MemoryDatabase(memoryDbPath(dir), { readonly: true });
    try {
      expect(rows.getMeta("dreaming_cursor:conv-meta-only")).toBe(
        JSON.stringify({ processedLines: 11, lastDreamedAt: "2026-08-02T00:00:00.000Z" }),
      );
      expect(rows.getMeta("dreaming_cursor:conv-gone")).toBe(
        JSON.stringify({ processedLines: 9, lastDreamedAt: "2026-08-07T00:00:00.000Z" }),
      );
    } finally {
      rows.close();
    }

    // The migration took the standard backup path.
    expect(readdirSync(dir).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(1);

    // Idempotent: a re-run on the converted home is a no-op — the version
    // gate returns early, and even a forced re-plan finds nothing to convert.
    runMigrations(dir);
    expect(readdirSync(dir).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(1);
    expect(planInnerLifeLayout(dir).legacyCursorConversions).toEqual([]);
    expect(readSidecarJson(dir, "conv-file-only")).toEqual({
      processedLines: 7,
      lastDreamedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("invalid-legacy-cursor-input-fails-before-any-write", () => {
    const mkLegacyHome = (name: string, conversationId: string): string => {
      const dir = seedLegacyHome(name);
      const convDir = join(dir, "state", "sessions", conversationId);
      mkdirSync(convDir, { recursive: true });
      return dir;
    };

    // Malformed JSON in a legacy reflection file aborts the whole run before
    // any write: version stays 5, no snapshot, no sidecar, no wake layout.
    const malformedHome = mkLegacyHome("legacy-malformed", "conv-a");
    writeFileSync(
      join(malformedHome, "state", "sessions", "conv-a", "memory-reflection.json"),
      "{not json",
    );
    expect(() => runMigrations(malformedHome)).toThrow(/memory-reflection\.json/);
    expect(readStateVersion(malformedHome)).toBe(5);
    expect(readdirSync(malformedHome).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(0);
    expect(existsSync(wakesDir(malformedHome))).toBe(false);
    expect(existsSync(memoryDreamingCursorPath(malformedHome, "conv-a"))).toBe(false);

    // A processedLines that is not a number is ambiguity, not migration input.
    const typeHome = mkLegacyHome("legacy-type", "conv-a");
    writeFileSync(
      join(typeHome, "state", "sessions", "conv-a", "memory-reflection.json"),
      JSON.stringify({ processedLines: "42" }),
    );
    expect(() => runMigrations(typeHome)).toThrow(/processedLines/);
    expect(readStateVersion(typeHome)).toBe(5);
    expect(readdirSync(typeHome).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(0);

    // A malformed legacy memory_meta value fails the same way.
    const metaMalformedHome = mkLegacyHome("legacy-meta-malformed", "conv-a");
    const rawDb = new MemoryDatabase(memoryDbPath(metaMalformedHome));
    rawDb.setMeta("dreaming_cursor:conv-a", "{not json");
    rawDb.close();
    expect(() => runMigrations(metaMalformedHome)).toThrow(/dreaming_cursor|conv-a/);
    expect(readStateVersion(metaMalformedHome)).toBe(5);
    expect(readdirSync(metaMalformedHome).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(0);

    // The meta shape required both fields (matching DreamingPipeline.readCursor);
    // a missing lastDreamedAt is ambiguous and aborts instead of guessing.
    const metaIncompleteHome = mkLegacyHome("legacy-meta-incomplete", "conv-a");
    const incompleteDb = new MemoryDatabase(memoryDbPath(metaIncompleteHome));
    incompleteDb.setMeta("dreaming_cursor:conv-a", JSON.stringify({ processedLines: 4 }));
    incompleteDb.close();
    expect(() => runMigrations(metaIncompleteHome)).toThrow(/lastDreamedAt/);
    expect(readStateVersion(metaIncompleteHome)).toBe(5);
    expect(readdirSync(metaIncompleteHome).filter((n) => n.startsWith(".migration-backup-"))).toHaveLength(0);
  });

  it("legacy-cursor-without-timestamp-uses-migration-clock", () => {
    const dir = seedLegacyHome("legacy-fallback");
    const convDir = join(dir, "state", "sessions", "conv-a");
    mkdirSync(convDir, { recursive: true });
    // The file-era shape made lastReflectedAt optional; the old pipeline fell
    // back to the then-current time. The migration does the same with its own
    // clock, injected here for determinism.
    writeFileSync(join(convDir, "memory-reflection.json"), JSON.stringify({ processedLines: 4 }));

    const plan = planInnerLifeLayout(dir, { now: () => new Date(Date.parse("2026-09-01T00:00:00.000Z")) });
    expect(plan.legacyCursorConversions).toEqual([
      { conversationId: "conv-a", processedLines: 4, lastDreamedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    applyInnerLifeLayout(dir, plan);
    expect(readSidecarJson(dir, "conv-a")).toEqual({
      processedLines: 4,
      lastDreamedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});
