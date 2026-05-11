import { describe, it, expect } from "bun:test";
import { executeName, parseSessionName } from "./name.ts";
import type { SessionState } from "../sessions/types.ts";

const session: SessionState = {
  id: "abc123def0",
  createdAt: "2026-05-10T00:00:00.000Z",
  chatId: 1,
};

describe("/name command", () => {
  it("parses names after command mentions", () => {
    expect(parseSessionName("/name@goblinbot long running thing")).toBe("long running thing");
  });

  it("requires an active session", () => {
    const result = executeName({
      hasSession: false,
      rawText: "/name nope",
      session: null,
      setTitle: () => {},
    });
    expect(result.kind).toBe("missing-session");
  });

  it("sets the session title", () => {
    let title: string | undefined;
    const result = executeName({
      hasSession: true,
      rawText: "/name memory refactor",
      session,
      setTitle: (next) => {
        title = next;
      },
    });
    expect(result.kind).toBe("renamed");
    expect(title).toBe("memory refactor");
  });
});
