import type { AgentRunner } from "../agent/mod.ts";
import type { ExternalAgentRunner } from "../external-agents/mod.ts";
import type { ConversationId } from "../sessions/types.ts";
import type { SurfaceId } from "../surface.ts";
export type {
  AttachmentSignal,
  AttachedWork,
  CurrentBindingGuard,
  SurfaceRuntimeAuthority,
} from "./surface-runtime-authority.ts";
import { DelegatedWorkHost, type ConversationRuntimeId } from "../delegated-work/mod.ts";
import { log } from "../log.ts";
import {
  RuntimeMachine,
  type ImmediateRuntimeWorkContext,
  type ImmediateWorkAdmission,
  type ImmediateWorkExecutionResult,
  type ImmediateWorkSettlement,
  type InvalidationReason,
  type RuntimeCreation,
  type RuntimeSkillContext,
  type SurfaceRuntimeRegistration,
  type SteerOrQueueResult,
  type TicketAxis,
  type WorkAuthority,
  type WorkIntent,
} from "./runtime-machine.ts";

export type { SteerOrQueueResult };

// Re-export types that callers import from this module.
export type {
  ImmediateRuntimeWorkContext,
  ImmediateWorkAdmission,
  ImmediateWorkExecutionResult,
  ImmediateWorkSettlement,
  RuntimeCreation,
  RuntimeSkillContext,
  SurfaceRuntimeRegistration,
  TicketAxis,
  WorkAuthority,
  WorkIntent,
};

/**
 * Preserve lifecycle-command serialization while invalidating model work.
 * Commands use Binding authority rather than a disposed runner's identity.
 */
export interface RuntimeDisposalOptions {
  readonly preserveCommandQueue?: boolean;
  /** Keep this candidate reservation alive while replacing an old runtime. */
  readonly preserveInFlight?: Promise<AgentRunner>;
}

/** Narrow lifecycle-facing port used by ConversationLifecycle. */
export interface ConversationRuntimeHostPort {
  /** Optionally ignore the caller's own in-flight creation reservation. */
  hasRuntime(conversationId: ConversationId, excludeCreation?: Promise<AgentRunner>): boolean;
  disposeRuntime(conversationId: ConversationId, options?: RuntimeDisposalOptions): Promise<void>;
}

function flattenFailures(error: unknown, failures: unknown[]): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) flattenFailures(nested, failures);
    return;
  }
  failures.push(error);
}

/**
 * Concrete owner of ephemeral ConversationRuntime state.
 *
 * The host is a thin coordinator over per-conversation {@link RuntimeMachine}
 * instances. It owns the process-level admission gate and shutdown promise,
 * and delegates all per-conversation state (runner, creation, queue, work
 * authority, drain set, generations) to the machine. Queue methods accept
 * only closed work intents; executable authority policy remains inside the
 * machine.
 *
 * It does not construct runners or resolve Binding authority; those policies
 * belong to TurnDispatcher and ConversationLifecycle.
 */
export class ConversationRuntimeHost implements ConversationRuntimeHostPort {
  private readonly machines = new Map<ConversationId, RuntimeMachine>();
  /**
   * The single DelegatedWorkHost for this kernel, exposed so every orchestration
   * component derives delegated-work access from one owner instead of carrying
   * its own possibly-divergent instance (decision: shared delegated host).
   */
  readonly delegatedWorkHost: DelegatedWorkHost;
  private readonly externalAgentRunner: ExternalAgentRunner | undefined;
  private admissionOpen = true;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: {
    delegatedWorkHost: DelegatedWorkHost;
    externalAgentRunner?: ExternalAgentRunner;
  }) {
    this.delegatedWorkHost = options.delegatedWorkHost;
    this.externalAgentRunner = options.externalAgentRunner;
  }

  private machineFor(conversationId: ConversationId): RuntimeMachine {
    let machine = this.machines.get(conversationId);
    if (machine === undefined) {
      machine = new RuntimeMachine({
        conversationId,
        delegatedWorkHost: this.delegatedWorkHost,
        externalAgentRunner: this.externalAgentRunner,
        isAdmissionOpen: () => this.admissionOpen,
      });
      this.machines.set(conversationId, machine);
    }
    return machine;
  }

  getRunner(conversationId: ConversationId): AgentRunner | null {
    return this.machines.get(conversationId)?.getRunner() ?? null;
  }

  hasRunner(conversationId: ConversationId): boolean {
    return this.machines.get(conversationId)?.hasRunner() ?? false;
  }

  hasRuntime(conversationId: ConversationId, excludeCreation?: Promise<AgentRunner>): boolean {
    return this.machines.get(conversationId)?.hasRuntime(excludeCreation) ?? false;
  }

  isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  /** Stop new runtime creation and not-yet-started queued work. Idempotent and synchronous. */
  closeAdmission(): void {
    if (this.admissionOpen) {
      this.admissionOpen = false;
      log.info("conversation runtime admission closed");
    }
  }

  assertAdmissionOpen(): void {
    if (!this.admissionOpen) {
      throw new Error("conversation runtime admission is closed");
    }
  }

  isRegisteredRunner(conversationId: ConversationId, runner: AgentRunner): boolean {
    return this.machines.get(conversationId)?.isRegisteredRunner(runner) ?? false;
  }

  isInternalRuntime(conversationId: ConversationId): boolean {
    return this.machines.get(conversationId)?.isInternalRuntime() ?? false;
  }

  surfaceIdFor(conversationId: ConversationId): SurfaceId | undefined {
    return this.machines.get(conversationId)?.surfaceIdFor();
  }

  runtimeIdFor(conversationId: ConversationId): ConversationRuntimeId | undefined {
    return this.machines.get(conversationId)?.runtimeIdFor();
  }

  skillContextFor(conversationId: ConversationId): RuntimeSkillContext | undefined {
    return this.machines.get(conversationId)?.skillContextFor();
  }

  creationFor(conversationId: ConversationId): RuntimeCreation | undefined {
    return this.machines.get(conversationId)?.getCreation();
  }

  reserveCreation(
    conversationId: ConversationId,
    surfaceId: SurfaceId,
    settingsFingerprint: string,
  ): RuntimeCreation {
    this.assertAdmissionOpen();
    return this.machineFor(conversationId).reserveCreation(surfaceId, settingsFingerprint);
  }

  isCurrentCreation(conversationId: ConversationId, promise: Promise<AgentRunner>): boolean {
    return this.machines.get(conversationId)?.isCurrentCreation(promise) ?? false;
  }

  /**
   * Raw epoch access for non-queue creation and attachment authority.
   * Queue callers declare a WorkIntent instead.
   */
  captureEpoch(conversationId: ConversationId, axis: TicketAxis): number {
    return this.machines.get(conversationId)?.captureEpoch(axis) ?? 0;
  }

  /** Compare raw non-queue creation/attachment authority. */
  isEpochCurrent(conversationId: ConversationId, axis: TicketAxis, epoch: number): boolean {
    return this.machines.get(conversationId)?.isEpochCurrent(axis, epoch) ?? false;
  }

  finishCreation(
    conversationId: ConversationId,
    promise: Promise<AgentRunner>,
    creation: RuntimeCreation,
  ): void {
    this.machines.get(conversationId)?.finishCreation(promise, creation);
  }

  registerSurfaceRuntime(
    conversationId: ConversationId,
    runner: AgentRunner,
    registration: SurfaceRuntimeRegistration,
  ): void {
    this.assertAdmissionOpen();
    this.machineFor(conversationId).registerSurfaceRuntime(runner, registration);
  }

  registerInternalRuntime(conversationId: ConversationId, runner: AgentRunner): void {
    this.assertAdmissionOpen();
    this.machineFor(conversationId).registerInternalRuntime(runner);
  }

  async awaitSettled(conversationId: ConversationId): Promise<void> {
    await this.machines.get(conversationId)?.awaitSettled();
  }

  schedule(
    conversationId: ConversationId,
    intent: WorkIntent,
    run: (authority: WorkAuthority) => Promise<void>,
    onError: (err: unknown) => Promise<void> | void,
    options: {
      isPrompt?: boolean;
      onStart?: () => void;
      onFenced?: () => void;
      onSettled?: () => void;
    } = {},
  ): boolean {
    if (!this.admissionOpen) {
      log.info("runtime work rejected after admission closed", { conversationId });
      return false;
    }
    return this.machineFor(conversationId).schedule(intent, run, onError, options);
  }

  admitImmediateRuntimeWork(
    conversationId: ConversationId,
    run: (context: ImmediateRuntimeWorkContext) => Promise<ImmediateWorkExecutionResult>,
  ): ImmediateWorkAdmission {
    if (!this.admissionOpen) return { kind: "closed" };
    return this.machineFor(conversationId).admitImmediateRuntimeWork(run);
  }

  /**
   * Steer-vs-queue in one synchronous machine section. See
   * {@link RuntimeMachine.steerOrQueue}.
   */
  steerOrQueue(
    conversationId: ConversationId,
    attach: () => Promise<void>,
    fallback: {
      intent: WorkIntent;
      run: (authority: WorkAuthority) => Promise<void>;
      onError: (err: unknown) => Promise<void> | void;
    },
  ): SteerOrQueueResult {
    return this.machineFor(conversationId).steerOrQueue(attach, fallback);
  }

  isCommandPending(conversationId: ConversationId): boolean {
    return this.machines.get(conversationId)?.isCommandPending() ?? false;
  }

  isPromptPending(conversationId: ConversationId): boolean {
    return this.machines.get(conversationId)?.isPromptPending() ?? false;
  }

  hasPromptWork(conversationId: ConversationId): boolean {
    return this.machines.get(conversationId)?.hasPromptWork() ?? false;
  }

  async cancelPending(conversationId: ConversationId): Promise<boolean> {
    return this.machines.get(conversationId)?.cancelPending() ?? false;
  }

  /**
   * Invalidate synchronously, then await runner and external-work cleanup.
   *
   * Maps the legacy `RuntimeDisposalOptions` to the machine's invalidation
   * reason enum:
   * - `preserveCommandQueue` or `preserveInFlight` → `settings-change`
   * - neither → `binding-change`
   *
   * Deduplication is generation-aware: a second call for the same generation
   * shares the in-flight disposal promise, but a call made after a newer
   * generation registered starts a fresh disposal.
   */
  disposeRuntime(
    conversationId: ConversationId,
    disposalOptions?: RuntimeDisposalOptions,
  ): Promise<void> {
    const machine = this.machineFor(conversationId);
    const preserveCommandQueue = disposalOptions?.preserveCommandQueue === true;
    const preserveInFlight = disposalOptions?.preserveInFlight;
    const isSettingsChange = preserveCommandQueue || preserveInFlight !== undefined;
    const reason: InvalidationReason = isSettingsChange ? "settings-change" : "binding-change";
    return machine.invalidate(reason, preserveInFlight);
  }

  disposeAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closeAdmission();

    // Fence every machine immediately. Shutdown must be able to abort a model
    // turn that would otherwise keep its admitted Telegram handler alive
    // indefinitely. Queue entries that have not started fail the admission
    // fence and do not begin during shutdown.
    const machineShutdowns = [...this.machines.values()].map((machine) => machine.shutdown());

    this.shutdownPromise = this.disposeAllOnce(machineShutdowns);
    return this.shutdownPromise;
  }

  private async disposeAllOnce(
    machineShutdowns: readonly Promise<void>[],
  ): Promise<void> {
    const failures: unknown[] = [];
    const results = await Promise.allSettled(machineShutdowns);
    for (const result of results) {
      if (result.status === "rejected") flattenFailures(result.reason, failures);
    }
    if (failures.length === 1) {
      throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Conversation runtime shutdown failed");
    }
  }
}
