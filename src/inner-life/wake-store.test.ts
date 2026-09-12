import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_WAKE_ATTEMPTS,
  MAX_WAKE_INPUT_BYTES,
  PRIVATE_FACTS_PROFILE,
  WakeRecordError,
  WakeReservationConflictError,
  WakeStore,
  type WakeInputLine,
  type WakeRecord,
  type WakeReservationInput,
  type WakeRole,
} from "./wake-store.ts";
import { wakeRecordPath, wakesDir } from "./paths.ts";

/**
 * Wake-store verifier for Litespec #67 unit "Persist bounded wake records".
 *
 * Scenarios (exact names from the issue):
 * - [W1] reserve-before-callback-and-coalesce-window
 * - [W1] conflicting-reservation-input-is-rejected
 * - [W2] strict-record-limits-and-invalid-transitions
 * - [W2] missing-corrupt-unknown-version-and-eacces-differ
 * - [W3] injected-write-failures-preserve-mode-and-target
 */

const TS = "2026-01-01T00:00:00.000Z";

function line(index: number, role: WakeRole = "user", text = `line ${index}`): WakeInputLine {
  return { index, role, text, ts: TS };
}

function reservation(overrides: Partial<WakeReservationInput> = {}): WakeReservationInput {
  return {
    conversationId: "conversation-a",
    afterLine: 0,
    beforeLine: 3,
    profile: PRIVATE_FACTS_PROFILE,
    lines: [line(0), line(1), line(2)],
    ...overrides,
  };
}

/** Run `fn` with `dir` read-only, restoring permissions afterwards. */
async function withReadOnlyDir(dir: string, fn: () => Promise<void> | void): Promise<void> {
  chmodSync(dir, 0o555);
  try {
    await fn();
  } finally {
    chmodSync(dir, 0o755);
  }
}

function wakeFileCount(home: string): number {
  return readdirSync(wakesDir(home)).filter((name) => name.endsWith(".json")).length;
}

describe("wake store", () => {
  let home: string;
  let store: WakeStore;

  beforeEach(() => {
    home = join(tmpdir(), `goblin-wake-store-${process.hrtime.bigint().toString(36)}-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    store = new WakeStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reserve-before-callback-and-coalesce-window", async () => {
    let callbackRuns = 0;
    let observedInCallback: WakeRecord | null = null;

    const first = await store.reserve(reservation(), async (record) => {
      callbackRuns += 1;
      // W1: the record is durable BEFORE the reflection callback runs. A
      // fresh store instance reading from disk must see the identical record.
      observedInCallback = record;
      const fresh = new WakeStore(home).read(record.wakeId);
      expect(fresh).not.toBeNull();
      expect(fresh).toEqual(record);
      const raw = JSON.parse(readFileSync(wakeRecordPath(home, record.wakeId), "utf-8"));
      expect(raw.state).toBe("reserved");
      expect(raw.attempts).toBe(0);
      return "reflection-result";
    });

    expect(callbackRuns).toBe(1);
    expect(first.coalesced).toBe(false);
    expect(first.reflectionRan).toBe(true);
    expect(first.reflectionResult).toBe("reflection-result");
    expect(first.record.state).toBe("reserved");
    expect(first.record.attempts).toBe(0);
    expect(first.record.version).toBe(1);
    expect(first.record.profile).toEqual(PRIVATE_FACTS_PROFILE);
    expect(first.record.source).toEqual({ conversationId: "conversation-a", afterLine: 0, beforeLine: 3 });
    expect(observedInCallback).not.toBeNull();
    const observed = observedInCallback as WakeRecord | null;
    expect(observed).toEqual(first.record);

    // Overlapping trigger for the same window: reuses identity, does not run
    // a second reflection, and leaves exactly one wake file.
    let duplicateCallbackRuns = 0;
    const second = await store.reserve(reservation(), async () => {
      duplicateCallbackRuns += 1;
      throw new Error("duplicate reflection must not run");
    });

    expect(duplicateCallbackRuns).toBe(0);
    expect(second.coalesced).toBe(true);
    expect(second.reflectionRan).toBe(false);
    expect(second.record.wakeId).toBe(first.record.wakeId);
    expect(wakeFileCount(home)).toBe(1);

    // Concurrent reservations for the same window coalesce to one reflection.
    let concurrentRuns = 0;
    const racers = await Promise.all([
      store.reserve(reservation(), async () => {
        concurrentRuns += 1;
      }),
      store.reserve(reservation(), async () => {
        concurrentRuns += 1;
      }),
    ]);
    expect(concurrentRuns).toBe(0); // already reserved: both coalesce
    expect(new Set(racers.map((r) => r.record.wakeId)).size).toBe(1);
    expect(wakeFileCount(home)).toBe(1);
  });

  it("conflicting-reservation-input-is-rejected", async () => {
    const first = await store.reserve(reservation());

    // Same window, different transcript input: conflict, not coalesce.
    const conflicting = reservation({
      lines: [line(0, "user", "different text"), line(1), line(2)],
    });
    expect(conflicting.lines[0]!.text).not.toBe(first.record.input.lines[0]!.text);
    let conflict: unknown;
    try {
      await store.reserve(conflicting);
      throw new Error("expected conflicting reservation to be rejected");
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(WakeReservationConflictError);
    const conflictErr = conflict as WakeReservationConflictError;
    expect(conflictErr.wakeId).toBe(first.record.wakeId);
    expect(conflictErr.message).toContain(first.record.wakeId);

    // Same window, different profile: also a conflicting input.
    try {
      await store.reserve(reservation({ profile: { id: "private-facts", version: 2 } }));
      throw new Error("expected profile-mismatched reservation to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeReservationConflictError);
    }

    // The original record is untouched: one file, original fingerprint.
    expect(wakeFileCount(home)).toBe(1);
    const reread = store.read(first.record.wakeId);
    expect(reread).toEqual(first.record);
  });

  it("strict-record-limits-and-invalid-transitions", async () => {
    // Serialized input above the 256 KiB cap is rejected, never truncated.
    const oversizeText = "x".repeat(MAX_WAKE_INPUT_BYTES);
    try {
      await store.reserve(
        reservation({
          beforeLine: 1,
          lines: [line(0, "user", oversizeText)],
        }),
      );
      throw new Error("expected oversize input to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // More lines than the configured batch limit is rejected.
    const tooManyLines = Array.from({ length: 101 }, (_, i) => line(i));
    try {
      await store.reserve(
        reservation({ beforeLine: 101, lines: tooManyLines }),
      );
      throw new Error("expected line-count limit to be enforced");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // Empty batch is rejected: a wake owns one nonempty batch.
    try {
      await store.reserve(reservation({ lines: [] }));
      throw new Error("expected empty input to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // Degenerate and inconsistent windows are rejected.
    const badWindows: Array<Partial<WakeReservationInput>> = [
      { afterLine: 3, beforeLine: 3 },
      { afterLine: 4, beforeLine: 3 },
      { lines: [line(0), line(3)] }, // index outside [afterLine, beforeLine)
      { lines: [line(1), line(1)] }, // non-increasing indexes
    ];
    for (const bad of badWindows) {
      try {
        await store.reserve(reservation(bad));
        throw new Error(`expected window ${JSON.stringify(bad)} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(WakeRecordError);
      }
    }

    // Unknown profiles carry no wake authority.
    try {
      await store.reserve(reservation({ profile: { id: "proactive-contact", version: 1 } }));
      throw new Error("expected unknown profile to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // Attempt budget: at most MAX_WAKE_ATTEMPTS persisted attempts.
    const outcome = await store.reserve(reservation());
    const id = outcome.record.wakeId;
    let record = store.applyTransition(id, { kind: "begin-attempt" });
    expect(record.state).toBe("reflecting");
    expect(record.attempts).toBe(1);
    record = store.applyTransition(id, { kind: "begin-attempt" });
    expect(record.attempts).toBe(2);
    record = store.applyTransition(id, { kind: "begin-attempt" });
    expect(record.attempts).toBe(MAX_WAKE_ATTEMPTS);
    try {
      store.applyTransition(id, { kind: "begin-attempt" });
      throw new Error("expected exhausted attempt budget to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // Terminal states are immutable; unearned transitions are invalid.
    const done = store.applyTransition(id, { kind: "complete" });
    expect(done.state).toBe("completed");
    for (const transition of [
      { kind: "begin-attempt" },
      { kind: "complete" },
      { kind: "fail", reason: "late" },
    ] as const) {
      try {
        store.applyTransition(id, transition);
        throw new Error("expected terminal-state transition to be rejected");
      } catch (err) {
        expect(err).toBeInstanceOf(WakeRecordError);
      }
    }

    const fresh = await store.reserve(reservation({ conversationId: "conversation-b", beforeLine: 2, lines: [line(0), line(1)] }));
    const freshId = fresh.record.wakeId;
    for (const transition of [
      { kind: "complete" },
      { kind: "fail", reason: "nothing ran" },
    ] as const) {
      try {
        store.applyTransition(freshId, transition);
        throw new Error("expected transition from reserved to be rejected");
      } catch (err) {
        expect(err).toBeInstanceOf(WakeRecordError);
      }
    }
    const failed = store.applyTransition(store.applyTransition(freshId, { kind: "begin-attempt" }).wakeId, { kind: "fail", reason: "model unavailable" });
    expect(failed.state).toBe("failed");
    try {
      store.applyTransition(failed.wakeId, { kind: "begin-attempt" });
      throw new Error("expected failed wake to be terminal");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
    }

    // Read-side strictness: hand-edited records that violate bounds are
    // invalid, including unknown envelope fields.
    const valid = store.read(failed.wakeId)!;
    const writeInvalid = (mutate: (record: Record<string, unknown>) => void): void => {
      const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      mutate(copy);
      writeFileSync(
        wakeRecordPath(home, failed.wakeId),
        JSON.stringify(copy, null, 2),
      );
      let err: unknown;
      try {
        store.read(failed.wakeId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WakeRecordError);
    };

    writeInvalid((r) => {
      r.attempts = MAX_WAKE_ATTEMPTS + 1;
    });
    writeInvalid((r) => {
      r.unexpectedField = true;
    });
    writeInvalid((r) => {
      (r as { input: { fingerprint: string } }).input.fingerprint = "0".repeat(64);
    });
    writeInvalid((r) => {
      (r as { input: { lines: Array<{ index: number }> } }).input.lines[0]!.index = 99;
    });
    writeInvalid((r) => {
      r.acceptedIntents = [{ kind: "sneaky-intent" }];
    });
    writeInvalid((r) => {
      r.state = "completed"; // failure evidence no longer matches state
    });
    // Timestamps must be canonical ISO-8601 UTC, not merely Date.parse-able.
    writeInvalid((r) => {
      r.createdAt = "March 5, 2026";
    });
    writeInvalid((r) => {
      (r as { input: { lines: Array<{ ts: string }> } }).input.lines[0]!.ts = "5/3/2026";
    });
    writeInvalid((r) => {
      (r as { input: { lines: Array<{ ts: string }> } }).input.lines[0]!.ts = "2026-03-05 10:00:00";
    });
    // Correct ISO shape but impossible fields: semantic validity is checked too.
    writeInvalid((r) => {
      r.createdAt = "2026-13-45T99:99:99.999Z";
    });
    // Positive control: the canonical producer shape itself remains valid.
    writeFileSync(wakeRecordPath(home, failed.wakeId), JSON.stringify(valid, null, 2));
    expect(store.read(failed.wakeId)).not.toBeNull();
  });

  it("missing-corrupt-unknown-version-and-eacces-differ", async () => {
    const outcome = await store.reserve(reservation());
    const id = outcome.record.wakeId;
    const path = wakeRecordPath(home, id);
    const original = readFileSync(path, "utf-8");

    // Absence alone is expected: null, not an error.
    expect(store.read("wake_" + "0".repeat(16))).toBeNull();

    // Invalid IDs are rejected before reaching the filesystem.
    try {
      store.read("../escape");
      throw new Error("expected invalid wake id to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("../escape");
    }

    // Corrupt JSON is a loud record error naming the identity and path.
    writeFileSync(path, "{not json");
    try {
      store.read(id);
      throw new Error("expected corrupt record to fail loudly");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
      const recordErr = err as WakeRecordError;
      expect(recordErr.wakeId).toBe(id);
      expect(recordErr.path).toBe(path);
      expect(recordErr.message).toContain(id);
      expect(recordErr.message).toContain("malformed JSON");
    }

    // Unknown versions propagate as validation failures, distinct from
    // absence and from infrastructure errors.
    const raw = JSON.parse(original) as Record<string, unknown>;
    const future = { ...raw, version: 2 };
    writeFileSync(path, JSON.stringify(future, null, 2));
    try {
      store.read(id);
      throw new Error("expected unknown version to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeRecordError);
      expect((err as WakeRecordError).message).toContain("version");
    }

    // Non-ENOENT filesystem failures (EACCES) propagate as themselves — not
    // null, and not dressed up as a validation error.
    const valid = JSON.parse(original) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(valid, null, 2));
    chmodSync(path, 0o000);
    try {
      try {
        store.read(id);
        throw new Error("expected EACCES to propagate");
      } catch (err) {
        expect(err).not.toBeInstanceOf(WakeRecordError);
        expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
      }
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("injected-write-failures-preserve-mode-and-target", async () => {
    const outcome = await store.reserve(reservation());
    const id = outcome.record.wakeId;
    const path = wakeRecordPath(home, id);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Mode-preserving replacement: a hardened mode survives a rewrite.
    chmodSync(path, 0o644);
    const reflecting = store.applyTransition(id, { kind: "begin-attempt" });
    expect(reflecting.state).toBe("reflecting");
    expect(statSync(path).mode & 0o777).toBe(0o644);

    const beforeFailure = readFileSync(path, "utf-8");

    // Injected write failure during replacement: the previous valid target
    // is retained, no temporary files leak, and the error propagates.
    await withReadOnlyDir(wakesDir(home), async () => {
      let err: unknown;
      try {
        store.applyTransition(id, { kind: "complete" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
    });

    const afterFailure = readFileSync(path, "utf-8");
    expect(afterFailure).toBe(beforeFailure); // old content retained
    expect(statSync(path).mode & 0o777).toBe(0o644); // old mode retained
    const reread = store.read(id);
    expect(reread).not.toBeNull();
    expect(reread!.state).toBe("reflecting");
    expect(reread!.attempts).toBe(1);
    const leftovers = readdirSync(wakesDir(home)).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);

    // Injected failure during exclusive reservation: the reflection callback
    // never runs and no partial record file is left behind.
    const filesBefore = wakeFileCount(home);
    let callbackRan = false;
    await withReadOnlyDir(wakesDir(home), async () => {
      let err: unknown;
      try {
        await store.reserve(
          reservation({
            conversationId: "conversation-c",
            beforeLine: 2,
            lines: [line(0), line(1)],
          }),
          async () => {
            callbackRan = true;
          },
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
    });
    expect(callbackRan).toBe(false);
    expect(wakeFileCount(home)).toBe(filesBefore);
  });
});
