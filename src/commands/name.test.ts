import { describe, it, expect } from "bun:test";
import { executeName, parseSessionName } from "./name.ts";
import type { ConversationState } from "../sessions/mod.ts";
import { personalEnvironment } from "../sessions/environment.ts";

const conversation: ConversationState = {
  id: "abc123def0",
  createdAt: "2026-05-10T00:00:00.000Z",
  executionEnvironment: personalEnvironment(),
};

describe("/name command", () => {
  it("parses names after command mentions", () => {
    expect(parseSessionName("/name@goblinbot long running thing")).toBe("long running thing");
  });

  it("requires an active conversation", async () => {
    const result = await executeName({
      rawText: "/name nope",
      setTitle: async () => ({ kind: "no-session" }),
    });
    expect(result.kind).toBe("missing-session");
  });

  it("sets the conversation title", async () => {
    let title: string | undefined;
    const result = await executeName({
      rawText: "/name memory refactor",
      setTitle: async (next) => {
        title = next;
        return { kind: "named", conversation: { ...conversation, title: next } };
      },
    });
    expect(result.kind).toBe("renamed");
    expect(title).toBe("memory refactor");
  });
});
