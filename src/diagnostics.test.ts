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
import { MetricsStore } from "./metrics/mod.ts";
import type { SessionState } from "./sessions/types.ts";
import { sessionDir, transcriptPath } from "./sessions/paths.ts";
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

function stubRunner(opts: { tools: string[] | null; modelName: string; initialized?: boolean }): AgentRunner {
  return {
    getActiveToolNames: () => opts.tools,
    modelName: opts.modelName,
    isInitialized: opts.initialized ?? false,
  } as unknown as AgentRunner;
}

function makeSession(id: string): SessionState {
  return { id, createdAt: "2026-04-29T00:00:00.000Z", chatId: 1 };
}

const baseDiagnostics: Diagnostics = {
  sessionId: "abc1234567",
  sessionName: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  model: "poe/Claude-Sonnet-4.6",
  runnerInitialized: true,
  tools: ["bash", "memory"],
  skillsLoaded: null,
  transcriptPath: "/tmp/transcript.jsonl",
  transcriptBytes: 1024,
  transcriptLines: 42,
  activeSubagents: 0,
  runningSubagents: 0,
  contextTokens: null,
  contextFiles: null,
  projectDir: null,
  metrics: null,
};

describe("formatDiagnostics", () => {
  it("includes all required fields from the design", () => {
    const out = formatDiagnostics(baseDiagnostics);
    expect(out).toContain("Session: abc1234567");
    expect(out).toContain("Session Name: unavailable");
    expect(out).toContain("Model: poe/Claude-Sonnet-4.6");
    expect(out).toContain("Tools: bash, memory");
    expect(out).toContain("Transcript: /tmp/transcript.jsonl");
    expect(out).toContain("1.0 KB");
    expect(out).toContain("42 lines");
    expect(out).toContain("Subagents: 0 tracked, 0 running");
  });

  it("renders session name when present", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, sessionName: "ttt-v2" });
    expect(out).toContain("Session Name: ttt-v2");
    expect(out).not.toContain("Session Name: unavailable");
  });

  it("renders null fields as 'unavailable' instead of omitting them", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      sessionName: null,
      tools: null,
      skillsLoaded: null,
      transcriptBytes: null,
      transcriptLines: null,
      contextTokens: null,
    });
    expect(out).toContain("Session Name: unavailable");
    expect(out).toContain("Tools: unavailable");
    expect(out).toContain("Skills loaded: unavailable");
    expect(out).toContain("Transcript file: unavailable, unavailable lines");
    expect(out).toContain("Context: unavailable");
    expect(out).toContain("Context files: unavailable");
    expect(out).toContain("Project: (none)");
  });

  it("renders runner-backed null fields as '(not initialized)' when the runner is not primed", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      runnerInitialized: false,
      tools: null,
      skillsLoaded: null,
      contextTokens: null,
      contextFiles: null,
    });
    expect(out).toContain("Tools: (not initialized — send a message first)");
    expect(out).toContain("Skills loaded: (not initialized — send a message first)");
    expect(out).toContain("Context: (not initialized — send a message first)");
    expect(out).toContain("Context files: (not initialized — send a message first)");
    // Non-runner fields still render "unavailable", not the not-initialized marker.
    expect(out).toContain("Session Name: unavailable");
  });

  it("renders runner-backed null fields as 'unavailable' when the runner is primed but the field is unobservable", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      runnerInitialized: true,
      tools: null,
      skillsLoaded: null,
      contextTokens: null,
      contextFiles: null,
    });
    expect(out).toContain("Tools: unavailable");
    expect(out).toContain("Context: unavailable");
    expect(out).not.toContain("not initialized");
  });

  it("renders empty tool list distinctly from 'unavailable'", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, tools: [] });
    expect(out).toContain("Tools: (none)");
    expect(out).not.toContain("Tools: unavailable");
  });

  it("renders context files when present", () => {
    const out = formatDiagnostics({
      ...baseDiagnostics,
      contextFiles: ["/home/user/AGENTS.md", "/home/user/.agents/skills/foo/SKILL.md"],
    });
    expect(out).toContain("Context files: /home/user/AGENTS.md, /home/user/.agents/skills/foo/SKILL.md");
  });

  it("renders empty context files list as '(none)'", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, contextFiles: [] });
    expect(out).toContain("Context files: (none)");
  });

  it("renders project dir when set", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, projectDir: "/home/daniel/project" });
    expect(out).toContain("Project: /home/daniel/project");
  });

  it("renders null project dir as '(none)'", () => {
    const out = formatDiagnostics({ ...baseDiagnostics, projectDir: null });
    expect(out).toContain("Project: (none)");
  });

  it("formats bytes with KB and MB scaling", () => {
    expect(formatDiagnostics({ ...baseDiagnostics, transcriptBytes: 512 })).toContain("512 B");
    expect(formatDiagnostics({ ...baseDiagnostics, transcriptBytes: 2048 })).toContain("2.0 KB");
    expect(formatDiagnostics({ ...baseDiagnostics, transcriptBytes: 5 * 1024 * 1024 })).toContain(
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

  it("reports transcript.jsonl size + line count when the file exists", () => {
    const session = makeSession("abcdef1234");
    const dir = sessionDir(tmpDir, session.id);
    mkdirSync(dir, { recursive: true });
    const transcriptFile = transcriptPath(tmpDir, session.id);
    writeFileSync(transcriptFile, '{"a":1}\n{"a":2}\n{"a":3}\n');

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
    expect(d.transcriptPath).toBe(transcriptFile);
    expect(d.transcriptLines).toBe(3);
    expect(d.transcriptBytes).toBe(24); // 3 × 8 bytes
  });

  it("reads session metrics when metrics.jsonl exists", () => {
    const session = makeSession("abcdef1234");
    const metrics = new MetricsStore(tmpDir, session.id);
    metrics.record({
      type: "turn",
      turnStart: "2026-01-01T00:00:00.000Z",
      turnEnd: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      model: "gpt-test",
      provider: "openai",
      api: "chat-completions",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.003,
      toolCount: 0,
      toolErrorCount: 0,
      stopReason: "stop",
      errorMessage: null,
    });

    const d = gatherDiagnostics({
      session,
      runner: stubRunner({ tools: ["bash"], modelName: "m1" }),
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m1",
    });

    expect(d.metrics).not.toBeNull();
    expect(d.metrics!.turns).toBe(1);
    expect(d.metrics!.totalTokens).toBe(15);
    const out = formatDiagnostics(d);
    expect(out).toContain("Turns: 1");
    expect(out).toContain("Tokens: 15");
    expect(out).toContain("Cost: $ 0.003000");
    expect(out).toContain("Cache: 0 read / 0 write tokens in this session");
    expect(out).toContain("Memory searches: 0");
    expect(out).toContain("Last turn: gpt-test (openai/chat-completions) — 15 tokens, $ 0.003000, cache 0/0, stop: stop, 0 tools, 0 errors");
  });

  it("reports null events stats when the file is missing", () => {
    const session = makeSession("abcdef1235");
    const d = gatherDiagnostics({
      session,
      runner: null,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "fallback-model",
    });
    expect(d.transcriptBytes).toBeNull();
    expect(d.transcriptLines).toBeNull();
  });

  it("falls back to deps.modelName when runner is null", () => {
    const d = gatherDiagnostics({
      session: makeSession("abcdef1236"),
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
      session: makeSession("abcdef1237"),
      runner: null,
      subagentRunner: stubSubagentRunner(subagents),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.activeSubagents).toBe(4);
    expect(d.runningSubagents).toBe(2);
  });

  it("passes projectDir through when provided", () => {
    const d = gatherDiagnostics({
      session: makeSession("abcdef1237"),
      runner: null,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
      projectDir: "/home/daniel/project",
    });
    expect(d.projectDir).toBe("/home/daniel/project");
  });

  it("skillsLoaded and contextTokens remain null (best-effort, not exposed by pi)", () => {
    const d = gatherDiagnostics({
      session: makeSession("abcdef1238"),
      runner: stubRunner({ tools: [], modelName: "m", initialized: true }),
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.skillsLoaded).toBeNull();
    expect(d.contextTokens).toBeNull();
    expect(d.runnerInitialized).toBe(true);
  });

  it("reports runnerInitialized=false when the runner exists but is not primed", () => {
    const d = gatherDiagnostics({
      session: makeSession("abcdef1239"),
      runner: stubRunner({ tools: null, modelName: "m", initialized: false }),
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.runnerInitialized).toBe(false);
    expect(d.tools).toBeNull();
  });

  it("reports runnerInitialized=false when there is no runner", () => {
    const d = gatherDiagnostics({
      session: makeSession("abcdef123a"),
      runner: null,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.runnerInitialized).toBe(false);
  });

  it("reports contextFiles from the runner when available", () => {
    const runner = {
      ...stubRunner({ tools: ["memory"], modelName: "m" }),
      contextFiles: ["/home/user/.goblin/workspace/SOUL.md", "/home/user/project/AGENTS.md"],
    };
    const d = gatherDiagnostics({
      session: makeSession("abcdef123b"),
      runner: runner as unknown as AgentRunner,
      subagentRunner: stubSubagentRunner(),
      goblinHome: tmpDir,
      modelName: "m",
    });
    expect(d.contextFiles).toEqual([
      "/home/user/.goblin/workspace/SOUL.md",
      "/home/user/project/AGENTS.md",
    ]);
  });
});

describe("generateDiagnostics", () => {
  it("composes gather + format and returns a string", () => {
    const tmp = mkdtempSync(join(tmpdir(), "goblin-diag-"));
    try {
      const out = generateDiagnostics({
        session: makeSession("abc1234568"),
        runner: stubRunner({ tools: ["memory"], modelName: "model-x" }),
        subagentRunner: stubSubagentRunner(),
        goblinHome: tmp,
        modelName: "model-x",
      });
      expect(typeof out).toBe("string");
      expect(out).toContain("Session: abc1234568");
      expect(out).toContain("Model: model-x");
      expect(out).toContain("Tools: memory");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
