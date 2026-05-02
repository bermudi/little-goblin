import { describe, expect, it } from "bun:test";
import { resolveActiveScope, scopeTag } from "./scope.ts";

describe("memory scope", () => {
  describe("resolveActiveScope", () => {
    it("resolves a DM or supergroup-without-topic to general", () => {
      expect(resolveActiveScope({ chatId: 123 })).toEqual({
        chatId: 123,
        topicScope: "general",
        namedAgent: null,
      });
    });

    it("resolves a forum topic to its chat/topic pair", () => {
      expect(resolveActiveScope({ chatId: -100123, topicId: 42 })).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
        namedAgent: null,
      });
    });

    it("includes named subagent identity when supplied", () => {
      expect(resolveActiveScope({ chatId: -100123, topicId: 42 }, "researcher")).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
        namedAgent: { name: "researcher" },
      });
    });

    it("treats an empty named subagent identity as absent", () => {
      expect(resolveActiveScope({ chatId: -100123, topicId: 42 }, "")).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
        namedAgent: null,
      });
    });
  });

  describe("scopeTag", () => {
    it("formats every commit scope tag", () => {
      expect(scopeTag("user")).toBe("user");
      expect(scopeTag("general")).toBe("general");
      expect(scopeTag({ topic: { chatId: -100123, topicId: 42 } })).toBe(
        "topics/-100123/42",
      );
      expect(scopeTag({ agent: { name: "researcher" } })).toBe("agents/researcher");
    });
  });
});
