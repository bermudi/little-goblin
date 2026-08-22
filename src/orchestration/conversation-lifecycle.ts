import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Surface, SurfaceId } from "../surface.ts";
import { surfaceId } from "../surface.ts";
import type { ConversationId, ConversationState } from "../sessions/types.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { FileBindingStore, validateBindings, type BindingStore } from "../sessions/bindings.ts";
import {
  getProjectRoot,
  getModelName,
  getSkillPolicy as getStoredSkillPolicy,
  getSurfaceRuntimeSettings,
  getThinkingLevelValidated,
  setModelName,
  setSkillPolicy as saveSkillPolicy,
  setThinkingLevel,
  patchSurfaceSettings,
  type SurfacePreferencePatch,
} from "../sessions/topic-settings.ts";
import { assertCanonicalProjectRoot, environmentFromProjectRoot, environmentsEqual, projectEnvironment, projectRootOf } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import {
  cloneSkillPolicy,
  resolveSkillSet,
  skillPolicyFingerprint,
  type ResolvedSkillSet,
  type SkillPolicy,
  type SkillSource,
  type SourceSelection,
} from "../agent/skills/mod.ts";
import type { BindingsFile } from "../sessions/types.ts";
import { isValidConversationId } from "../sessions/conversation.ts";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import { existsSync, readFileSync } from "node:fs";
import { log } from "../log.ts";
import type { ConversationRuntimeHostPort } from "./conversation-runtime-host.ts";
import type {
  AttachmentSignal,
  AttachedWork,
  SurfaceRuntimeAuthority,
} from "./surface-runtime-authority.ts";
import { withLifecycleTransitionLock } from "./lifecycle-transition-lock.ts";
import type { PreparedProjectAssignment, ProjectAssignmentIntent } from "../sessions/project-assignment.ts";
import {
  applyPreparedProjectAssignment,
  loadPendingProjectAssignment,
  preparePendingProjectAssignment,
  savePendingProjectAssignment,
} from "../sessions/project-assignment.ts";

/** Expected authority race: the requested binding is no longer current. */
export class BindingFencedError extends Error {
  readonly surfaceId: SurfaceId;
  readonly expectedConversationId: ConversationId;
  readonly currentConversationId: string | null;

  constructor(
    requestedSurfaceId: SurfaceId,
    expectedConversationId: ConversationId,
    currentConversationId: string | null,
  ) {
    super(
      `binding rotated: surface ${requestedSurfaceId} is bound to ${
        currentConversationId ?? "unbound"
      }, expected ${expectedConversationId}`,
    );
    this.name = "BindingFencedError";
    this.surfaceId = requestedSurfaceId;
    this.expectedConversationId = expectedConversationId;
    this.currentConversationId = currentConversationId;
  }
}

/**
 * Surface-scoped settings adapter used by the lifecycle to determine the
 * effective execution environment, model, thinking preferences, and skill
 * policy for a Surface. These settings survive conversation rotation, resume,
 * and archive; the execution environment itself remains Conversation-owned.
 */
export interface SurfaceRuntimeSettingsSnapshot {
  readonly executionEnvironment: ExecutionEnvironment;
  readonly modelName: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly skillPolicy: SkillPolicy;
  readonly fingerprint: string;
}

export interface SurfaceSettings {
  effectiveEnvironment(surface: Surface): ExecutionEnvironment;
  /** One coherent validated read for runtime preparation and stale checks. */
  getRuntimeSettings(surface: Surface): SurfaceRuntimeSettingsSnapshot;
  getModelName(surface: Surface): string | undefined;
  setModelName(surface: Surface, modelName: string | undefined): void;
  getThinkingLevel(surface: Surface): ThinkingLevel | undefined;
  setThinkingLevel(surface: Surface, thinkingLevel: ThinkingLevel | undefined): void;
  /**
   * Apply a model/thinking preference patch to a Surface in one atomic settings
   * write. A present key with an `undefined` value clears that override; an
   * omitted key leaves the existing value unchanged.
   */
  setPreferences(surface: Surface, patch: SurfacePreferencePatch): void;
  getSkillPolicy(surface: Surface): SkillPolicy;
}

/** Persistence callback kept private to lifecycle policy transitions. */
export type SkillPolicyWriter = (surface: Surface, policy: SkillPolicy) => void;

export interface SkillPolicyStatus {
  readonly environment: ExecutionEnvironment;
  readonly policy: SkillPolicy;
  readonly resolvedSkills: ResolvedSkillSet;
}

export type SkillRuntimeTransition = "invalidated" | "none";

type SurfaceRuntimeInvalidationTarget = {
  readonly conversationId: ConversationId | undefined;
  readonly hadRuntime: boolean;
};

export interface SkillPolicyTransition extends SkillPolicyStatus {
  readonly runtime: SkillRuntimeTransition;
  readonly cleanupError?: string;
}

const conversationCreationLeaseBrand: unique symbol = Symbol("conversation-creation-lease");

/**
 * Process-ephemeral participation in one still-pending Conversation creation.
 * Every successful `resolveOrStart` observer receives its own lease until an
 * accepted use seals the creation or every observer rejects. Leases are owned
 * by ConversationLifecycle and are never persisted.
 */
export interface ConversationCreationLease {
  readonly surfaceId: SurfaceId;
  readonly conversationId: ConversationId;
  readonly [conversationCreationLeaseBrand]: true;
}

type PendingConversationCreation = {
  readonly surfaceId: SurfaceId;
  readonly conversationId: ConversationId;
  readonly leases: Set<ConversationCreationLease>;
};

export type ConversationResolution = {
  readonly kind: "existing" | "created";
  readonly conversation: ConversationState;
  readonly creationLease: ConversationCreationLease | null;
};

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
  /**
   * Resolve the currently bound compatible Conversation after reconciling any
   * pending project assignment. Never creates Conversation history.
   */
  resolveCurrent(surface: Surface): Promise<ConversationState | null>;
  resolveOrStart(surface: Surface): Promise<ConversationResolution>;
  /** Seal a pending creation after this observer's use was accepted. */
  sealCreation(lease: ConversationCreationLease): void;
  rotate(surface: Surface): Promise<ConversationState>;
  resume(surface: Surface, target: ConversationId): Promise<ConversationState>;
  /** Archive the current bound Conversation and return a status transition. */
  archive(surface: Surface): Promise<ArchiveTransition>;
  /** Rename the current bound Conversation as one complete status/mutation operation. */
  setTitle(surface: Surface, title: string | undefined): Promise<NameTransition>;
  /** List resumable candidates split by compatibility with this Surface's current environment. */
  getResumeCandidates(surface: Surface): Promise<ResumeCandidates>;
  inspectSkillPolicy(surface: Surface): Promise<SkillPolicyStatus>;
  setSkillPolicy(surface: Surface, policy: SkillPolicy): Promise<SkillPolicyTransition>;
  setSkillSelection(surface: Surface, source: SkillSource, selection: SourceSelection): Promise<SkillPolicyTransition>;
  reloadSkills(surface: Surface): Promise<SkillPolicyTransition>;
  assignProject(surface: Surface, requestedRoot: string): Promise<ProjectAssignmentResult>;
  listResumable(surface: Surface): ConversationState[];
  /** Apply a validated model/thinking Surface preference patch, then invalidate the bound runtime. */
  setSurfacePreferences(surface: Surface, patch: SurfacePreferencePatch): Promise<PreferenceTransition>;
  /**
   * Release one rejected observer's lease. Rollback occurs only when every
   * lease rejected and the pending Conversation remains safely empty/current.
   * Returns false only when this lease was already settled or final rollback
   * was unsafe; a lease released after another observer sealed creation is a
   * successful settlement.
   */
  releaseCreation(lease: ConversationCreationLease): Promise<boolean>;
}

export type ProjectAssignmentResult =
  | { kind: "assigned"; conversation: ConversationState; projectRoot: string; previousConversationId?: string }
  | { kind: "already-assigned"; conversation?: ConversationState; projectRoot?: string }
  | { kind: "conflict"; currentRoot: string };

export type ArchiveTransition =
  | { kind: "no-session" }
  | { kind: "archived"; conversationId: ConversationId };

export type NameTransition =
  | { kind: "no-session" }
  | { kind: "missing-title" }
  | { kind: "named"; conversation: ConversationState };

export interface ResumeCandidates {
  compatible: ConversationState[];
  incompatible: ConversationState[];
}

export type PreferenceRuntimeTransition = "invalidated" | "none";

export interface PreferenceTransition {
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: ThinkingLevel | undefined;
  readonly previousModelName?: string | undefined;
  readonly previousThinkingLevel?: ThinkingLevel | undefined;
  readonly runtime: PreferenceRuntimeTransition;
  readonly cleanupError?: string;
}

function cloneBindings(bindings: BindingsFile): BindingsFile {
  return { version: 1, surfaces: { ...bindings.surfaces } } as BindingsFile;
}

/**
 * Reconcile pending project assignment during cold startup, before any
 * Telegram adapter, runtime host, or bot is constructed. No disposal is
 * needed because runtime identity does not exist yet.
 */
export function reconcileProjectAssignmentAtColdStart(
  home: string,
  store: ConversationStore = new ConversationStore(home),
  bindings: BindingStore = new FileBindingStore(home),
): void {
  const prepared = preparePendingProjectAssignment(home, store, bindings);
  if (prepared === null) return;
  applyPreparedProjectAssignment(home, bindings, prepared);
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
  private readonly runtimeHost: ConversationRuntimeHostPort;
  private readonly skillPolicyWriter: SkillPolicyWriter;
  /** Surfaces with a binding transition in flight. Fences new control work that
   * could otherwise capture a freshly bumped epoch before the binding commit.
   */
  private readonly pendingBindingSurfaces = new Set<SurfaceId>();
  /**
   * Process-ephemeral pending creation state. Lifecycle is the sole owner;
   * entries exist only from first creation until acceptance, conservative
   * sealing, or the final rejected lease settles.
   */
  private readonly pendingCreations = new Map<SurfaceId, PendingConversationCreation>();
  /** Weak membership makes issued leases nominal without retaining callers. */
  private readonly activeCreationLeases = new WeakSet<ConversationCreationLease>();

  constructor(
    home: string,
    store: ConversationStore,
    bindings: BindingStore,
    settings: SurfaceSettings,
    runtimeHost: ConversationRuntimeHostPort,
    skillPolicyWriter: SkillPolicyWriter = (surface, policy) => saveSkillPolicy(home, surface, policy),
  ) {
    this.home = home;
    this.store = store;
    this.bindings = bindings;
    this.settings = settings;
    this.runtimeHost = runtimeHost;
    this.skillPolicyWriter = skillPolicyWriter;
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

    // A non-intake observer can act on the returned Conversation without a
    // creation lease, so retaining it is the only conservative outcome.
    this.sealPendingCreation(key);
    return conv;
  }

  async resolveCurrent(surface: Surface): Promise<ConversationState | null> {
    return withLifecycleTransitionLock(async () => {
      await this.reconcilePendingAssignment();
      return this.inspect(surface);
    });
  }

  async resolveOrStart(surface: Surface): Promise<ConversationResolution> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];

      if (currentId) {
        let current: ConversationState | null = null;
        if (isValidConversationId(currentId)) {
          current = this.store.load(currentId as ConversationId);
        }
        if (current && environmentsEqual(current.executionEnvironment, env)) {
          const creationLease = this.issuePendingCreationLease(key, current.id);
          if (creationLease === null) this.sealPendingCreation(key);
          return { kind: "existing", conversation: current, creationLease };
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
      // Keep fallible reporting before lease issuance: once a lease is returned
      // there must be no later resolution step that can throw and strand it.
      log.info("conversation started", { surface: key, conversation: created.id, environment: env });
      // A successful replacement makes any older pending creation on this
      // Surface ineligible. Install one lifecycle-owned pending record for the
      // new Conversation and issue this observer's lease.
      this.sealPendingCreation(key);
      const pending: PendingConversationCreation = {
        surfaceId: key,
        conversationId: created.id,
        leases: new Set(),
      };
      this.pendingCreations.set(key, pending);
      const creationLease = this.createPendingCreationLease(pending);
      return { kind: "created", conversation: created, creationLease };
    });
  }

  sealCreation(lease: ConversationCreationLease): void {
    if (!this.activeCreationLeases.delete(lease)) return;
    this.sealPendingCreation(lease.surfaceId, lease.conversationId);
  }

  releaseCreation(lease: ConversationCreationLease): Promise<boolean> {
    // Consume synchronously so repeated settlement cannot race while waiting
    // for another lifecycle transition to release the process-wide lock.
    if (!this.activeCreationLeases.delete(lease)) return Promise.resolve(false);

    return withLifecycleTransitionLock(async () => {
      const key = lease.surfaceId;
      const conversationId = lease.conversationId;
      const pending = this.pendingCreations.get(key);
      // Another accepted use or lifecycle observer already sealed retention.
      // Releasing this still-active lease remains a successful settlement.
      if (pending === undefined || pending.conversationId !== conversationId || !pending.leases.has(lease)) {
        return true;
      }
      pending.leases.delete(lease);
      if (pending.leases.size > 0) return true;
      // The final rejection owns the one rollback attempt. Remove process state
      // before durable work so every success/failure path settles the map.
      this.pendingCreations.delete(key);

      const bindings = this.bindings.load();
      if (bindings.surfaces[key] !== conversationId) return false;
      // Only roll back an empty newly created Conversation. If it already
      // has transcript content, keep it as resumable rather than deleting.
      const conv = this.store.load(conversationId);
      if (conv === null) {
        // Binding points to missing Conversation; clear it anyway.
        const next = cloneBindings(bindings);
        delete (next.surfaces as Record<string, string>)[key];
        this.bindings.save(next);
        return true;
      }
      // Check if transcript is still empty (no user-visible content). A
      // newly created Conversation has an empty transcript file.
      try {
        const transcript = transcriptPath(this.home, conversationId);
        const content = readFileSync(transcript, "utf-8");
        if (content.trim().length !== 0) return false;
      } catch {
        // If we cannot read transcript, do not delete to avoid data loss.
        return false;
      }
      const next = cloneBindings(bindings);
      delete (next.surfaces as Record<string, string>)[key];
      this.bindings.save(next);
      try {
        this.store.deleteConversation(conversationId);
      } catch (cause) {
        log.error("rollback creation delete failed", { surface: key, conversationId, error: String(cause) });
        throw new Error(
          `failed to delete Conversation ${conversationId} after clearing Surface ${key} binding; residual Conversation state remains`,
          { cause },
        );
      }
      log.info("rolled back empty conversation after rejected admission", { surface: key, conversation: conversationId });
      return true;
    });
  }

  private issuePendingCreationLease(
    key: SurfaceId,
    conversationId: ConversationId,
  ): ConversationCreationLease | null {
    const pending = this.pendingCreations.get(key);
    if (pending === undefined || pending.conversationId !== conversationId) return null;
    return this.createPendingCreationLease(pending);
  }

  private createPendingCreationLease(
    pending: PendingConversationCreation,
  ): ConversationCreationLease {
    const lease: ConversationCreationLease = {
      surfaceId: pending.surfaceId,
      conversationId: pending.conversationId,
      [conversationCreationLeaseBrand]: true,
    };
    pending.leases.add(lease);
    this.activeCreationLeases.add(lease);
    return lease;
  }

  private sealPendingCreation(key: SurfaceId, conversationId?: ConversationId): void {
    const pending = this.pendingCreations.get(key);
    if (pending === undefined) return;
    if (conversationId !== undefined && pending.conversationId !== conversationId) return;
    pending.leases.clear();
    this.pendingCreations.delete(key);
  }

  async rotate(surface: Surface): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
      const env = this.settings.effectiveEnvironment(surface);
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];
      this.sealPendingCreation(key);
      this.pendingBindingSurfaces.add(key);
      try {
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

        // Validate reservation before committing the new binding. During the
        // await above, isCurrentBinding fences new control work that could
        // otherwise capture the freshly bumped epoch before the binding commit.
        const latest = this.bindings.load();
        if (latest.surfaces[key] !== currentId) {
          throw new Error(`binding changed during rotate for ${key}: expected ${currentId ?? "unbound"}, got ${latest.surfaces[key] ?? "unbound"}`);
        }
        if (!this.pendingBindingSurfaces.has(key)) {
          throw new Error(`binding reservation lost for ${key} during rotate`);
        }

        const created = this.store.create(env);
        const next = cloneBindings(latest);
        next.surfaces[key] = created.id;
        this.bindings.save(next);
        log.info("conversation rotated", { surface: key, conversation: created.id, environment: env });
        return created;
      } finally {
        this.pendingBindingSurfaces.delete(key);
      }
    });
  }

  async resume(surface: Surface, target: ConversationId): Promise<ConversationState> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
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
        this.sealPendingCreation(key, target);
        return targetConv;
      }

      const sourceKey = this.findBoundSurface(bindings, target);
      // If the target is already bound to the destination surface, this is a no-op.
      if (sourceKey === key) {
        this.sealPendingCreation(key, target);
        return targetConv;
      }

      // Moving either binding makes rollback unsafe for pending observers.
      this.sealPendingCreation(key);
      if (sourceKey !== undefined) this.sealPendingCreation(sourceKey, target);
      this.pendingBindingSurfaces.add(key);
      if (sourceKey !== undefined) this.pendingBindingSurfaces.add(sourceKey);
      try {
        // Dispose any runtime at the destination (about to be displaced) and at
        // the source (for a cross-surface move) before committing the binding
        // change. Disposal is best-effort idempotent; if it fails we abort.
        if (currentAtDst && isValidConversationId(currentAtDst)) {
          await this.runtimeHost.disposeRuntime(currentAtDst);
        }
        if (sourceKey !== undefined) {
          await this.runtimeHost.disposeRuntime(target);
        }

        const latest = this.bindings.load();
        if (latest.surfaces[key] !== currentAtDst) {
          throw new Error(`binding changed during resume for ${key}: expected ${currentAtDst ?? "unbound"}, got ${latest.surfaces[key] ?? "unbound"}`);
        }
        if (sourceKey !== undefined && latest.surfaces[sourceKey] !== target) {
          throw new Error(`binding changed during resume for source ${sourceKey}: expected ${target}, got ${latest.surfaces[sourceKey] ?? "unbound"}`);
        }
        if (!this.pendingBindingSurfaces.has(key) || (sourceKey !== undefined && !this.pendingBindingSurfaces.has(sourceKey))) {
          throw new Error(`binding reservation lost during resume for ${key}`);
        }

        const next = cloneBindings(latest);
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
      } finally {
        this.pendingBindingSurfaces.delete(key);
        if (sourceKey !== undefined) this.pendingBindingSurfaces.delete(sourceKey);
      }
    });
  }

  async archive(surface: Surface): Promise<ArchiveTransition> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
      const bindings = this.bindings.load();
      const currentId = bindings.surfaces[key];
      if (!currentId) {
        return { kind: "no-session" };
      }

      if (!isValidConversationId(currentId)) {
        throw new Error(`malformed conversation binding for surface ${key}: ${currentId}`);
      }

      const conversationId = currentId as ConversationId;
      const current = this.store.load(conversationId);
      if (!current) {
        // A stale binding points to nothing durable. If the session directory
        // is also gone, this is an already-archived stale id: fail loud without
        // mutating the binding map. If the directory still exists but the
        // canonical state is missing, the canonical authority is malformed.
        if (existsSync(sessionDir(this.home, conversationId))) {
          throw new Error(`conversation ${conversationId} directory exists but canonical state is missing`);
        }
        await this.runtimeHost.disposeRuntime(conversationId);
        throw new Error(`no active conversation on this surface`);
      }

      this.sealPendingCreation(key, current.id);
      this.pendingBindingSurfaces.add(key);
      try {
        await this.runtimeHost.disposeRuntime(current.id);
        const latest = this.bindings.load();
        if (latest.surfaces[key] !== currentId) {
          throw new Error(`binding changed during archive for ${key}: expected ${currentId}, got ${latest.surfaces[key] ?? "unbound"}`);
        }
        if (!this.pendingBindingSurfaces.has(key)) {
          throw new Error(`binding reservation lost for ${key} during archive`);
        }
        const next = cloneBindings(latest);
        delete (next.surfaces as Record<string, string>)[key];
        this.bindings.save(next);
        this.store.archive(current.id);
        log.info("conversation archived", { surface: key, conversation: current.id });
        return { kind: "archived", conversationId: current.id };
      } finally {
        this.pendingBindingSurfaces.delete(key);
      }
    });
  }

  async setTitle(surface: Surface, title: string | undefined): Promise<NameTransition> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
      const current = this.inspect(surface);
      if (!current) return { kind: "no-session" };
      if (title === undefined || title.trim() === "") return { kind: "missing-title" };

      this.store.setTitle(current.id, title);
      const conversation = { ...current, title };
      log.info("conversation titled", { surface: key, conversation: current.id, title });
      return { kind: "named", conversation };
    });
  }

  async getResumeCandidates(surface: Surface): Promise<ResumeCandidates> {
    return withLifecycleTransitionLock(async () => {
      await this.reconcilePendingAssignment();
      const env = this.settings.effectiveEnvironment(surface);
      const all = this.store.list();
      const compatible: ConversationState[] = [];
      const incompatible: ConversationState[] = [];
      for (const conversation of all) {
        if (environmentsEqual(conversation.executionEnvironment, env)) {
          compatible.push(conversation);
        } else {
          incompatible.push(conversation);
        }
      }
      return { compatible, incompatible };
    });
  }

  async setSurfacePreferences(surface: Surface, patch: SurfacePreferencePatch): Promise<PreferenceTransition> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();
      const previousModelName = this.settings.getModelName(surface);
      const previousThinkingLevel = this.settings.getThinkingLevel(surface);
      const invalidationTarget = this.acquireSurfaceRuntimeInvalidation(surface);

      // Binding/runtime authority must be readable before durable settings are
      // changed. Once the write commits, invalidation uses that held target and
      // cannot be skipped by a later Binding-store read failure.
      this.settings.setPreferences(surface, patch);
      const invalidation = await this.invalidateSurfaceRuntime(surface, invalidationTarget, "preferences");

      log.info("surface preferences changed", {
        surfaceId: key,
        conversationId: invalidationTarget.conversationId,
        modelName: patch.modelName,
        thinkingLevel: patch.thinkingLevel,
        previousModelName,
        previousThinkingLevel,
        runtime: invalidation.runtime,
        cleanupError: invalidation.cleanupError,
      });

      return {
        ...patch,
        previousModelName,
        previousThinkingLevel,
        runtime: invalidation.runtime,
        cleanupError: invalidation.cleanupError,
      };
    });
  }

  async inspectSkillPolicy(surface: Surface): Promise<SkillPolicyStatus> {
    // Inspection is deliberately non-creating. Pending project assignment
    // replay belongs to an authority-changing/runtime-acquisition path; a
    // status read must not turn an unbound Surface into a Conversation.
    return withLifecycleTransitionLock(() => this.resolveSkillPolicyStatus(surface));
  }

  async setSkillPolicy(surface: Surface, policy: SkillPolicy): Promise<SkillPolicyTransition> {
    return withLifecycleTransitionLock(async () => {
      await this.reconcilePendingAssignment();
      const candidate = cloneSkillPolicy(policy);
      return this.commitSkillPolicy(surface, candidate);
    });
  }

  async setSkillSelection(
    surface: Surface,
    source: SkillSource,
    selection: SourceSelection,
  ): Promise<SkillPolicyTransition> {
    return withLifecycleTransitionLock(async () => {
      await this.reconcilePendingAssignment();
      const current = cloneSkillPolicy(this.settings.getSkillPolicy(surface));
      current[source] = selection;
      const candidate = cloneSkillPolicy(current);
      return this.commitSkillPolicy(surface, candidate);
    });
  }

  private async commitSkillPolicy(surface: Surface, candidate: SkillPolicy): Promise<SkillPolicyTransition> {
    // Resolve before touching durable settings or the current runtime. A
    // missing selected skill or cross-source collision therefore leaves both
    // authorities unchanged.
    const status = await this.resolveSkillPolicyStatus(surface, candidate);
    const invalidationTarget = this.acquireSurfaceRuntimeInvalidation(surface);
    this.skillPolicyWriter(surface, candidate);
    const invalidation = await this.invalidateSurfaceRuntime(surface, invalidationTarget, "skill-policy");

    log.info("Surface skill policy changed", {
      surfaceId: surfaceId(surface),
      environment: status.environment,
      policy: status.policy,
      manifestFingerprint: status.resolvedSkills.fingerprint,
      runtime: invalidation.runtime,
      cleanupError: invalidation.cleanupError,
    });
    return { ...status, ...invalidation };
  }

  async reloadSkills(surface: Surface): Promise<SkillPolicyTransition> {
    return withLifecycleTransitionLock(async () => {
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();

      // Resolve first: reload is not allowed to destroy a usable runtime when
      // the newly edited catalog is invalid or no longer satisfies selection.
      const status = await this.resolveSkillPolicyStatus(surface);
      const invalidationTarget = this.acquireSurfaceRuntimeInvalidation(surface);
      const invalidation = await this.invalidateSurfaceRuntime(surface, invalidationTarget, "skill-reload");
      log.info("Surface skills reloaded", {
        surfaceId: key,
        environment: status.environment,
        policy: status.policy,
        manifestFingerprint: status.resolvedSkills.fingerprint,
        runtime: invalidation.runtime,
        cleanupError: invalidation.cleanupError,
      });
      return { ...status, ...invalidation };
    });
  }

  private async resolveSkillPolicyStatus(
    surface: Surface,
    candidate?: SkillPolicy,
  ): Promise<SkillPolicyStatus> {
    const environment = this.settings.effectiveEnvironment(surface);
    const policy = cloneSkillPolicy(candidate ?? this.settings.getSkillPolicy(surface));
    const resolvedSkills = await resolveSkillSet(environment, policy, this.home);
    log.debug("resolved Surface skill policy", {
      surfaceId: surfaceId(surface),
      environment,
      policy,
      skills: resolvedSkills.skills.map((skill) => ({
        source: skill.source,
        name: skill.name,
        filePath: skill.filePath,
      })),
      diagnostics: resolvedSkills.diagnostics.length,
      manifestFingerprint: resolvedSkills.fingerprint,
      policyFingerprint: skillPolicyFingerprint(policy),
    });
    return { environment, policy, resolvedSkills };
  }

  private acquireSurfaceRuntimeInvalidation(surface: Surface): SurfaceRuntimeInvalidationTarget {
    const key = surfaceId(surface);
    const rawConversationId = this.bindings.load().surfaces[key];
    if (!rawConversationId || !isValidConversationId(rawConversationId)) {
      return { conversationId: undefined, hadRuntime: false };
    }

    const conversationId = rawConversationId as ConversationId;
    this.sealPendingCreation(key, conversationId);
    return {
      conversationId,
      hadRuntime: this.runtimeHost.hasRuntime(conversationId),
    };
  }

  private async invalidateSurfaceRuntime(
    surface: Surface,
    target: SurfaceRuntimeInvalidationTarget,
    reason: "preferences" | "skill-policy" | "skill-reload",
  ): Promise<{
    runtime: SkillRuntimeTransition;
    cleanupError?: string;
  }> {
    const key = surfaceId(surface);
    const { conversationId, hadRuntime } = target;
    if (conversationId === undefined) {
      return { runtime: "none" };
    }

    try {
      // The runtime host removes runner identity synchronously before it
      // awaits disposal. Lifecycle commands remain serialized by current
      // binding authority rather than by this stale runner.
      await this.runtimeHost.disposeRuntime(conversationId, { preserveCommandQueue: true });
      return { runtime: hadRuntime ? "invalidated" : "none" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Surface runtime cleanup failed", {
        surfaceId: key,
        conversationId,
        reason,
        error: message,
      });
      return {
        runtime: hadRuntime ? "invalidated" : "none",
        cleanupError: message,
      };
    }
  }

  async assignProject(surface: Surface, requestedRoot: string): Promise<ProjectAssignmentResult> {
    return withLifecycleTransitionLock(async () => {
      assertCanonicalProjectRoot(requestedRoot, "requested projectRoot");
      const key = surfaceId(surface);
      await this.reconcilePendingAssignment();

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
          conversation: boundConv ?? undefined,
        };
      }

      // Already assigned to a different root: immutable.
      if (existingEnv.kind === "project") {
        return { kind: "conflict", currentRoot: projectRootOf(existingEnv) ?? requestedRoot };
      }

      // Personal/unassigned: persist a replayable intent, plan its exact
      // Conversation, quiesce the displaced runtime, then commit authority.
      // After intent persistence, the planned Conversation is the only write
      // before quiescence and is safe recovery state.
      const bindings = this.bindings.load();
      validateBindings(bindings);
      const previousConversationId = bindings.surfaces[key] as ConversationId | undefined;
      this.sealPendingCreation(key, previousConversationId);
      const plannedConversationId = this.store.allocateId();
      const intent: ProjectAssignmentIntent = {
        version: 1,
        surfaceId: key,
        previousSessionId: previousConversationId,
        plannedSessionId: plannedConversationId,
        projectRoot: requestedRoot,
      };
      savePendingProjectAssignment(this.home, intent);

      try {
        const prepared = preparePendingProjectAssignment(this.home, this.store, this.bindings);
        if (prepared === null) {
          throw new Error("pending project assignment disappeared during planning");
        }
        await this.quiescePreparedProjectAssignment(prepared);
        const conversation = applyPreparedProjectAssignment(this.home, this.bindings, prepared);
        return {
          kind: "assigned",
          conversation,
          projectRoot: requestedRoot,
          previousConversationId,
        };
      } catch (err) {
        log.error("project assignment failed after intent persistence", {
          surfaceId: key,
          plannedConversationId,
          projectRoot: requestedRoot,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  listResumable(surface: Surface): ConversationState[] {
    const env = this.settings.effectiveEnvironment(surface);
    return this.store.list(env);
  }

  async assertCurrentBinding(surface: Surface, conversationId: string): Promise<void> {
    await withLifecycleTransitionLock(async () => {
      await this.reconcilePendingAssignment();
      this.assertCurrentBindingLocked(surface, conversationId);
    });
  }

  isCurrentBinding(surface: Surface, conversationId: string): boolean {
    try {
      // A pending assignment is an unresolved authority transition. The
      // synchronous stale-runner guard must fail closed; only the async
      // acquisition path may reconcile it under the lifecycle lock.
      if (loadPendingProjectAssignment(this.home) !== null) return false;
      if (this.pendingBindingSurfaces.has(surfaceId(surface))) return false;
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
      await this.reconcilePendingAssignment();
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
      throw new BindingFencedError(
        key,
        conversationId as ConversationId,
        current?.id ?? null,
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
   * Plan the single pending assignment, quiesce its displaced runtime while
   * the old Binding is still authoritative, then commit settings and Binding.
   */
  private async reconcilePendingAssignment(): Promise<void> {
    const prepared = preparePendingProjectAssignment(this.home, this.store, this.bindings);
    if (prepared === null) return;
    // Planning succeeded and the durable transition can now dispose/move the
    // current Conversation. Seal only here: a failed planning read must not
    // fence existing intake leases.
    this.sealPendingCreation(prepared.intent.surfaceId, prepared.currentConversationId);
    await this.quiescePreparedProjectAssignment(prepared);
    applyPreparedProjectAssignment(this.home, this.bindings, prepared);
  }

  private async quiescePreparedProjectAssignment(prepared: PreparedProjectAssignment): Promise<void> {
    const displaced = prepared.currentConversationId;
    if (displaced === undefined || displaced === prepared.conversation.id) return;

    try {
      await this.runtimeHost.disposeRuntime(displaced);
    } catch (error) {
      log.error("project assignment runtime quiescence failed", {
        surfaceId: prepared.intent.surfaceId,
        displacedConversationId: displaced,
        plannedConversationId: prepared.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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

  getRuntimeSettings(surface: Surface): SurfaceRuntimeSettingsSnapshot {
    const stored = getSurfaceRuntimeSettings(this.home, surface);
    const executionEnvironment = environmentFromProjectRoot(stored.projectRoot);
    const identity = {
      executionEnvironment,
      modelName: stored.modelName ?? null,
      thinkingLevel: stored.thinkingLevel ?? null,
      skillPolicy: stored.skillPolicy,
    };
    return {
      executionEnvironment,
      modelName: stored.modelName,
      thinkingLevel: stored.thinkingLevel,
      skillPolicy: stored.skillPolicy,
      fingerprint: JSON.stringify(identity),
    };
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

  setPreferences(surface: Surface, patch: SurfacePreferencePatch): void {
    patchSurfaceSettings(this.home, surface, patch);
  }

  getSkillPolicy(surface: Surface): SkillPolicy {
    return getStoredSkillPolicy(this.home, surface);
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
  runtimeHost: ConversationRuntimeHostPort,
  settings?: SurfaceSettings,
  skillPolicyWriter?: SkillPolicyWriter,
): ConversationLifecycle {
  return new ConversationLifecycleManager(
    home,
    new ConversationStore(home),
    new FileBindingStore(home),
    settings ?? new FileSurfaceSettings(home),
    runtimeHost,
    skillPolicyWriter,
  );
}
