import { describe, it, expect } from "bun:test";
import { cancelReply } from "./cancel.ts";
import type { CascadeResult } from "../interrupt.ts";

const NOTHING: CascadeResult = {
  attemptedMain: false,
  attemptedSubagents: 0,
  attemptedExternalAgents: 0,
  timedOutMain: false,
  timedOutSubagents: 0,
  timedOutExternalAgents: 0,
  wedgedMain: false,
};

describe("cancelReply", () => {
  it("returns 'Nothing to cancel.' when no session and nothing was running", () => {
    expect(
      cancelReply({ hasSession: false, cascade: NOTHING, cascadeTimeoutMs: 5000 }),
    ).toBe("Nothing to cancel.");
  });

  it("reports 'Cancelled.' when orphaned subagents were killed, even without a session", () => {
    // A /cancel without an active session that nonetheless aborts live
    // subagents must not lie with "Nothing to cancel." — the cascade did
    // something observable and the reply should reflect that.
    expect(
      cancelReply({
        hasSession: false,
        cascade: { ...NOTHING, attemptedSubagents: 1 },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled.");
  });

  it("returns 'Nothing to cancel.' when nothing was running", () => {
    expect(
      cancelReply({ hasSession: true, cascade: NOTHING, cascadeTimeoutMs: 5000 }),
    ).toBe("Nothing to cancel.");
  });

  it("returns 'Cancelled.' when the main agent was streaming", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { ...NOTHING, attemptedMain: true },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled.");
  });

  it("returns 'Cancelled.' when only subagents were live", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { ...NOTHING, attemptedSubagents: 2 },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled.");
  });

  it("appends an honest suffix when the main agent's abort timed out", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { attemptedMain: true, attemptedSubagents: 0, attemptedExternalAgents: 0, timedOutMain: true, timedOutSubagents: 0, timedOutExternalAgents: 0, wedgedMain: false },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled. (the main agent didn't respond in 5s and may still be running.)");
  });

  it("appends an honest suffix for a single timed-out subagent", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { attemptedMain: false, attemptedSubagents: 1, attemptedExternalAgents: 0, timedOutMain: false, timedOutSubagents: 1, timedOutExternalAgents: 0, wedgedMain: false },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled. (1 subagent didn't respond in 5s and may still be running.)");
  });

  it("pluralizes multiple timed-out subagents", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { attemptedMain: false, attemptedSubagents: 3, attemptedExternalAgents: 0, timedOutMain: false, timedOutSubagents: 3, timedOutExternalAgents: 0, wedgedMain: false },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled. (3 subagents didn't respond in 5s and may still be running.)");
  });

  it("combines main + subagent timeouts in one suffix", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { attemptedMain: true, attemptedSubagents: 2, attemptedExternalAgents: 0, timedOutMain: true, timedOutSubagents: 2, timedOutExternalAgents: 0, wedgedMain: false },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("Cancelled. (the main agent and 2 subagents didn't respond in 5s and may still be running.)");
  });

  it("reports wedged main agent with recovery instructions", () => {
    expect(
      cancelReply({
        hasSession: true,
        cascade: { attemptedMain: true, attemptedSubagents: 0, attemptedExternalAgents: 0, timedOutMain: false, timedOutSubagents: 0, timedOutExternalAgents: 0, wedgedMain: true },
        cascadeTimeoutMs: 5000,
      }),
    ).toBe("The main agent is wedged after a previous abort timed out. Use /new or /archive to recover.");
  });
});
