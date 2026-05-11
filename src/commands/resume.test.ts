import { describe, it, expect } from "bun:test";
import { executeResume, parseResumeTarget } from "./resume.ts";
import type { SessionState } from "../sessions/types.ts";

function session(id: string, title?: string): SessionState {
  return {
    id,
    createdAt: "2026-05-10T00:00:00.000Z",
    chatId: 1,
    title,
  };
}

describe("/resume command", () => {
  it("parses id or name after command mentions", () => {
    expect(parseResumeTarget("/resume@goblinbot abc123")).toBe("abc123");
  });

  it("lists named sessions when no target is provided", () => {
    const result = executeResume({
      rawText: "/resume",
      sessions: [
        session("abc123def0", "work"),
        session("anon123456"),
        session("def1234567", "memory refactor"),
      ],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("abc123def0 — work");
    expect(result.reply).toContain("def1234567 — memory refactor");
    expect(result.reply).not.toContain("anon123456");
  });

  it("reports when no named sessions exist", () => {
    const result = executeResume({
      rawText: "/resume",
      sessions: [session("anon123456")],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("No named sessions yet");
  });

  it("binds an exact session id", () => {
    let bound: string | undefined;
    const result = executeResume({
      rawText: "/resume abc123def0",
      sessions: [session("abc123def0", "work")],
      bindSession: (id) => {
        bound = id;
        return session(id, "work");
      },
    });
    expect(result.kind).toBe("resumed");
    expect(bound).toBe("abc123def0");
  });

  it("reports ambiguous prefix matches", () => {
    const result = executeResume({
      rawText: "/resume abc",
      sessions: [session("abc123def0"), session("abc999def0")],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("ambiguous");
  });
});
