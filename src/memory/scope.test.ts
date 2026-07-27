import { describe, expect, it } from "bun:test";
import { dmSurface, guestSurface, supergroupSurface, topicSurface } from "../surface.ts";
import { resolveActiveScope, scopeTag } from "./scope.ts";

describe("memory scope", () => {
  describe("resolveActiveScope", () => {
    it("resolves a DM to general while retaining chatId for discovery", () => {
      expect(resolveActiveScope(dmSurface(123))).toEqual({
        chatId: 123,
        topicScope: "general",
      });
    });

    it("resolves a topicless supergroup to general while retaining chatId", () => {
      expect(resolveActiveScope(supergroupSurface(-100123))).toEqual({
        chatId: -100123,
        topicScope: "general",
      });
    });

    it("resolves a guest surface to general while retaining chatId", () => {
      expect(resolveActiveScope(guestSurface(-100999))).toEqual({
        chatId: -100999,
        topicScope: "general",
      });
    });

    it("resolves every topic container to the same topic scope shape", () => {
      // Private, supergroup, and direct-messages topic containers all project
      // to { chatId, topicScope: { topicId } } — container kind does not fork
      // the memory key.
      expect(resolveActiveScope(topicSurface("private", -100123, 42))).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      });
      expect(resolveActiveScope(topicSurface("supergroup", -100123, 42))).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      });
      expect(resolveActiveScope(topicSurface("direct-messages", -100123, 42))).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      });
    });

    it("does not carry named-agent identity — persona is caller-owned", () => {
      // ActiveScope carries only routing facts. Persona identity lives in
      // MemoryCaller, not in the Surface projection.
      const scope = resolveActiveScope(topicSurface("supergroup", -100123, 42));
      expect(scope).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      });
      expect("namedAgent" in scope).toBe(false);
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

    it("handles malformed topic objects at runtime (type escape hatch)", () => {
      // At runtime, an object with 'topic' key but wrong shape could be passed
      // TypeScript prevents this, but we test the runtime behavior
      const malformedTopic = { topic: { chatId: undefined, topicId: undefined } } as unknown as { topic: { chatId: number; topicId: number } };
      expect(scopeTag(malformedTopic)).toBe("topics/undefined/undefined");
    });

    it("falls through to agent branch for objects without topic key (throws)", () => {
      // Object with neither 'topic' nor valid 'agent' falls through to agent branch
      // and throws when accessing scope.agent.name
      // TypeScript prevents this, but we test runtime behavior
      const emptyObj = {} as unknown as { agent: { name: string } };
      expect(() => scopeTag(emptyObj)).toThrow();
    });

    it("formats malformed agent objects at runtime", () => {
      // Object missing name field
      const malformedAgent = { agent: {} } as unknown as { agent: { name: string } };
      expect(scopeTag(malformedAgent)).toBe("agents/undefined");
    });
  });
});
