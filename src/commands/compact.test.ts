import { describe, expect, it, mock } from "bun:test";
import {
  executeCompact,
  formatCompactReply,
  NO_ACTIVE_RUNNER_TO_COMPACT_REPLY,
  NO_ACTIVE_SESSION_TO_COMPACT_REPLY,
  parseCompactInstructions,
} from "./compact.ts";

describe("parseCompactInstructions", () => {
  it("returns undefined when no custom instructions are present", () => {
    expect(parseCompactInstructions("/compact")).toBeUndefined();
  });

  it("returns trailing custom instructions", () => {
    expect(parseCompactInstructions("/compact focus on the schema decisions")).toBe(
      "focus on the schema decisions",
    );
  });
});

describe("formatCompactReply", () => {
  it("formats tokensBefore as rounded K tokens", () => {
    expect(formatCompactReply(42000)).toBe("Compacted from ~42K tokens.");
  });
});

describe("executeCompact", () => {
  it("replies no-session when no session is active", async () => {
    const compact = mock(async () => ({ tokensBefore: 42000 }));
    const result = await executeCompact({
      hasSession: false,
      rawText: "/compact",
      runner: { compact },
    });

    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_ACTIVE_SESSION_TO_COMPACT_REPLY);
    expect(compact).not.toHaveBeenCalled();
  });

  it("replies no-runner when the session has no runner", async () => {
    const result = await executeCompact({
      hasSession: true,
      rawText: "/compact",
      runner: null,
    });

    expect(result.kind).toBe("no-runner");
    expect(result.reply).toBe(NO_ACTIVE_RUNNER_TO_COMPACT_REPLY);
  });

  it("compacts with custom instructions", async () => {
    const compact = mock(async (_customInstructions?: string) => ({ tokensBefore: 42000 }));
    const result = await executeCompact({
      hasSession: true,
      rawText: "/compact focus on schema",
      runner: { compact },
    });

    expect(result.kind).toBe("compacted");
    expect(result.reply).toBe("Compacted from ~42K tokens.");
    expect(compact).toHaveBeenCalledWith("focus on schema");
  });

  it("replies with pi's error message when compaction fails", async () => {
    const compact = mock(async () => {
      throw new Error("Nothing to compact (session too small).");
    });
    const result = await executeCompact({
      hasSession: true,
      rawText: "/compact",
      runner: { compact },
    });

    expect(result.kind).toBe("failed");
    expect(result.reply).toBe("Nothing to compact (session too small).");
  });
});
