import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import type { ConversationId, ConversationState, SessionState } from "../sessions/types.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import type { BindingStore } from "../sessions/bindings.ts";
import { FileBindingStore } from "../sessions/bindings.ts";
import { getProjectRoot, bindProjectRoot, getModelName, getThinkingLevelValidated, setModelName, setThinkingLevel } from "../sessions/topic-settings.ts";
import { assertCanonicalProjectRoot, environmentFromProjectRoot, environmentsEqual, projectEnvironment, projectRootOf } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { BindingsFile } from "../sessions/types.ts";
import { isValidConversationId } from "../sessions/conversation.ts";
import { runtimeSessionWithPreferences } from "../sessions/conversation.ts";
import { log } from "../log.ts";
import type { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import type { AttachmentSignal, AttachedWork, SurfaceRuntimeAuthority } from "./dispatcher.ts";
import { withLifecycleTransitionLock } from "./lifecycle-transition-lock.ts";
import type { ProjectAssignmentIntent } from "../sessions/project-assignment.ts";
import {
  createOrVerifyProjectSession,
  loadPendingProjectAssignment,
  reconcilePendingProjectAssignment,
  savePendingProjectAssignment,
  clearPendingProjectAssignment,
} from "../sessions/project-assignment.ts";

/**
 * Surface-scoped settings adapter used by the lifecycle to determine the
 * effective execution environment, model, and thinking preferences for a
 * Surface. Model and thinking are owned by the Surface and survive conversation
 * rotation, resume, and archive.
 */
export interface SurfaceSettings {
  effectiveEnvironment(surface: Surface): ExecutionEnvironment;
  getModelName(surface: Surface): string | undefined;
  setModelName(surface: Surface, modelName: string | undefined): void;
  getThinkingLevel(surface: Surface): ThinkingLevel | undefined;
  setThinkingLevel(surface: Surface, thinkingLevel: ThinkingLevel | undefined): void;
}

/**
 * Public seam for callers (intake, commands, scheduler). Every method that
 * changes a binding runs under the lifecycle transition lock internally.
 */
export interface ConversationLifecycle extends SurfaceRuntimeAuthority {
  /** Surface-scoped settings (project, model, thinking). Exposed so commands can read/write Surface preferences. */
  readonly settings: SurfaceSettings;
  /**
   * Non-mutating status lookup. Runtime acquisition MUST use
   * `assertCurrentBinding`, which reconciles a pending assignment under the
   * lifecycle transition lock before returning authority.
   */
  inspect(surface: Surface): ConversationState | null;
  resolveOrStart(surface: Surface): Promise<ConversationState>;
  rotate(surface: Surface): Promise<ConversationState>;
  resume(surface: Surface, target: ConversationId): Promise<ConversationState>;
  archive(surface: Surface): Promise<void>;
  assignProject(surface: Surface, requestedRoot: string): Promise<ProjectAssignmentResult>;
  listResumable(surface: Surface): ConversationState[];
}

export type ProjectAssignmentResult =
  | { kind: "assigned"; session: SessionState; projectRoot: string; previousSessionId?: string }
  | { kind: "already-assigned"; session?: SessionState; projectRoot?: string }
  | { kind: "conflict"; currentRoot: string };

function cloneBindings(bindings: BindingsFile): BindingsFile {
  return { version: 1, surfaces: { ...bindings.surfaces } } as BindingsFile;
}

/**
 * Deep conversation lifecycle: owns inspect/resolve-or-start/rotate/resume/
 * archive and the runtime-first transition ordering for each.
 */
export class ConversationLifecycleManager implements ConversationLifecycle {
  private readonly home: string;
  private readonly store: ConversationStore;
  private readonly bindings: BindingStore;
  readonly settings: SurfaceSettings;
  private readonly runtimeHost: ConversationRuntimeHost;

  constructor(
    home: string,
    store: ConversationStore,
    bindings: BindingStore,
    settings: SurfaceSettings,
    runtimeHost: ConversationRuntimeHost,
  ) {
    this.home = home;
    this.store = store;
    this.bindings = bindings;
    this.settings = settings;
    this.runtimeHost = runtimeHost;
  }

  inspect(surface: Surface): ConversationState | null {
    const key = surfaceId(surface);
    const bindings = this.bindings.load();
    const id = bindings.surfaces[key];
    if (!id || !isValidConversationId(id)) return null;

    const conv = this.store.load(id);
    if (!conv) return null;

    const env = this.settings.effectiveEnvironment(surface);
    if (!environmentsEqual(conv.executionEnvironment, env)) return null;

    return conv;
  }

  async resolveOrStart(surface: Surface): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];

      if (currentId) {
        let current: ConversationState | null = null;
        if (isValidConversationId(currentId)) {
          current = this.store.load(currentId as ConversationId);
        }
        if (current && environmentsEqual(current.executionEnvironment, env)) {
          return current;
        }
        if (current) {
          await this.runtimeHost.disposeRuntime(current.id);
        } else if (isValidConversationId(currentId)) {
          // Binding points to a missing conversation; drop any in-memory runner
          // keyed by the stale id before overwriting it.
          await this.runtimeHost.disposeRuntime(currentId as ConversationId);
        }
      }

      const created = this.store.create(env);
      const next = cloneBindings(bindings);
      next.surfaces[key] = created.id;
      this.bindings.save(next);
      log.info("conversation started", { surface: key, conversation: created.id, environment: env });
      return created;
    });
  }

  async rotate(surface: Surface): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];

      if (currentId) {
        let current: ConversationState | null = null;
        if (isValidConversationId(currentId)) {
          current = this.store.load(currentId as ConversationId);
        }
        if (current) {
          await this.runtimeHost.disposeRuntime(current.id);
        } else if (isValidConversationId(currentId)) {
          // Stale binding: drop any runner keyed by the old id before creating
          // the replacement, otherwise it can outlive its conversation.
          await this.runtimeHost.disposeRuntime(currentId as ConversationId);
        }
      }

      const created = this.store.create(env);
      const next = cloneBindings(bindings);
      next.surfaces[key] = created.id;
      this.bindings.save(next);
      log.info("conversation rotated", { surface: key, conversation: created.id, environment: env });
      return created;
    });
  }

  async resume(surface: Surface, target: ConversationId): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      const env = this.settings.effectiveEnvironment(surface);
      const targetConv = this.store.load(target);
      if (!targetConv) {
        throw new Error(`conversation not found: ${target}`);
      }
      if (!environmentsEqual(targetConv.executionEnvironment, env)) {
        throw new Error(`environment mismatch: cannot resume ${target} on this surface`);
      }

      const bindings = this.bindings.load();
      const currentAtDst = bindings.surfaces[key];
      if (currentAtDst === target) {
        return targetConv;
      }

      const sourceKey = this.findBoundSurface(bindings, target);
      // If the target is already bound to the destination surface, this is a no-op.
      if (sourceKey === key) {
        return targetConv;
      }

      // Dispose any runtime at the destination (about to be displaced) and at
      // the source (for a cross-surface move) before committing the binding
      // change. Disposal is best-effort idempotent; if it fails we abort.
      if (currentAtDst && isValidConversationId(currentAtDst)) {
        await this.runtimeHost.disposeRuntime(currentAtDst);
      }
      if (sourceKey !== undefined) {
        await this.runtimeHost.disposeRuntime(target);
      }

      const next = cloneBindings(bindings);
      if (currentAtDst) {
        delete (next.surfaces as Record<string, string>)[key];
      }
      if (sourceKey !== undefined) {
        delete (next.surfaces as Record<string, string>)[sourceKey];
      }
      next.surfaces[key] = target;
      this.bindings.save(next);
      log.info("conversation resumed", {
        surface: key,
        conversation: target,
        environment: env,
        sourceSurface: sourceKey,
        displaced: currentAtDst,
      });
      return targetConv;
    });
  }

  async archive(surface: Surface): Promise<void> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];
      if (!currentId) {
        throw new Error("no active conversation on this surface");
      }

      let current: ConversationState | null = null;
      if (isValidConversationId(currentId)) {
        current = this.store.load(currentId as ConversationId);
      }
      if (!current) {
        // A stale or malformed binding points to nothing durable. If the id is
        // syntactically valid, drop any in-memory runner keyed by it, but do not
        // mutate the binding map — the caller should see this as a failure.
        if (isValidConversationId(currentId)) {
          await this.runtimeHost.disposeRuntime(currentId as ConversationId);
        }
        throw new Error("no active conversation on this surface");
      }

      await this.runtimeHost.disposeRuntime(current.id);
      const next = cloneBindings(bindings);
      delete (next.surfaces as Record<string, string>)[key];
      this.bindings.save(next);
      this.store.archive(current.id);
      log.info("conversation archived", { surface: key, conversation: current.id });
    });
  }

  async assignProject(surface: Surface, requestedRoot: string): Promise<ProjectAssignmentResult> {
    return withLifecycleTransitionLock(async () => {
      assertCanonicalProjectRoot(requestedRoot, "requested projectRoot");
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);

      const settingsRoot = getProjectRoot(this.home, surface);
      const existingEnv = environmentFromProjectRoot(settingsRoot);
      const requestedEnv = projectEnvironment(requestedRoot);

      // Already assigned to the same canonical root: idempotent report.
      if (existingEnv.kind === "project" && environmentsEqual(existingEnv, requestedEnv)) {
        const bindings = this.bindings.load();
        const boundId = bindings.surfaces[key];
        const boundConv = boundId && isValidConversationId(boundId) ? this.store.load(boundId as ConversationId) : null;
        return {
          kind: "already-assigned",
          projectRoot: requestedRoot,
          session: boundConv ? runtimeSessionWithPreferences(boundConv, surface, this.home) : undefined,
        };
      }

      // Already assigned to a different root: immutable.
      if (existingEnv.kind === "project") {
        return { kind: "conflict", currentRoot: projectRootOf(existingEnv) ?? requestedRoot };
      }

      // Personal/unassigned: proceed with first assignment.
      const bindings = this.bindings.load();
      const rawPreviousSessionId = bindings.surfaces[key];
      const previousSessionId = rawPreviousSessionId && isValidConversationId(rawPreviousSessionId) ? rawPreviousSessionId : undefined;

      if (previousSessionId) {
        // Synchronously invalidate and quiesce the prior runtime. Failure here
        // leaves no intent and no change to settings/binding.
        try {
          await this.runtimeHost.disposeRuntime(previousSessionId as ConversationId);
        } catch (err) {
          log.error("prior runtime quiescence failed during project assignment", {
            surfaceId: key,
            previousSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new Error(`Failed to quiesce the current conversation: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const plannedSessionId = this.store.allocateId();
      const intent: ProjectAssignmentIntent = {
        version: 1,
        surfaceId: key,
        previousSessionId,
        plannedSessionId,
        projectRoot: requestedRoot,
      };
      savePendingProjectAssignment(this.home, intent);

      let conv: ConversationState;
      try {
        conv = createOrVerifyProjectSession(this.store, surface, plannedSessionId, requestedRoot);
        bindProjectRoot(this.home, surface, requestedRoot);
        const nextBindings = cloneBindings(bindings);
        nextBindings.surfaces[key] = plannedSessionId;
        this.bindings.save(nextBindings);
        clearPendingProjectAssignment(this.home);
      } catch (err) {
        log.error("project assignment failed after intent persistence", {
          surfaceId: key,
          plannedSessionId,
          projectRoot: requestedRoot,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      return {
        kind: "assigned",
        session: runtimeSessionWithPreferences(conv, surface, this.home),
        projectRoot: requestedRoot,
        previousSessionId,
      };
    });
  }

  listResumable(surface: Surface): ConversationState[] {
    const env = this.settings.effectiveEnvironment(surface);
    return this.store.list(env);
  }

  async assertCurrentBinding(surface: Surface, conversationId: string): Promise<void> {
    await withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      this.assertCurrentBindingLocked(surface, conversationId);
    });
  }

  isCurrentBinding(surface: Surface, conversationId: string): boolean {
    try {
      // A pending assignment is an unresolved authority transition. The
      // synchronous stale-runner guard must fail closed; only the async
      // acquisition path may reconcile it under the lifecycle lock.
      if (loadPendingProjectAssignment(this.home) !== null) return false;
      const current = this.inspect(surface);
      return current?.id === conversationId;
    } catch (error) {
      log.error("current binding authority check failed", {
        surfaceId: surfaceId(surface),
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async withCurrentBinding<T>(
    surface: Surface,
    conversationId: string,
    fn: (signal: AttachmentSignal) => Promise<AttachedWork<T>>,
  ): Promise<AttachedWork<T>> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment(key);
      this.assertCurrentBindingLocked(surface, conversationId);
      const signal = createAttachmentSignal();
      const work = fn(signal);
      work.catch((err) => {
        if (!signal.settled) signal.failed(err);
      });
      await signal.promise;
      return work;
    });
  }

  private assertCurrentBindingLocked(surface: Surface, conversationId: string): void {
    const key = surfaceId(surface);
    const current = this.inspect(surface);
    if (current?.id !== conversationId) {
      throw new Error(
        `binding rotated: surface ${key} is bound to ${current?.id ?? "unbound"}, expected ${conversationId}`,
      );
    }
  }

  private findBoundSurface(bindings: BindingsFile, conversationId: string): SurfaceId | undefined {
    for (const [sid, cid] of Object.entries(bindings.surfaces)) {
      if (cid === conversationId) return sid as SurfaceId;
    }
    return undefined;
  }

  /**
   * Replay any pending project-assignment intent and dispose the runtime that
   * was bound to this surface before the replay, if the replay changed the
   * binding. This keeps ordinary message resolution from creating a fresh
   * conversation that conflicts with a not-yet-cleared assignment intent.
   */
  private async reconcilePendingAssignment(surfaceKey: SurfaceId): Promise<void> {
    const before = this.bindings.load();
    reconcilePendingProjectAssignment(this.home, this.store, this.bindings);
    const after = this.bindings.load();
    const oldId = before.surfaces[surfaceKey];
    const newId = after.surfaces[surfaceKey];
    if (oldId && oldId !== newId && isValidConversationId(oldId)) {
      await this.runtimeHost.disposeRuntime(oldId);
    }
  }
}

export class FileSurfaceSettings implements SurfaceSettings {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  effectiveEnvironment(surface: Surface): ExecutionEnvironment {
    const root = getProjectRoot(this.home, surface);
    return environmentFromProjectRoot(root);
  }

  getModelName(surface: Surface): string | undefined {
    return getModelName(this.home, surface);
  }

  setModelName(surface: Surface, modelName: string | undefined): void {
    setModelName(this.home, surface, modelName);
  }

  getThinkingLevel(surface: Surface): ThinkingLevel | undefined {
    return getThinkingLevelValidated(this.home, surface);
  }

  setThinkingLevel(surface: Surface, thinkingLevel: ThinkingLevel | undefined): void {
    setThinkingLevel(this.home, surface, thinkingLevel);
  }
}

type MutableAttachmentSignal = AttachmentSignal & {
  promise: Promise<void>;
  failed(err: unknown): void;
  settled: boolean;
};

function createAttachmentSignal(): MutableAttachmentSignal {
  let resolveAttached!: () => void;
  let rejectAttached!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveAttached = resolve;
    rejectAttached = reject;
  });
  const signal: MutableAttachmentSignal = {
    attached: () => {
      if (!signal.settled) {
        signal.settled = true;
        resolveAttached();
      }
    },
    failed: (err) => {
      if (!signal.settled) {
        signal.settled = true;
        rejectAttached(err);
      }
    },
    promise,
    settled: false,
  };
  return signal;
}

/**
 * Build a file-backed ConversationLifecycle for production wiring.
 */
export function createConversationLifecycle(
  home: string,
  runtimeHost: ConversationRuntimeHost,
  settings?: SurfaceSettings,
): ConversationLifecycle {
  return new ConversationLifecycleManager(
    home,
    new ConversationStore(home),
    new FileBindingStore(home),
    settings ?? new FileSurfaceSettings(home),
    runtimeHost,
  );
}
