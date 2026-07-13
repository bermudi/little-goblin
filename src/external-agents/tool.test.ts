import { describe, it, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDetail, createExternalAgentTool } from "./tool.ts";
import type { ExternalAgentRunSummary } from "./types.ts";
import type { ExternalAgentRunner } from "./runner.ts";

describe("formatDetail", () => {
  it("returns status and error for a simple run", () => {
    const result = formatDetail({
      status: "failed",
      error: "something went wrong",
      recentEvents: [],
      recentOutput: "",
    });
    expect(result).toContain("status: failed");
    expect(result).toContain("error: something went wrong");
    expect(result.length).toBeLessThanOrEqual(16000);
  });

  it("keeps status and error in view when output is huge", () => {
    const hugeOutput = "output-line\n".repeat(2000);
    const result = formatDetail({
      status: "running",
      error: "bad thing",
      recentEvents: [],
      recentOutput: hugeOutput,
    });
    expect(result).toContain("status: running");
    expect(result).toContain("error: bad thing");
    expect(result.length).toBeLessThanOrEqual(16000);
    // The tail of the output should be preserved (the last line is at the end).
    expect(result.endsWith("output-line")).toBe(true);
  });

  it("caps error and input_required so status is still visible", () => {
    const giant = "x".repeat(20000);
    const result = formatDetail({
      status: "input_required",
      error: giant,
      inputRequired: giant,
      recentEvents: [],
      recentOutput: "",
    });
    expect(result).toContain("status: input_required");
    expect(result).toContain("error: ");
    expect(result).toContain("input_required: ");
    expect(result.length).toBeLessThanOrEqual(16000);
  });

  it("includes recent events and output when they fit", () => {
    const result = formatDetail({
      status: "completed",
      recentEvents: [
        { type: "status", at: "2024-01-01T00:00:00.000Z", message: "started" },
        { type: "output", at: "2024-01-01T00:00:01.000Z", output: "hello" },
      ],
      recentOutput: "hello",
    });
    expect(result).toContain("status: completed");
    expect(result).toContain("[status] started");
    expect(result).toContain("[output] hello");
    expect(result).toContain("output:\nhello");
  });

  it("does not exceed the limit when everything is large", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: "output" as const,
      at: "2024-01-01T00:00:00.000Z",
      output: `line-${i} `.repeat(500),
    }));
    const result = formatDetail({
      status: "running",
      error: "e".repeat(10000),
      inputRequired: "i".repeat(10000),
      recentEvents: events,
      recentOutput: "o".repeat(20000),
    });
    expect(result.length).toBeLessThanOrEqual(16000);
    expect(result.startsWith("status: running")).toBe(true);
  });

  it("reports truncation in the header", () => {
    const result = formatDetail({
      status: "completed",
      eventsTruncated: true,
      resultTruncated: true,
      recentEvents: [],
      recentOutput: "",
    });
    expect(result).toContain("truncated: events, result");
  });
});

describe("createExternalAgentTool", () => {
  it("refuses start without a project directory", async () => {
    const tool = createExternalAgentTool({
      runner: {} as unknown as ExternalAgentRunner,
      sessionId: "s1",
      projectDir: undefined,
      enabledBackends: ["codex"],
      onStatusUpdate: () => {},
    });

    const result = await tool.execute("call-1", { action: "start", agent: "codex", task: "do something" }, undefined, undefined, undefined as unknown as ExtensionContext);
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(text).toContain("project directory");
  });

  it("refuses a disabled backend", async () => {
    const tool = createExternalAgentTool({
      runner: {} as unknown as ExternalAgentRunner,
      sessionId: "s1",
      projectDir: "/tmp/project",
      enabledBackends: ["codex"],
      onStatusUpdate: () => {},
    });

    const result = await tool.execute("call-1", { action: "start", agent: "claude", task: "do something" }, undefined, undefined, undefined as unknown as ExtensionContext);
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(text).toContain("not enabled");
  });

  it("starts a run when projectDir and backend are valid", async () => {
    const summary: ExternalAgentRunSummary = {
      id: "run-1",
      backend: "codex",
      status: "starting",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      projectDir: "/tmp/project",
      eventsTruncated: false,
      resultTruncated: false,
    };
    const runner = {
      start: (args: { backend: string; task: string; sessionId: string; projectDir: string }) => {
        expect(args.backend).toBe("codex");
        expect(args.task).toBe("do something");
        expect(args.projectDir).toBe("/tmp/project");
        return Promise.resolve(summary);
      },
    } as unknown as ExternalAgentRunner;

    const tool = createExternalAgentTool({
      runner,
      sessionId: "s1",
      projectDir: "/tmp/project",
      enabledBackends: ["codex"],
      onStatusUpdate: () => {},
    });

    const result = await tool.execute("call-1", { action: "start", agent: "codex", task: "do something" }, undefined, undefined, undefined as unknown as ExtensionContext);
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(text).toContain("Started external codex run run-1");
  });
});
