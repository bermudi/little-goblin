import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dmSurface,
  guestSurface,
  parseSurfaceId,
  supergroupSurface,
  surfaceId,
  topicSurface,
  type Surface,
} from "../surface.ts";
import { resolveActiveScope, type ActiveScope } from "./scope.ts";
import {
  assertSurfaceBackedAuthorityInput,
  captureRuntimeMemoryContext,
  type CapturedMemoryContext,
  type InternalMemoryContext,
  type SurfaceMemoryAuthority,
} from "./runtime-context.ts";
import { MemoryStore } from "./store.ts";

/**
 * Build a `SurfaceMemoryAuthority` from a Surface, exercising the same
 * projection + encoding path a real capture would use. Phase 1 only defines
 * the types and the zero-chat guard; the full async capture factory lands in
 * Phase 2. This helper keeps the type-level and projection tests focused.
 */
function surfaceAuthority(surface: Surface): SurfaceMemoryAuthority {
  assertSurfaceBackedAuthorityInput(surface);
  return {
    kind: "surface",
    sourceSurfaceId: surfaceId(surface),
    activeScope: resolveActiveScope(surface),
  };
}

describe("runtime memory context — Surface-derived authority", () => {
  describe("resolveActiveScope — exhaustive Surface projection", () => {
    it("projects every topic container to the same topic scope shape", () => {
      // Topic containers share the accepted memory key: container kind does
      // not fork the projection.
      for (const container of ["private", "supergroup", "direct-messages"] as const) {
        const scope = resolveActiveScope(topicSurface(container, -100123, 42));
        expect(scope).toEqual({
          chatId: -100123,
          topicScope: { topicId: 42 },
        });
      }
    });

    it("projects DM, topicless supergroup, and guest to general while retaining chatId", () => {
      // General surfaces retain discovery chat — curated scope and
      // transcript/discovery boundary are different facts.
      expect(resolveActiveScope(dmSurface(123))).toEqual({
        chatId: 123,
        topicScope: "general",
      });
      expect(resolveActiveScope(supergroupSurface(-100123))).toEqual({
        chatId: -100123,
        topicScope: "general",
      });
      expect(resolveActiveScope(guestSurface(-100999))).toEqual({
        chatId: -100999,
        topicScope: "general",
      });
    });

    it("does not carry named-agent identity — persona is caller-owned", () => {
      // ActiveScope carries only routing facts. Persona identity lives in
      // MemoryCaller, not in the Surface projection. This is the boundary
      // that prevents impossible states where a deterministic Surface
      // projection disagrees with caller identity.
      const topic = resolveActiveScope(topicSurface("supergroup", -100123, 42));
      const dm = resolveActiveScope(dmSurface(123));
      expect("namedAgent" in topic).toBe(false);
      expect("namedAgent" in dm).toBe(false);
    });
  });

  describe("SurfaceMemoryAuthority", () => {
    it("carries canonical source SurfaceId and projected ActiveScope", () => {
      const surface = topicSurface("supergroup", -100123, 42);
      const authority = surfaceAuthority(surface);
      expect(authority.kind).toBe("surface");
      expect(authority.sourceSurfaceId).toBe(surfaceId(surface));
      expect(authority.activeScope).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      });
    });

    it("SurfaceId round-trips through parseSurfaceId", () => {
      const surface = dmSurface(123);
      const authority = surfaceAuthority(surface);
      expect(parseSurfaceId(authority.sourceSurfaceId)).toEqual(surface);
    });

    it("general-surface authority retains chatId for discovery", () => {
      const dm = surfaceAuthority(dmSurface(123));
      const guest = surfaceAuthority(guestSurface(-100999));
      expect(dm.activeScope).toEqual({ chatId: 123, topicScope: "general" });
      expect(guest.activeScope).toEqual({ chatId: -100999, topicScope: "general" });
    });
  });

  describe("assertSurfaceBackedAuthorityInput — zero-chat rejection", () => {
    it("rejects a zero-chat DM Surface as Telegram identity", () => {
      // The dreaming compatibility session historically used chatId: 0 as a
      // sentinel. That value MUST NOT be reinterpreted as a Telegram Surface
      // or used to construct SurfaceMemoryAuthority. Internal callers use
      // InternalMemoryContext instead.
      const zeroChat = { kind: "dm", chatId: 0 } as unknown as Surface;
      expect(() => assertSurfaceBackedAuthorityInput(zeroChat)).toThrow(
        /zero-chat Surface/,
      );
    });

    it("rejects a zero-chat topic Surface", () => {
      const zeroChat = {
        kind: "topic",
        container: "supergroup",
        chatId: 0,
        topicId: 42,
      } as unknown as Surface;
      expect(() => assertSurfaceBackedAuthorityInput(zeroChat)).toThrow(
        /zero-chat Surface/,
      );
    });

    it("accepts every valid non-zero Surface kind", () => {
      expect(() => assertSurfaceBackedAuthorityInput(dmSurface(123))).not.toThrow();
      expect(() => assertSurfaceBackedAuthorityInput(supergroupSurface(-100123))).not.toThrow();
      expect(() => assertSurfaceBackedAuthorityInput(guestSurface(-100999))).not.toThrow();
      expect(() =>
        assertSurfaceBackedAuthorityInput(topicSurface("supergroup", -100123, 42)),
      ).not.toThrow();
    });
  });

  describe("InternalMemoryContext — Surface-free internal boundary", () => {
    it("carries no SurfaceId or ActiveScope", () => {
      const ctx: InternalMemoryContext = { kind: "internal", caller: { kind: "internal" } };
      expect(ctx.kind).toBe("internal");
      expect(ctx.caller.kind).toBe("internal");
      expect("sourceSurfaceId" in ctx).toBe(false);
      expect("activeScope" in ctx).toBe(false);
    });

    it("is structurally distinct from SurfaceMemoryAuthority", () => {
      // The discriminated union keeps internal callers from being
      // misinterpreted as Telegram Surfaces. A Surface-backed authority has
      // `kind: "surface"`; an internal context has `kind: "internal"`. The
      // two cannot be confused at a type level.
      const surface: SurfaceMemoryAuthority = surfaceAuthority(dmSurface(123));
      const internal: InternalMemoryContext = { kind: "internal", caller: { kind: "internal" } };
      expect(surface.kind).toBe("surface");
      expect(internal.kind).toBe("internal");
      expect((surface.kind as string) === (internal.kind as string)).toBe(false);
    });
  });

  describe("CapturedMemoryContext — type-level shape", () => {
    it("bundles authority, caller, frozen summary, and deduplication bodies", () => {
      // Phase 1 only defines the type; the async capture factory lands in
      // Phase 2. This test pins the structural contract so Phase 2 cannot
      // accidentally drop a field.
      const captured: CapturedMemoryContext = {
        kind: "surface",
        authority: surfaceAuthority(topicSurface("supergroup", -100123, 42)),
        caller: { kind: "main" },
        frozenSummary: "[goblin memory summary (frozen at session start)] ...",
        frozenUserBody: "user prefers backups weekly",
        frozenActiveMemoryBody: "topic fact",
      };
      expect(captured.authority.kind).toBe("surface");
      expect(captured.authority.sourceSurfaceId).toBe(
        surfaceId(topicSurface("supergroup", -100123, 42)),
      );
      expect(captured.authority.activeScope).toEqual({
        chatId: -100123,
        topicScope: { topicId: 42 },
      } satisfies ActiveScope);
      expect(captured.caller.kind).toBe("main");
      expect(captured.frozenSummary).toContain("frozen at session start");
      expect(typeof captured.frozenUserBody).toBe("string");
      expect(typeof captured.frozenActiveMemoryBody).toBe("string");
    });

    it("allows a null frozen summary when all eligible sources are empty", () => {
      const captured: CapturedMemoryContext = {
        kind: "surface",
        authority: surfaceAuthority(dmSurface(123)),
        caller: { kind: "main" },
        frozenSummary: null,
        frozenUserBody: "",
        frozenActiveMemoryBody: "",
      };
      expect(captured.frozenSummary).toBeNull();
    });

    it("carries named-subagent caller identity separately from ActiveScope", () => {
      // Persona identity lives in the caller descriptor, not in ActiveScope.
      // A named-subagent capture carries the persona name on `caller`, while
      // `authority.activeScope` carries only routing facts.
      const captured: CapturedMemoryContext = {
        kind: "surface",
        authority: surfaceAuthority(topicSurface("supergroup", -100123, 42)),
        caller: { kind: "named-subagent", name: "researcher" },
        frozenSummary: null,
        frozenUserBody: "",
        frozenActiveMemoryBody: "",
      };
      expect(captured.caller).toEqual({ kind: "named-subagent", name: "researcher" });
      expect("namedAgent" in captured.authority.activeScope).toBe(false);
    });
  });

  describe("captureRuntimeMemoryContext", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "goblin-rt-ctx-"));
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("captures a complete immutable context from a DM Surface", async () => {
      const store = new MemoryStore(tmpDir);
      try {
        await store.add("general", "goblin lives in telegram");
        await store.add("user", "user prefers concise replies");
        const captured = await captureRuntimeMemoryContext({
          surface: dmSurface(123),
          caller: { kind: "main" },
          store,
        });
        expect(captured.kind).toBe("surface");
        expect(captured.authority.kind).toBe("surface");
        expect(captured.authority.sourceSurfaceId).toBe(surfaceId(dmSurface(123)));
        expect(captured.authority.activeScope).toEqual({ chatId: 123, topicScope: "general" });
        expect(captured.caller).toEqual({ kind: "main" });
        expect(captured.frozenSummary).not.toBeNull();
        expect(captured.frozenSummary).toContain("goblin lives in telegram");
        expect(captured.frozenUserBody).toContain("user prefers concise replies");
        expect(captured.frozenActiveMemoryBody).toContain("goblin lives in telegram");
      } finally {
        store.close();
      }
    });

    it("freezes the summary and dedup bodies — post-capture writes do not alter the capture", async () => {
      const store = new MemoryStore(tmpDir);
      try {
        await store.add("general", "original fact");
        const captured = await captureRuntimeMemoryContext({
          surface: dmSurface(123),
          caller: { kind: "main" },
          store,
        });
        // Write after capture — the frozen summary and dedup bodies must not
        // change.
        await store.add("general", "post-capture fact");
        expect(captured.frozenSummary).toContain("original fact");
        expect(captured.frozenSummary).not.toContain("post-capture fact");
        expect(captured.frozenActiveMemoryBody).toContain("original fact");
        expect(captured.frozenActiveMemoryBody).not.toContain("post-capture fact");
      } finally {
        store.close();
      }
    });

    it("returns a null frozen summary when all eligible sources are empty", async () => {
      const store = new MemoryStore(tmpDir);
      try {
        const captured = await captureRuntimeMemoryContext({
          surface: dmSurface(123),
          caller: { kind: "main" },
          store,
        });
        expect(captured.frozenSummary).toBeNull();
        expect(captured.frozenUserBody).toBe("");
        expect(captured.frozenActiveMemoryBody).toBe("");
      } finally {
        store.close();
      }
    });

    it("rejects a zero-chat Surface as Telegram identity", async () => {
      const store = new MemoryStore(tmpDir);
      try {
        await expect(
          captureRuntimeMemoryContext({
            surface: { kind: "dm", chatId: 0 } as Surface,
            caller: { kind: "main" },
            store,
          }),
        ).rejects.toThrow(/zero-chat Surface/);
      } finally {
        store.close();
      }
    });

    it("captures a topic-bound surface with the correct active scope", async () => {
      const store = new MemoryStore(tmpDir);
      try {
        await store.add({ topic: { chatId: -100, topicId: 42 } }, "topic fact");
        const captured = await captureRuntimeMemoryContext({
          surface: topicSurface("supergroup", -100, 42),
          caller: { kind: "main" },
          store,
        });
        expect(captured.authority.activeScope).toEqual({
          chatId: -100,
          topicScope: { topicId: 42 },
        });
        expect(captured.frozenActiveMemoryBody).toContain("topic fact");
      } finally {
        store.close();
      }
    });
  });
});
