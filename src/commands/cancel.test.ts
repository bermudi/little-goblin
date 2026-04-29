import { describe, it, expect } from "bun:test";
import { cancelReply } from "./cancel.ts";

describe("cancelReply", () => {
  it("returns 'Nothing to cancel.' when no active session", () => {
    expect(
      cancelReply({ hasSession: false, wasStreaming: false, hadLiveSubagents: false }),
    ).toBe("Nothing to cancel.");
  });

  it("returns 'Nothing to cancel.' when no active session even if subagents are live", () => {
    // Defensive: without a session the user has no agent context to cancel.
    expect(
      cancelReply({ hasSession: false, wasStreaming: true, hadLiveSubagents: true }),
    ).toBe("Nothing to cancel.");
  });

  it("returns 'Nothing to cancel.' when session is idle and no subagents are live", () => {
    expect(
      cancelReply({ hasSession: true, wasStreaming: false, hadLiveSubagents: false }),
    ).toBe("Nothing to cancel.");
  });

  it("returns 'Cancelled.' when session was streaming", () => {
    expect(
      cancelReply({ hasSession: true, wasStreaming: true, hadLiveSubagents: false }),
    ).toBe("Cancelled.");
  });

  it("returns 'Cancelled.' when session is idle but subagents are live", () => {
    expect(
      cancelReply({ hasSession: true, wasStreaming: false, hadLiveSubagents: true }),
    ).toBe("Cancelled.");
  });

  it("returns 'Cancelled.' when both streaming and subagents are live", () => {
    expect(
      cancelReply({ hasSession: true, wasStreaming: true, hadLiveSubagents: true }),
    ).toBe("Cancelled.");
  });
});
