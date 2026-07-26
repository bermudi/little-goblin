import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import type { ConversationId, ConversationState } from "../sessions/types.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import type { BindingStore } from "../sessions/bindings.ts";
import { FileBindingStore } from "../sessions/bindings.ts";
import { getProjectRoot } from "../sessions/topic-settings.ts";
import { environmentFromProjectRoot, environmentsEqual } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { BindingsFile } from "../sessions/types.ts";
import type { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import { withLifecycleTransitionLock } from "./lifecycle-transition-lock.ts";

/**
 * Surface-scoped settings adapter used by the lifecycle to determine the
 * effective execution environment for a Surface. In this phase it only needs
 * project-root assignment; model/thinking/skill policy come later.
 */
export interface SurfaceSettings {
  effectiveEnvironment(surface: Surface): ExecutionEnvironment;
}

/**
 * Public seam for callers (intake, commands, scheduler). Every method that
 * changes a binding runs under the lifecycle transition lock internally.
 */
export interface ConversationLifecycle {
  inspect(surface: Surface): ConversationState | null;
  resolveOrStart(surface: Surface): Promise<ConversationState>;
  rotate(surface: Surface): Promise<ConversationState>;
  resume(surface: Surface, target: ConversationId): Promise<ConversationState>;
  archive(surface: Surface): Promise<void>;
  listResumable(surface: Surface): ConversationState[];
}

function cloneBindings(bindings: BindingsFile): BindingsFile {
  return { version: 1, surfaces: { ...bindings.surfaces } };
}

/**
 * Deep conversation lifecycle: owns inspect/resolve-or-start/rotate/resume/
 * archive and the runtime-first transition ordering for each.
 */
export class ConversationLifecycleManager implements ConversationLifecycle {
  private readonly store: ConversationStore;
  private readonly bindings: BindingStore;
  private readonly settings: SurfaceSettings;
  private readonly runtimeHost: ConversationRuntimeHost;

  constructor(
    store: ConversationStore,
    bindings: BindingStore,
    settings: SurfaceSettings,
    runtimeHost: ConversationRuntimeHost,
  ) {
    this.store = store;
    this.bindings = bindings;
    this.settings = settings;
    this.runtimeHost = runtimeHost;
  }

  inspect(surface: Surface): ConversationState | null {
    const key = surfaceId(surface);
    const bindings = this.bindings.load();
    const id = bindings.surfaces[key];
    if (!id) return null;

    const conv = this.store.load(id as ConversationId);
    if (!conv) return null;

    const env = this.settings.effectiveEnvironment(surface);
    if (!environmentsEqual(conv.executionEnvironment, env)) return null;

    return conv;
  }

  async resolveOrStart(surface: Surface): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];

      if (currentId) {
        const current = this.store.load(currentId as ConversationId);
        if (current && environmentsEqual(current.executionEnvironment, env)) {
          return current;
        }
        if (current) {
          await this.runtimeHost.disposeRuntime(current.id);
        }
      }

      const created = this.store.create(env);
      const next = cloneBindings(bindings);
      next.surfaces[key] = created.id;
      this.bindings.save(next);
      return created;
    });
  }

  async rotate(surface: Surface): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];

      if (currentId) {
        const current = this.store.load(currentId as ConversationId);
        if (current) {
          await this.runtimeHost.disposeRuntime(current.id);
        }
      }

      const created = this.store.create(env);
      const next = cloneBindings(bindings);
      next.surfaces[key] = created.id;
      this.bindings.save(next);
      return created;
    });
  }

  async resume(surface: Surface, target: ConversationId): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
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
      if (sourceKey === key) {
        return targetConv;
      }

      if (sourceKey) {
        await this.runtimeHost.disposeRuntime(target);
      }

      if (currentAtDst) {
        const displaced = this.store.load(currentAtDst as ConversationId);
        if (displaced) {
          await this.runtimeHost.disposeRuntime(displaced.id);
        }
      }

      const next = cloneBindings(bindings);
      if (sourceKey) {
        delete next.surfaces[sourceKey];
      }
      next.surfaces[key] = target;
      this.bindings.save(next);
      return targetConv;
    });
  }

  async archive(surface: Surface): Promise<void> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];
      if (!currentId) {
        throw new Error("no active conversation on this surface");
      }

      const current = this.store.load(currentId as ConversationId);
      if (!current) {
        const next = cloneBindings(bindings);
        delete next.surfaces[key];
        this.bindings.save(next);
        throw new Error("no active conversation on this surface");
      }

      await this.runtimeHost.disposeRuntime(current.id);
      this.store.archive(current.id);
      const next = cloneBindings(bindings);
      delete next.surfaces[key];
      this.bindings.save(next);
    });
  }

  listResumable(surface: Surface): ConversationState[] {
    const env = this.settings.effectiveEnvironment(surface);
    return this.store.list(env);
  }

  private findBoundSurface(bindings: BindingsFile, conversationId: string): SurfaceId | undefined {
    for (const [sid, cid] of Object.entries(bindings.surfaces)) {
      if (cid === conversationId) return sid as SurfaceId;
    }
    return undefined;
  }
}

class FileSurfaceSettings implements SurfaceSettings {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  effectiveEnvironment(surface: Surface): ExecutionEnvironment {
    const root = getProjectRoot(this.home, surface);
    return environmentFromProjectRoot(root);
  }
}

/**
 * Build a file-backed ConversationLifecycle for production wiring.
 */
export function createConversationLifecycle(
  home: string,
  runtimeHost: ConversationRuntimeHost,
): ConversationLifecycle {
  return new ConversationLifecycleManager(
    new ConversationStore(home),
    new FileBindingStore(home),
    new FileSurfaceSettings(home),
    runtimeHost,
  );
}
