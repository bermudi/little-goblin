import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import type { ActiveScope } from "./scope.ts";
import { resolveActiveScope } from "./scope.ts";
import type { MemoryCaller } from "./context.ts";

/**
 * Surface-derived memory authority: the immutable routing authority captured
 * from a validated Telegram {@link Surface} at conversation-runtime creation.
 *
 * A `SurfaceMemoryAuthority` is the only Surface-backed input to memory
 * behavior. It carries the canonical source {@link SurfaceId} (so transcript
 * provenance and logs can identify the originating lane even after a
 * Conversation moves) and the deterministically projected {@link ActiveScope}.
 * Persona identity is NOT part of this authority — it lives in the paired
 * {@link MemoryCaller}.
 *
 * Subagent invocations inherit their parent invocation's `SurfaceMemoryAuthority`
 * while deriving their own caller descriptor. A revived invocation captures the
 * reviving parent runtime's authority, not the persisted legacy scope.
 */
export interface SurfaceMemoryAuthority {
  kind: "surface";
  /** Canonical, reversible identity of the originating Telegram Surface. */
  sourceSurfaceId: SurfaceId;
  /** Deterministic `Surface → ActiveScope` projection. */
  activeScope: ActiveScope;
}

/**
 * Caller descriptor for internal model work that has no Telegram Surface.
 *
 * Internal callers (e.g. the dreaming extractor) MUST use this explicit
 * Surface-free context. They MUST NOT call {@link resolveActiveScope}, invent
 * an internal Surface, or reinterpret `chatId: 0` as a Telegram Surface. An
 * internal context has no ordinary active-memory write target; promotion scope
 * is resolved later from transcript provenance, not from this context.
 *
 * The compatibility dreaming session may continue to exist until the
 * `inner-life`/`visible-dreaming` migration; it remains outside this type
 * boundary.
 */
export interface InternalMemoryContext {
  kind: "internal";
  caller: { kind: "internal" };
}

/**
 * A complete immutable runtime memory context captured once at
 * conversation-runtime creation.
 *
 * The capture contains the validated source {@link SurfaceId}, the projected
 * {@link ActiveScope}, the caller descriptor, the frozen summary, and the
 * frozen-summary deduplication inputs. `AgentRunner` and subagent execution
 * receive this capture rather than its individual policy fields, so summary,
 * deduplication, search boundary, and writes cannot disagree.
 *
 * The capture is created before the conversation runtime registers an
 * `AgentRunner` and remains immutable for that runtime lifetime. Disposing and
 * replacing the runtime is the only way to change its memory context.
 */
export interface CapturedMemoryContext {
  authority: SurfaceMemoryAuthority;
  caller: MemoryCaller;
  /** Bounded frozen summary, or `null` when all eligible sources are empty. */
  frozenSummary: string | null;
  /** Frozen `user.md` body captured alongside the summary — deduplication input. */
  frozenUserBody: string;
  /** Frozen active `memory.md` body captured alongside the summary — deduplication input. */
  frozenActiveMemoryBody: string;
}

/**
 * Reject zero-chat compatibility values as Telegram identity.
 *
 * A Telegram `Surface` always carries a non-zero `chatId` (see
 * `src/surface.ts`'s `assertNonZeroSafeInteger`). The dreaming compatibility
 * session historically used `chatId: 0` as a sentinel; that value MUST NOT be
 * reinterpreted as a Telegram Surface or used to construct a
 * {@link SurfaceMemoryAuthority}. Internal callers use
 * {@link InternalMemoryContext} instead.
 *
 * This guard exists as a belt-and-suspenders boundary: any attempt to build
 * Surface-backed authority from a zero-chat (or otherwise invalid) Surface
 * fails loudly rather than silently producing a fake Telegram identity.
 */
export function assertSurfaceBackedAuthorityInput(surface: Surface): void {
  if (surface.chatId === 0) {
    throw new Error(
      "SurfaceMemoryAuthority cannot be derived from a zero-chat Surface; internal callers must use InternalMemoryContext",
    );
  }
  // `surfaceId` re-validates the Surface and round-trips the encoding; an
  // invalid Surface throws here before authority is constructed.
  surfaceId(surface);
}
