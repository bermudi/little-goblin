import { boundedError, log } from "../log.ts";
import { AgentRunner, appendAssistantTranscriptEntry, ModelNotCapableError } from "../agent/mod.ts";
import type { Config } from "../config.ts";
import type { PendingCompletionClaim } from "../delegated-work/mod.ts";
import type { MemoryStore } from "../memory/mod.ts";
import type { ConversationState } from "../sessions/mod.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { surfaceId, type Surface, type GuestSurface } from "../surface.ts";
import type { TurnDispatcher, PromptContent } from "../orchestration/dispatcher.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import { completed, type AdmissionResult } from "../shutdown/mod.ts";
import { sendSystemReply } from "./format.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import { attemptCreationAdmission, withRejectedCreationRelease } from "./intake-admission.ts";

/**
 * The explicit dependency bag the leaf intake handlers receive instead of
 * closing over `createTelegramIntake` locals.
 */
export interface IntakeDeps {
  cfg: Config;
  dispatcher: TurnDispatcher;
  lifecycle: ConversationLifecycle;
  pendingClaim: PendingCompletionClaim;
  memoryStore: MemoryStore;
}

export type ActiveTurn = {
  surface: Surface;
  session: ConversationState;
  environment: ExecutionEnvironment;
  schedule: (
    run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
    failureLog: string,
    opts?: { replyModelNotCapable?: boolean },
  ) => Promise<AdmissionResult<void>>;
};

export const WEDGED_RUNNER_REPLY =
  "The current turn is still running after a failed cancel. It recovers automatically once it finishes; use /new or /archive to recover now.";

/**
 * Claim retained durable completions on an authorized ordinary interaction.
 * Fire-and-forget with observed failures: the claim must never block or
 * fail the user's own turn; a failed claim stays pending for the next one.
 */
export function claimPendingCompletions(pendingClaim: PendingCompletionClaim, surface: Surface): void {
  void pendingClaim.claimForInteraction(surface).catch((err: unknown) => {
    log.error("pending completion claim failed", {
      surfaceId: surfaceId(surface),
      ...boundedError(err),
    });
  });
}

/**
 * Claim retained durable completions on an authorized guest summon from
 * this guest Surface. Same fire-and-forget failure posture.
 */
export function claimPendingGuestCompletions(pendingClaim: PendingCompletionClaim, surface: GuestSurface): void {
  void pendingClaim.claimForGuestSummon(surface).catch((err: unknown) => {
    log.error("pending guest summon claim failed", {
      surfaceId: surfaceId(surface),
      ...boundedError(err),
    });
  });
}

export function recordAssistantReply(
  cfg: Config,
  sessionId: string,
  surface: Surface,
  runner: AgentRunner | null | undefined,
  text: string,
): void {
  const ctx = runner && runner.memoryContext.kind === "surface"
    ? { kind: "surface" as const, sourceSurfaceId: runner.memoryContext.authority.sourceSurfaceId }
    : undefined;
  if (!ctx) {
    log.warn("no-transcript-writer-context", {
      sessionId,
      surfaceId: surfaceId(surface),
      surfaceKind: surface.kind,
      runnerPresent: !!runner,
      runnerKind: runner?.memoryContext.kind ?? null,
    });
    return;
  }
  appendAssistantTranscriptEntry(sessionId, cfg.goblinHome, text, ctx);
}

/**
 * A wedge only blocks intake while the runtime is observably busy. If
 * the abort timed out but the backend has since settled, the wedge is
 * a stale false positive — clear it and treat the runner as healthy,
 * so the surface recovers on the next message instead of staying
 * locked until /new or /archive.
 */
export function runnerWedged(runner: AgentRunner): boolean {
  return runner.isAbortTimedOut && !runner.tryClearAbortTimeout();
}

export async function resolveActiveTurn(
  deps: IntakeDeps,
  message: TelegramIntakeMessage,
  kind: string,
): Promise<ActiveTurn | null> {
  const { dispatcher, lifecycle, pendingClaim } = deps;
  const surface = message.surface;
  if (!surface) {
    log.debug(`dropping ${kind}: no surface`);
    return null;
  }

  // Photos, documents, voice, and audio are ordinary authorized content:
  // lazily create a conversation on the surface, just like text. Lifecycle
  // supplies the only lease capable of participating in creation settlement.
  const resolution = await lifecycle.resolveOrStart(surface);
  const conversation = resolution.conversation;
  const creationLease = resolution.creationLease;
  const session = conversation;
  claimPendingCompletions(pendingClaim, surface);

  return {
    surface,
    session,
    environment: conversation.executionEnvironment,
    schedule: async (run, failureLog, opts) => {
      let admittedRunner: AgentRunner | undefined;
      const execute = async (runner: AgentRunner, authority: WorkAuthority): Promise<void> => {
        admittedRunner = runner;
        if (runnerWedged(runner)) {
          if (!authority.isCurrent()) return;
          await sendSystemReply(message, WEDGED_RUNNER_REPLY, "error");
          return;
        }
        await run(runner, authority);
      };
      const onError = async (err: unknown): Promise<void> => {
        if (opts?.replyModelNotCapable && err instanceof ModelNotCapableError) {
          await sendSystemReply(message, err.message, "error");
          if (admittedRunner !== undefined) {
            recordAssistantReply(deps.cfg, session.id, surface, admittedRunner, err.message);
          }
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        log.error(failureLog, { error: msg, sessionId: session.id });
      };

      // A wedged runner is an adapter-local completion: no runtime work
      // is attempted. Check synchronously via the registered runner to
      // avoid awaiting runner acquisition.
      const existingRunner = dispatcher.getRunner(session.id);
      if (existingRunner !== null && runnerWedged(existingRunner)) {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
        return completed(sendSystemReply(message, WEDGED_RUNNER_REPLY, "error"));
      }
      // admitPromptTurn enqueues the work synchronously and acquires
      // the runner inside the queued work when no runner is registered
      // yet, so a stalled creation is cancelled by shutdown disposal
      // rather than deadlocking the runtime-admission drain.
      const admission = await attemptCreationAdmission(
        () => dispatcher.admitPromptTurn(
          session,
          surface,
          execute,
          onError,
        ),
        creationLease,
        lifecycle,
        kind,
      );
      if (admission.kind !== "rejected") {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
        return admission;
      }
      return withRejectedCreationRelease(admission, creationLease, lifecycle, kind);
    },
  };
}

export async function runPrompt(deps: IntakeDeps, message: TelegramIntakeMessage, surface: Surface, runner: AgentRunner, session: ConversationState, content: PromptContent): Promise<void> {
  const buffer = deps.dispatcher.createMessageBuffer(surface, session);
  await runner.prompt(message.prepare(content), buffer);
}
