import { describe, expect, it } from "bun:test";
import { withLifecycleTransitionLock } from "./lifecycle-transition-lock.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("withLifecycleTransitionLock", () => {
  it("serializes concurrent transition callbacks", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withLifecycleTransitionLock(async () => {
      order.push("first-start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first-end");
    });
    const second = withLifecycleTransitionLock(() => {
      order.push("second");
    });

    await firstStarted.promise;
    expect(order).toEqual(["first-start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after a failed transition", async () => {
    await expect(withLifecycleTransitionLock(() => {
      throw new Error("transition failed");
    })).rejects.toThrow("transition failed");

    await expect(withLifecycleTransitionLock(() => "next transition")).resolves.toBe("next transition");
  });

  it("is reentrant across await boundaries and normalizes synchronous throws to rejections", async () => {
    const order: string[] = [];
    await withLifecycleTransitionLock(async () => {
      await Promise.resolve();
      await withLifecycleTransitionLock(() => {
        order.push("inner");
      });
      const rejected = withLifecycleTransitionLock(() => {
        throw new Error("inner failed");
      });
      expect(rejected).toBeInstanceOf(Promise);
      await expect(rejected).rejects.toThrow("inner failed");
      order.push("outer");
    });

    expect(order).toEqual(["inner", "outer"]);
  });
});
