import { describe, it, expect } from "bun:test";
import { executeResume, parseResumeTarget } from "./resume.ts";
import type { ConversationState } from "../sessions/types.ts";
import { personalEnvironment } from "../sessions/environment.ts";

function session(id: string, title?: string): ConversationState {
  return {
    id,
    createdAt: "2026-05-10T00:00:00.000Z",
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
      conversations: [
        session("abc123def0", "work"),
        session("anon123456"),
        session("def1234567", "memory refactor"),
      ],
      bindConversation: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("abc123def0 — work");
    expect(result.reply).toContain("def1234567 — memory refactor");
    expect(result.reply).not.toContain("anon123456");
  });

  it("reports when no named conversations exist", async () => {
    const result = await executeResume({
      rawText: "/resume",
      conversations: [session("anon123456")],
      bindConversation: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("No named conversations yet");
  });

  it("binds an exact session id", async () => {
    let bound: string | undefined;
    const result = await executeResume({
      rawText: "/resume abc123def0",
      conversations: [session("abc123def0", "work")],
      bindConversation: (id) => {
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
      conversations: [session("abc123def0"), session("abc999def0")],
      bindConversation: () => session("unused"),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("reports an incompatible target without binding", async () => {
    let bound: string | undefined;
    const result = await executeResume({
      rawText: "/resume other",
      conversations: [],
      incompatibleConversations: [session("other12345", "other")],
      bindConversation: (id) => {
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
      conversations: [session("shared1234", "shared")],
      incompatibleConversations: [session("shared1234", "shared")],
      bindConversation: (id) => {
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
      conversations: [session("abc123def0", "work")],
      incompatibleConversations: [session("def1234567", "other")],
      bindConversation: () => session("unused"),
    });
    expect(result.kind).toBe("list");
    expect(result.reply).toContain("abc123def0");
    expect(result.reply).not.toContain("def1234567");
  });
});
