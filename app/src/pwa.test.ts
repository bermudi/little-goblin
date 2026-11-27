import { describe, expect, test } from "bun:test";
import { registerAppServiceWorker } from "./pwa.ts";

type Listener = () => void;

function serviceWorkerDouble(controller: object | null) {
  const listeners = new Map<string, Listener[]>();
  const registrations: unknown[] = [];
  const serviceWorker = {
    controller,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    register(scriptURL: string, options: unknown) {
      registrations.push([scriptURL, options]);
      return Promise.resolve({});
    },
  } as unknown as ServiceWorkerContainer;
  return {
    serviceWorker,
    registrations,
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

describe("app service worker registration", () => {
  test("a replacement worker reloads a controlled page once", async () => {
    const worker = serviceWorkerDouble({});
    let reloads = 0;
    registerAppServiceWorker(worker.serviceWorker, () => {
      reloads += 1;
    });
    expect(worker.registrations).toEqual([
      ["/app/sw.js", { scope: "/app/" }],
    ]);
    await Promise.resolve();
    worker.fire("controllerchange");
    worker.fire("controllerchange");
    expect(reloads).toBe(1);
  });

  test("the first worker to control the page does not reload it", async () => {
    const worker = serviceWorkerDouble(null);
    let reloads = 0;
    registerAppServiceWorker(worker.serviceWorker, () => {
      reloads += 1;
    });
    await Promise.resolve();
    worker.fire("controllerchange");
    expect(reloads).toBe(0);
    worker.fire("controllerchange");
    expect(reloads).toBe(1);
  });
});
