import { describe, it, expect } from "bun:test";
import { executeResume, parseResumeTarget } from "./resume.ts";
import type { SessionState } from "../sessions/types.ts";
import { personalEnvironment } from "../sessions/environment.ts";

function session(id: string, title?: string): SessionState {
  return {
    id,
    createdAt: "2026-05-10T00:00:00.000Z",
    chatId: 1,
    title,
    executionEnvironment: personalEnvironment(),
  };
}

describe("/resume command", () => {
  it("parses id or name after command mentions", () => {
    expect(parseResumeTarget("/resume@goblinbot abc123")).toBe("abc123");
  });

  it("lists named conversations when no target is provided", async () => {
    const result = await executeResume({
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

  it("reports when no named conversations exist", async () => {
    const result = await executeResume({
      rawText: "/resume",
      sessions: [session("anon123456")],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("No named conversations yet");
  });

  it("binds an exact session id", async () => {
    let bound: string | undefined;
    const result = await executeResume({
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

  it("reports ambiguous prefix matches", async () => {
    const result = await executeResume({
      rawText: "/resume abc",
      sessions: [session("abc123def0"), session("abc999def0")],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("reports an incompatible target without binding", async () => {
    let bound: string | undefined;
    const result = await executeResume({
      rawText: "/resume other",
      sessions: [],
      incompatibleSessions: [session("other12345", "other")],
      bindSession: (id) => {
        bound = id;
        return session(id, "other");
      },
    });
    expect(result.kind).toBe("incompatible");
    expect(bound).toBeUndefined();
    expect(result.reply).toContain("incompatible");
  });

  it("treats a target that appears in both compatible and incompatible lists as ambiguous", async () => {
    let bound: string | undefined;
    const result = await executeResume({
      rawText: "/resume shared",
      sessions: [session("shared1234", "shared")],
      incompatibleSessions: [session("shared1234", "shared")],
      bindSession: (id) => {
        bound = id;
        return session(id, "shared");
      },
    });
    expect(result.kind).toBe("ambiguous");
    expect(bound).toBeUndefined();
  });

  it("lists only compatible named conversations when no target is given", async () => {
    const result = await executeResume({
      rawText: "/resume",
      sessions: [session("abc123def0", "work")],
      incompatibleSessions: [session("def1234567", "other")],
      bindSession: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("abc123def0");
    expect(result.reply).not.toContain("def1234567");
  });
});
