import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import { activeMemoryScopeFor, resolveActiveScope } from "./scope.ts";
import type { ActiveScope } from "./scope.ts";
import type { MemoryCaller } from "./context.ts";
import type { MemoryStore, ParsedMemory } from "./store.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { formatFrozenSummary } from "./snapshot.ts";

/**
 * Surface-derived memory authority: the immutable routing authority captured
 * from a validated Telegram {@link Surface}. Carries the source
 * {@link SurfaceId} (for transcript provenance and logs) and the projected
 * {@link ActiveScope}. Persona identity lives in the paired {@link MemoryCaller},
 * not here.
 */
export interface SurfaceMemoryAuthority {
  readonly kind: "surface";
  /** Canonical, reversible identity of the originating Telegram Surface. */
  readonly sourceSurfaceId: SurfaceId;
  /** Deterministic `Surface → ActiveScope` projection. */
  readonly activeScope: ActiveScope;
}

/**
 * Caller descriptor for internal model work with no Telegram Surface. Internal
 * callers MUST NOT call {@link resolveActiveScope} or reinterpret `chatId: 0`
 * as a Surface. An internal context has no ordinary active-memory write target.
 */
export interface InternalMemoryContext {
  readonly kind: "internal";
  readonly caller: { kind: "internal" };
}

/**
 * A complete immutable runtime memory context captured once at
 * conversation-runtime creation. `AgentRunner` and subagent execution receive
 * this capture rather than its individual policy fields, so summary,
 * deduplication, search boundary, and writes cannot disagree. Disposing and
 * replacing the runtime is the only way to change its memory context.
 */
export interface CapturedMemoryContext {
  /** Discriminator: distinguishes from {@link InternalMemoryContext}. */
  readonly kind: "surface";
  readonly authority: SurfaceMemoryAuthority;
  readonly caller: MemoryCaller;
  /** Bounded frozen summary, or `null` when all eligible sources are empty. */
  readonly frozenSummary: string | null;
  /** Frozen `user.md` body captured alongside the summary — deduplication input. */
  readonly frozenUserBody: string;
  /** Frozen active `memory.md` body captured alongside the summary — deduplication input. */
  readonly frozenActiveMemoryBody: string;
}

/**
 * Detach and recursively freeze the routing objects in a captured context.
 * Callers may supply inherited authority objects, so freezing those objects in
 * place would mutate their owner; the capture owns its cloned immutable copy.
 */
export function freezeCapturedMemoryContext(
  context: CapturedMemoryContext,
): CapturedMemoryContext {
  const activeScope = context.authority.activeScope;
  const topicScope = activeScope.topicScope === "general"
    ? "general"
    : Object.freeze({ topicId: activeScope.topicScope.topicId });
  const frozenActiveScope = Object.freeze({
    chatId: activeScope.chatId,
    topicScope,
  });
  const authority = Object.freeze({
    kind: "surface" as const,
    sourceSurfaceId: context.authority.sourceSurfaceId,
    activeScope: frozenActiveScope,
  });
  const caller = Object.freeze({ ...context.caller }) as MemoryCaller;
  return Object.freeze({
    ...context,
    authority,
    caller,
  });
}

/** Validate the complete Surface before deriving memory authority from it. */
export function assertSurfaceBackedAuthorityInput(surface: Surface): void {
  surfaceId(surface);
}

/**
 * Surface-backed caller descriptor: the subset of {@link MemoryCaller} that
 * has a Telegram Surface. Internal callers (`{ kind: "internal" }`) MUST NOT
 * use {@link captureRuntimeMemoryContext} — they use
 * {@link InternalMemoryContext} directly.
 */
export type SurfaceMemoryCaller = Exclude<MemoryCaller, { kind: "internal" }>;

/**
 * Arguments for {@link captureInvocationMemoryContext}.
 */
export interface CaptureInvocationMemoryContextArgs {
  /** The inherited Surface memory authority (source SurfaceId + ActiveScope). */
  authority: SurfaceMemoryAuthority;
  /** The caller descriptor — main, named-subagent, or anonymous-subagent. */
  caller: SurfaceMemoryCaller;
  /** The live memory store. Read only at capture time; never reread by the runtime. */
  store: MemoryStore;
  /** Optional topic-name resolver for the frozen summary's cross-scope index. */
  getTopicName?: (chatId: number, topicId: number) => Promise<string | null>;
  /** Optional metrics store to record snapshot events during capture. */
  metrics?: MetricsStore;
}

/**
 * Capture a complete immutable invocation memory context from an already
 * projected {@link SurfaceMemoryAuthority}.
 *
 * Reads the active-scope and user entries once and formats the frozen summary
 * before resolving. The active/user entries are passed to the formatter so the
 * summary text and deduplication bodies cannot diverge. This is the subagent
 * path: the Surface has already been validated and projected by the parent
 * runtime, so the child only derives its caller descriptor and captures from
 * the inherited authority.
 */
export async function captureInvocationMemoryContext(
  args: CaptureInvocationMemoryContextArgs,
): Promise<CapturedMemoryContext> {
  const { authority, caller, store, getTopicName, metrics } = args;
  const activeScope = authority.activeScope;

  const activeMemoryScope = activeMemoryScopeFor(activeScope);
  const activeEntry: ParsedMemory = store.read(activeMemoryScope);
  const userEntry: ParsedMemory = store.read("user");

  const frozenSummary = await formatFrozenSummary({
    store,
    activeScope,
    caller,
    getTopicName,
    metrics,
    frozenActiveEntry: activeEntry,
    frozenUserEntry: userEntry,
  });

  return freezeCapturedMemoryContext({
    kind: "surface",
    authority,
    caller,
    frozenSummary,
    frozenUserBody: userEntry.body,
    frozenActiveMemoryBody: activeEntry.body,
  });
}

/**
 * Arguments for {@link captureRuntimeMemoryContext}.
 */
export interface CaptureRuntimeMemoryContextArgs extends Omit<CaptureInvocationMemoryContextArgs, "authority"> {
  /** The validated Telegram Surface to project authority from. */
  surface: Surface;
}

/**
 * Capture a complete immutable runtime memory context from a validated Surface.
 *
 * Validates the Surface, encodes the source {@link SurfaceId}, projects
 * {@link ActiveScope}, reads the active-scope and user entries, and formats
 * the frozen summary — all before resolving. The active/user entries are read
 * once and passed to the formatter so the summary text and deduplication
 * bodies cannot diverge.
 *
 * The conversation-runtime factory awaits this capture before registering an
 * `AgentRunner`; a failed capture leaves no half-created runtime.
 */
export async function captureRuntimeMemoryContext(
  args: CaptureRuntimeMemoryContextArgs,
): Promise<CapturedMemoryContext> {
  const { surface, caller, store, getTopicName, metrics } = args;

  assertSurfaceBackedAuthorityInput(surface);
  const authority: SurfaceMemoryAuthority = {
    kind: "surface",
    sourceSurfaceId: surfaceId(surface),
    activeScope: resolveActiveScope(surface),
  };

  return captureInvocationMemoryContext({ authority, caller, store, getTopicName, metrics });
}
