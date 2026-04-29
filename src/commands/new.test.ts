import { describe, it, expect } from "bun:test";
import { executeNew, TOPIC_REJECTED_REPLY, createdReply } from "./new.ts";
import type { SessionState } from "../sessions/types.ts";

function makeSession(id: string): SessionState {
  return { id, createdAt: new Date().toISOString(), chatId: 1 };
}

describe("executeNew", () => {
  it("rejects in a forum topic without invoking createSession", () => {
    let called = 0;
    const result = executeNew({
      hasTopic: true,
      createSession: () => {
        called += 1;
        return makeSession("should-not-be-used");
      },
    });

    expect(result.kind).toBe("topic-rejected");
    if (result.kind === "topic-rejected") {
      expect(result.reply).toBe(TOPIC_REJECTED_REPLY);
    }
    expect(called).toBe(0);
  });

  it("creates a session in a DM and reports the new id", () => {
    const created = makeSession("abc1234567");
    let called = 0;
    const result = executeNew({
      hasTopic: false,
      createSession: () => {
        called += 1;
        return created;
      },
    });

    expect(called).toBe(1);
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.session).toBe(created);
      expect(result.reply).toBe(createdReply("abc1234567"));
      expect(result.reply).toContain("abc1234567");
    }
  });

  it("creates a session even when there was no prior session (idempotent fresh start)", () => {
    // Spec scenario: /new in a DM with no active session SHALL create one.
    // The helper itself is stateless about prior sessions; bot.ts always
    // calls createSession in the non-topic branch. This test pins that
    // contract: no special-case for "no session" path.
    const result = executeNew({
      hasTopic: false,
      createSession: () => makeSession("fresh01234"),
    });
    expect(result.kind).toBe("created");
  });
});
