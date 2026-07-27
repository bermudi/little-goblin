import { describe, expect, it } from "bun:test";
import { boundedError, STRUCTURED_ERROR_CAP } from "./log.ts";

describe("boundedError", () => {
  it("returns short string errors unchanged", () => {
    expect(boundedError("short")).toEqual({ error: "short" });
  });

  it("uses Error.message for Error inputs", () => {
    const msg = "something failed";
    expect(boundedError(new Error(msg))).toEqual({ error: msg });
  });

  it("caps long error messages and adds an ellipsis", () => {
    const long = "x".repeat(STRUCTURED_ERROR_CAP + 100);
    const result = boundedError(long);
    expect(result.error.length).toBe(STRUCTURED_ERROR_CAP);
    expect(result.error).toMatch(/\.\.\.$/);
    expect(result.error.startsWith(long.slice(0, STRUCTURED_ERROR_CAP - 3))).toBe(true);
  });

  it("respects a custom cap", () => {
    const long = "abcdefghij";
    expect(boundedError(long, 5)).toEqual({ error: "ab..." });
  });

  it("falls back to String() for non-Error, non-string values", () => {
    expect(boundedError(42)).toEqual({ error: "42" });
    expect(boundedError(null)).toEqual({ error: "null" });
    expect(boundedError(undefined)).toEqual({ error: "undefined" });
  });

  it("never throws for values with a throwing toString", () => {
    const evil = {
      toString: () => {
        throw new Error("boom");
      },
    };
    expect(boundedError(evil)).toEqual({ error: "[unstringifiable error]" });
  });

  it("handles caps at or below ellipsis length", () => {
    expect(boundedError("hello", 0)).toEqual({ error: "" });
    expect(boundedError("hello", 1)).toEqual({ error: "h" });
    expect(boundedError("hello", 3)).toEqual({ error: "hel" });
  });
});
