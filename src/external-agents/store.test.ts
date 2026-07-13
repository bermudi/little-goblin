import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalRunStore } from "./store.ts";
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
    onStatusUpdate: undefined,
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
});
