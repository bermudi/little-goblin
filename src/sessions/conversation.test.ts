import { describe, it, expect } from "bun:test";
import { isValidConversationId, makeConversationId, validateConversationId } from "./conversation.ts";

describe("conversation id", () => {
  it("makeConversationId returns 10 lowercase hex characters", () => {
    const id = makeConversationId();
    expect(id).toHaveLength(10);
    expect(id).toMatch(/^[0-9a-f]{10}$/);
  });

  it("generated ids are distinct", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(makeConversationId());
    }
    expect(ids.size).toBe(100);
  });

  it("validateConversationId accepts 10 lowercase hex", () => {
    expect(() => validateConversationId("abc123def0")).not.toThrow();
  });

  it("validateConversationId rejects non-hex", () => {
    expect(() => validateConversationId("ABCDEF1234")).toThrow(/10 lowercase hex/);
    expect(() => validateConversationId("abc")).toThrow(/10 lowercase hex/);
    expect(() => validateConversationId("")).toThrow(/non-empty string/);
  });

  it("validateConversationId rejects path traversal", () => {
    expect(() => validateConversationId("../escape")).toThrow();
    expect(() => validateConversationId("abc/123")).toThrow();
    expect(() => validateConversationId("abc\\\\123")).toThrow();
  });

  it("isValidConversationId matches validateConversationId", () => {
    expect(isValidConversationId("abc123def0")).toBe(true);
    expect(isValidConversationId("ABCDEF1234")).toBe(false);
    expect(isValidConversationId("../escape")).toBe(false);
  });
});
