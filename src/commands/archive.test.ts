import { describe, it, expect } from "bun:test";
import {
  executeArchive,
  NO_SESSION_REPLY,
  ALREADY_ARCHIVED_REPLY,
  ARCHIVED_REPLY,
} from "./archive.ts";

describe("executeArchive", () => {
  it("returns no-session without invoking archive when hasSession is false", () => {
    let called = 0;
    const result = executeArchive({
      hasSession: false,
      sessionExists: false,
      archive: () => {
        called += 1;
      },
    });
    expect(result.kind).toBe("no-session");
    expect(result.reply).toBe(NO_SESSION_REPLY);
    expect(called).toBe(0);
  });

  it("returns already-archived without invoking archive when sessionExists is false", () => {
    let called = 0;
    const result = executeArchive({
      hasSession: true,
      sessionExists: false,
      archive: () => {
        called += 1;
      },
    });
    expect(result.kind).toBe("already-archived");
    expect(result.reply).toBe(ALREADY_ARCHIVED_REPLY);
    expect(called).toBe(0);
  });

  it("invokes archive and returns archived reply on the happy path", () => {
    let called = 0;
    const result = executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: () => {
        called += 1;
      },
    });
    expect(called).toBe(1);
    expect(result.kind).toBe("archived");
    expect(result.reply).toBe(ARCHIVED_REPLY);
  });

  it("propagates errors from the archive callback", () => {
    expect(() =>
      executeArchive({
        hasSession: true,
        sessionExists: true,
        archive: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow(/boom/);
  });
});
