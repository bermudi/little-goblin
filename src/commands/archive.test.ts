import { describe, it, expect } from "bun:test";
import { executeArchive, NO_SESSION_REPLY, ARCHIVED_REPLY } from "./archive.ts";

describe("executeArchive", () => {
  it("returns no-session when the lifecycle archive operation reports no session", async () => {
    let called = 0;
    const result = await executeArchive({
      archive: async () => {
        called += 1;
        return { kind: "no-session" };
      },
    });
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
    expect(called).toBe(1);
  });

  it("returns archived reply on the happy path", async () => {
    let called = 0;
    const result = await executeArchive({
      archive: async () => {
        called += 1;
        return { kind: "archived", conversationId: "0000000000" as import("../sessions/types.ts").ConversationId };
      },
    });
    expect(called).toBe(1);
    expect(result.kind).toBe("archived");
    expect(result.reply).toBe(ARCHIVED_REPLY);
  });

  it("propagates errors from the archive callback", async () => {
    await expect(
      executeArchive({
        archive: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/boom/);
  });
});
