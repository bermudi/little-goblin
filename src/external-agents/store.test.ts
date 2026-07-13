import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalRunStore } from "./store.ts";
import { externalAgentMetaPath } from "./paths.ts";
import type { ExternalAgentEvent, InternalRun } from "./types.ts";

const dirs: string[] = [];

function makeStore(): { home: string; store: ExternalRunStore } {
  const home = mkdtempSync(join(tmpdir(), "goblin-external-store-"));
  dirs.push(home);
  return { home, store: new ExternalRunStore(home) };
}

function makeRun(home: string, id: string): InternalRun {
  const meta = {
    id,
    ownerSessionId: "s1",
    backend: "codex" as const,
    projectDir: home,
    status: "running" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    adapterKind: "native" as const,
    eventsTruncated: false,
    resultTruncated: false,
    inputRequired: undefined,
    terminalError: undefined,
  };
  return {
    ...meta,
    sessionId: "s1",
    task: "test",
    terminal: false,
    terminalError: undefined,
    handle: undefined,
    timeout: undefined,
    abortController: new AbortController(),
    terminalPromise: Promise.resolve(),
    resolveTerminal: () => {},
    meta,
    eventsBytes: 0,
    result: "",
    inputRequired: undefined,
    fallback: false,
    runPromise: undefined,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ExternalRunStore", () => {
  it("tracks event bytes in UTF-8, not string length", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r1");
    store.create(run.meta);

    const multiByteEvent: ExternalAgentEvent = {
      type: "output",
      at: new Date().toISOString(),
      output: "🎉".repeat(1000),
    };
    store.appendEvent(run, multiByteEvent);

    const line = JSON.stringify(multiByteEvent) + "\n";
    const expectedBytes = Buffer.byteLength(line, "utf-8");
    expect(run.eventsBytes).toBe(expectedBytes);
    expect(run.eventsBytes).toBeGreaterThan(line.length);
  });

  it("create persists metadata atomically", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r2");
    store.create(run.meta);
    const loaded = store.load(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(run.id);
    expect(loaded?.ownerSessionId).toBe("s1");
  });

  it("rejects malformed metadata when loading", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r3");
    store.create(run.meta);
    writeFileSync(externalAgentMetaPath(home, run.id), JSON.stringify({ id: "r3" }), "utf-8");
    expect(() => store.load(run.id)).toThrow("malformed external agent metadata");
  });

  it("rejects inputRequired when it is not a string", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r3-string");
    store.create(run.meta);
    writeFileSync(
      externalAgentMetaPath(home, run.id),
      JSON.stringify({ ...run.meta, inputRequired: 123 }),
      "utf-8",
    );
    expect(() => store.load(run.id)).toThrow("malformed external agent metadata: inputRequired is not a string");
  });

  it("rejects terminalError when it is not a string", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r3-error");
    store.create(run.meta);
    writeFileSync(
      externalAgentMetaPath(home, run.id),
      JSON.stringify({ ...run.meta, terminalError: { message: "oops" } }),
      "utf-8",
    );
    expect(() => store.load(run.id)).toThrow("malformed external agent metadata: terminalError is not a string");
  });

  it("appends a truncation event and rewrites atomically when the event log exceeds 2 MiB", () => {
    const { home, store } = makeStore();
    const run = makeRun(home, "r4");
    store.create(run.meta);

    const event: ExternalAgentEvent = { type: "status", at: new Date().toISOString(), message: "x" };

    // Pretend the store already holds 2 MiB - 1 bytes so the next append triggers trimming.
    run.eventsBytes = 2 * 1024 * 1024 - 1;
    store.appendEvent(run, event);

    expect(run.meta.eventsTruncated).toBe(true);
    const events = store.getEvents(run.id);
    expect(events.some((e) => e.type === "truncation")).toBe(true);
    expect(events.some((e) => e.type === "status")).toBe(true);
    // The truncation event must fit under the 2 MiB cap.
    expect(run.eventsBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
