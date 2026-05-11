import { describe, it, expect } from "bun:test";
import { executeNew, createdReply } from "./new.ts";
import type { SessionState } from "../sessions/types.ts";

function makeSession(id: string): SessionState {
  return { id, createdAt: new Date().toISOString(), chatId: 1 };
}

describe("executeNew", () => {
  it("creates a fresh session", () => {
    const created = makeSession("abc1234567");
    let createCalls = 0;
    const result = executeNew({
      createSession: () => {
        createCalls += 1;
        return created;
      },
    });

    expect(createCalls).toBe(1);
    expect(result.kind).toBe("created");
    expect(result.session).toBe(created);
    expect(result.reply).toBe(createdReply("abc1234567"));
  });

  it("treats every chat surface the same: helper has no topic special-case", () => {
    // The chat-surface decision (DM vs topic vs supergroup) is the
    // caller's responsibility. The helper just creates the new session.
    // Pins that /new in a topic resets the topic's session, contra the
    // pre-flip behavior where the helper rejected with a hardcoded reply.
    const created = makeSession("topic12345");
    const result = executeNew({
      createSession: () => created,
    });
    expect(result.kind).toBe("created");
    expect(result.session).toBe(created);
  });
});
