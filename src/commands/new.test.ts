import { describe, it, expect } from "bun:test";
import { executeNew, createdReply } from "./new.ts";
import type { SessionState } from "../sessions/types.ts";

function makeSession(id: string): SessionState {
  return { id, createdAt: new Date().toISOString(), chatId: 1 };
}

describe("executeNew", () => {
  it("creates a session with no archive when archivePrior is omitted (fresh DM)", () => {
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
    expect(result.archivedPrior).toBe(false);
    expect(result.session).toBe(created);
    expect(result.reply).toBe(createdReply("abc1234567"));
  });

  it("archives the prior session before creating when archivePrior is provided", () => {
    const order: string[] = [];
    const created = makeSession("fresh01234");
    const result = executeNew({
      archivePrior: () => {
        order.push("archive");
      },
      createSession: () => {
        order.push("create");
        return created;
      },
    });

    expect(order).toEqual(["archive", "create"]);
    expect(result.archivedPrior).toBe(true);
    expect(result.session).toBe(created);
    expect(result.reply).toBe(createdReply("fresh01234"));
  });

  it("propagates archive errors without calling createSession", () => {
    let createCalls = 0;
    expect(() =>
      executeNew({
        archivePrior: () => {
          throw new Error("rename EACCES");
        },
        createSession: () => {
          createCalls += 1;
          return makeSession("should-not-create");
        },
      }),
    ).toThrow("rename EACCES");
    expect(createCalls).toBe(0);
  });

  it("treats every chat surface the same: helper has no topic special-case", () => {
    // The chat-surface decision (DM vs topic vs supergroup) is the
    // caller's responsibility. The helper just runs archive-then-create.
    // Pins that /new in a topic resets the topic's session, contra the
    // pre-flip behavior where the helper rejected with a hardcoded reply.
    const created = makeSession("topic12345");
    const result = executeNew({
      archivePrior: () => {},
      createSession: () => created,
    });
    expect(result.kind).toBe("created");
    expect(result.archivedPrior).toBe(true);
  });
});
