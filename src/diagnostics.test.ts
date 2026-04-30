import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatDiagnostics,
  gatherDiagnostics,
  generateDiagnostics,
  type Diagnostics,
} from "./diagnostics.ts";
import type { SessionState } from "./sessions/types.ts";
import type { SubagentRunner } from "./subagents/mod.ts";
import type { AgentRunner } from "./agent/mod.ts";
import type { SubagentInfo } from "./subagents/types.ts";

// ---------------------------------------------------------------------------
// Lightweight stubs (we only need shape, not behavior, for these tests).
// ---------------------------------------------------------------------------

function stubSubagentRunner(infos: SubagentInfo[] = []): SubagentRunner {
  // Cast through unknown — we only exercise `list()`.
  return { list: () => infos } as unknown as SubagentRunner;
}

function stubRunner(opts: { tools: string[] | null; modelName: string }): AgentRunner {
  return {
    getActiveToolNames: () => opts.tools,
    modelName: opts.modelName,
  } as unknown as AgentRunner;
}

function makeSession(id: string): SessionState {
  return { id, createdAt: "2026-04-29T00:00:00.000Z", chatId: 1 };
}

const baseDiagnostics: Diagnostics = {
  sessionId: "abc1234567",
  createdAt: "2026-04-29T00:00:00.000Z",
  model: "poe/Claude-Sonnet-4.6",
  tools: ["bash", "memory"],
  skillsLoaded: null,
  eventsPath: "/tmp/events.jsonl",
  eventsBytes: 1024,
  eventsLines: 42,
  activeSubagents: 0,
  runningSubagents: 0,
  contextTokens: null,
};

describe("formatDiagnostics", () => {
  it("includes all required fields from the design", () => {
    const out = formatDiagnostics(baseDiagnostics);
    expect(out).toContain("Session: abc1234567");
    expect(out).toContain("Model: poe/Claude-Sonnet-4.6");
    expect(out).toContain("Tools: bash, memory");
    expect(out).toContain("Events: /tmp/events.jsonl");
    expect(out).toContain("1.0 KB");
    expect(out).toContain("42 lines");
    expect(out).toContain("Subagents: 0 tracked, 0 running");
  });

  it("renders null fields as 'unavailable' instead of omitting them", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      tools: null,
      skillsLoaded: null,
      eventsBytes: null,
      eventsLines: null,
      contextTokens: null,
    });
    expect(out).toContain("Tools: unavailable");
    expect(out).toContain("Skills loaded: unavailable");
    expect(out).toContain("Events file: unavailable, unavailable lines");
    expect(out).toContain("Context: unavailable");
  });

  it("renders empty tool list distinctly from 'unavailable'", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, tools: [] });
    expect(out).toContain("Tools: (none)");
    expect(out).not.toContain("Tools: unavailable");
  });

  it("formats bytes with KB and MB scaling", () => {
    expect(formatDiagnostics({ ...baseDiagnostics, eventsBytes: 512 })).toContain("512 B");
    expect(formatDiagnostics({ ...baseDiagnostics, eventsBytes: 2048 })).toContain("2.0 KB");
    expect(formatDiagnostics({ ...baseDiagnostics, eventsBytes: 5 * 1024 * 1024 })).toContain(
      "5.0 MB",
    );
  });

  it("reports running subagents separately from total tracked", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      activeSubagents: 4,
      runningSubagents: 2,
    });
    expect(out).toContain("Subagents: 4 tracked, 2 running");
  });
});

describe("gatherDiagnostics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-diag-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports events.jsonl size + line count when the file exists", () => {
    const session = makeSession("sess000001");
    const dir = join(tmpDir, "sessions", session.id);
    mkdirSync(dir, { recursive: true });
    const eventsFile = join(dir, "events.jsonl");
    writeFileSync(eventsFile, '{"a":1}\n{"a":2}\n{"a":3}\n');

    const d = gatherDiagnostics({
      session,
      runner: stubRunner({ tools: ["bash"], modelName: "m1" }),
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m1",
    });

    expect(d.sessionId).toBe(session.id);
    expect(d.model).toBe("m1");
    expect(d.tools).toEqual(["bash"]);
    expect(d.eventsPath).toBe(eventsFile);
    expect(d.eventsLines).toBe(3);
    expect(d.eventsBytes).toBe(24); // 3 × 8 bytes
  });

  it("reports null events stats when the file is missing", () => {
    const session = makeSession("sess000002");
    const d = gatherDiagnostics({
      session,
      runner: null,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "fallback-model",
    });
    expect(d.eventsBytes).toBeNull();
    expect(d.eventsLines).toBeNull();
  });

  it("falls back to deps.modelName when runner is null", () => {
    const d = gatherDiagnostics({
      session: makeSession("sess000003"),
      runner: null,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "fallback-model",
    });
    expect(d.model).toBe("fallback-model");
    expect(d.tools).toBeNull();
  });

  it("counts subagents by status", () => {
    const subagents: SubagentInfo[] = [
      { id: "a", name: null, role: "generic", status: "running", spawnedAt: "", spawnedBy: null },
      { id: "b", name: null, role: "generic", status: "running", spawnedAt: "", spawnedBy: null },
      { id: "c", name: null, role: "generic", status: "completed", spawnedAt: "", spawnedBy: null },
      { id: "d", name: null, role: "generic", status: "cancelled", spawnedAt: "", spawnedBy: null },
    ];
    const d = gatherDiagnostics({
      session: makeSession("sess000004"),
      runner: null,
      subagentRunner: stubSubagentRunner(subagents),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.activeSubagents).toBe(4);
    expect(d.runningSubagents).toBe(2);
  });

  it("skillsLoaded and contextTokens remain null (best-effort, not exposed by pi)", () => {
    const d = gatherDiagnostics({
      session: makeSession("sess000005"),
      runner: stubRunner({ tools: [], modelName: "m" }),
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.skillsLoaded).toBeNull();
    expect(d.contextTokens).toBeNull();
  });
});

describe("generateDiagnostics", () => {
  it("composes gather + format and returns a string", () => {
    const tmp = mkdtempSync(join(tmpdir(), "goblin-diag-"));
    try {
      const out = generateDiagnostics({
        session: makeSession("sessgen0001"),
        runner: stubRunner({ tools: ["memory"], modelName: "model-x" }),
        subagentRunner: stubSubagentRunner(),
        goblinHome: tmp,
        modelName: "model-x",
      });
      expect(typeof out).toBe("string");
      expect(out).toContain("Session: sessgen0001");
      expect(out).toContain("Model: model-x");
      expect(out).toContain("Tools: memory");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
