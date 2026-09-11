import { describe, it, expect } from "bun:test";
import { ResponseLane } from "./response-lane.ts";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain pending microtasks so fire-and-forget continuations settle. */
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("ResponseLane", () => {
  it("proceeds immediately when idle", async () => {
    const lane = new ResponseLane();
    expect(lane.isBusy()).toBe(false);
    expect(lane.current).toBeNull();
    expect(await lane.enter(false)).toBe("proceed");
    expect(await lane.enter(true)).toBe("proceed");
  });

  it("decides proceed/skipped synchronously so the lane is claimed without a yield", () => {
    const lane = new ResponseLane();
    // Idle: synchronous "proceed" — not a promise, no microtask yield.
    expect(lane.enter(false)).toBe("proceed");
    expect(lane.enter(true)).toBe("proceed");
    expect(lane.wait()).toBeNull();
    const d = deferred();
    void lane.track(d.promise);
    // Busy: synchronous "skipped" — a caller in the same synchronous run
    // already observes the claim.
    expect(lane.enter(false)).toBe("skipped");
    expect(lane.wait()).toBe(d.promise);
    d.resolve();
  });

  it("reports skipped to a non-force caller while a write is in flight", async () => {
    const lane = new ResponseLane();
    const d = deferred();
    const tracked = lane.track(d.promise);
    expect(lane.isBusy()).toBe(true);
    expect(await lane.enter(false)).toBe("skipped");
    // The skipped caller did not disturb the in-flight write.
    expect(lane.current).toBe(d.promise);
    d.resolve();
    await tracked;
  });

  it("makes a force caller await the in-flight write, then proceed", async () => {
    const lane = new ResponseLane();
    const d = deferred();
    const tracked = lane.track(d.promise);
    let entered = false;
    const entry = Promise.resolve(lane.enter(true)).then((e) => {
      entered = true;
      return e;
    });
    await tick();
    // Still blocked: the force caller must not proceed while busy.
    expect(entered).toBe(false);
    d.resolve();
    expect(await entry).toBe("awaited");
    expect(entered).toBe(true);
    await tracked;
  });

  it("wait() resolves immediately when idle and blocks while busy", async () => {
    const lane = new ResponseLane();
    await lane.wait();
    const d = deferred();
    const tracked = lane.track(d.promise);
    let waited = false;
    const w = Promise.resolve(lane.wait()).then(() => {
      waited = true;
    });
    await tick();
    expect(waited).toBe(false);
    d.resolve();
    await w;
    expect(waited).toBe(true);
    await tracked;
  });

  it("isBusy() supports the report-and-return posture", async () => {
    const lane = new ResponseLane();
    expect(lane.isBusy()).toBe(false);
    const d = deferred();
    const tracked = lane.track(d.promise);
    expect(lane.isBusy()).toBe(true);
    d.resolve();
    await tracked;
    expect(lane.isBusy()).toBe(false);
  });

  it("clears the in-flight marker when the tracked write resolves", async () => {
    const lane = new ResponseLane();
    const d = deferred();
    const tracked = lane.track(d.promise);
    expect(lane.isBusy()).toBe(true);
    d.resolve();
    await tracked;
    expect(lane.isBusy()).toBe(false);
    expect(lane.current).toBeNull();
  });

  it("clears the in-flight marker when the tracked write rejects, and rethrows", async () => {
    const lane = new ResponseLane();
    const d = deferred();
    const tracked = lane.track(d.promise);
    d.reject(new Error("boom"));
    await expect(tracked).rejects.toThrow("boom");
    expect(lane.isBusy()).toBe(false);
    expect(lane.current).toBeNull();
  });

  it("keeps the newer tracked write when an older chained write settles first", async () => {
    const lane = new ResponseLane();
    const d1 = deferred();
    const d2 = deferred();
    const t1 = lane.track(d1.promise);
    const t2 = lane.track(d2.promise);
    expect(lane.current).toBe(d2.promise);
    d1.resolve();
    await t1;
    // d1's settle must not clear d2's marker.
    expect(lane.current).toBe(d2.promise);
    expect(lane.isBusy()).toBe(true);
    d2.resolve();
    await t2;
    expect(lane.isBusy()).toBe(false);
  });

  it("lets the first concurrent force caller claim the lane before the next proceeds", async () => {
    const lane = new ResponseLane();
    const d0 = deferred();
    const t0 = lane.track(d0.promise);

    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();
    const f1 = (async () => {
      await lane.enter(true);
      order.push("f1-entered");
      const t = lane.track(d1.promise);
      order.push("f1-tracked");
      await t;
    })();
    const f2 = (async () => {
      await lane.enter(true);
      order.push("f2-entered");
      const t = lane.track(d2.promise);
      order.push("f2-tracked");
      await t;
    })();

    await tick();
    expect(order).toEqual([]);
    d0.resolve();
    await tick();
    // f1's continuation resumes first: it proceeds and re-tracks the lane
    // before f2's enter resolves.
    expect(order).toEqual(["f1-entered", "f1-tracked", "f2-entered", "f2-tracked"]);
    expect(lane.current).toBe(d2.promise);
    d1.resolve();
    d2.resolve();
    await f1;
    await f2;
    await t0;
    expect(lane.isBusy()).toBe(false);
  });
});
