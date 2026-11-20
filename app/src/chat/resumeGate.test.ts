import { describe, expect, test } from "bun:test";
import { ResumeGate } from "./resumeGate.ts";

function scheduled() {
  const callbacks: { fn: () => void; ms: number }[] = [];
  return {
    callbacks,
    schedule: (fn: () => void, ms: number) => callbacks.push({ fn, ms }),
    run(ms: number) {
      const due = callbacks.filter((item) => item.ms === ms);
      for (const item of due) {
        callbacks.splice(callbacks.indexOf(item), 1);
        item.fn();
      }
    },
  };
}

describe("ResumeGate", () => {
  test("a seeded mount skips only its first reconnect", () => {
    const timer = scheduled();
    const gate = new ResumeGate(true, timer.schedule);
    expect(gate.beginReconnect()).toEqual({ skipNetwork: true });
    expect(gate.beginReconnect()).toEqual({ skipNetwork: false });
  });

  test("an unseeded mount never skips", () => {
    const gate = new ResumeGate(false, scheduled().schedule);
    expect(gate.beginReconnect()).toEqual({ skipNetwork: false });
    expect(gate.beginReconnect()).toEqual({ skipNetwork: false });
  });

  test("probe phases and resume cooldown follow reconnect settling", () => {
    const timer = scheduled();
    const gate = new ResumeGate(false, timer.schedule);
    expect(gate.probe).toBe("unprobed");
    gate.beginReconnect();
    expect(gate.probe).toBe("probing");
    expect(gate.requestResume()).toBe(false);
    gate.probeSettled();
    timer.run(0);
    expect(gate.probe).toBe("settled");
    expect(gate.requestResume()).toBe(true);
    expect(gate.requestResume()).toBe(false);
    timer.run(1000);
    expect(gate.requestResume()).toBe(true);
    gate.readerAttached = true;
    expect(gate.requestResume()).toBe(false);
  });

  test("settled fires once, and reconnect answers report idle only when detached", () => {
    const timer = scheduled();
    const gate = new ResumeGate(false, timer.schedule);
    let settled = 0;
    let idle = 0;
    gate.subscribe({ idle: () => idle++, settled: () => settled++ });
    gate.beginReconnect();
    gate.reconnectAnswered(false);
    expect(idle).toBe(1);
    gate.beginReconnect();
    gate.reconnectAnswered(true);
    expect(idle).toBe(1);
    gate.probeSettled();
    gate.probeSettled();
    timer.run(0);
    expect(settled).toBe(1);
  });

  test("unsubscribe stops events", () => {
    const timer = scheduled();
    const gate = new ResumeGate(false, timer.schedule);
    let idle = 0;
    let settled = 0;
    const unsubscribe = gate.subscribe({
      idle: () => idle++,
      settled: () => settled++,
    });
    unsubscribe();
    gate.reconnectAnswered(false);
    gate.probeSettled();
    timer.run(0);
    expect(idle).toBe(0);
    expect(settled).toBe(0);
  });
});
