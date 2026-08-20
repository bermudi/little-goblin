import { log } from "../log.ts";

/** Structural settlement produced by the authority that attempted admission. */
export type AdmissionKind = "handoff" | "busy" | "fenced" | "rejected" | "completed";

/**
 * One authoritative structural decision plus its separately-lived completion.
 *
 * Runtime and delegated-work owners produce `handoff`, `busy`, `fenced`, or
 * `rejected`. Telegram adapters produce `completed` only when no runtime
 * operation was attempted. `closed` is deliberately absent: only UpdateGate
 * can classify its own closure.
 */
export interface AdmissionResult<T> {
  readonly kind: AdmissionKind;
  readonly completion: Promise<T>;
}

export type RuntimeAdmissionResult<T> = AdmissionResult<T> & {
  readonly kind: Exclude<AdmissionKind, "completed">;
};

export type AdapterAdmissionResult<T> = AdmissionResult<T> & {
  readonly kind: "completed";
};

declare const updateClaimBrand: unique symbol;
declare const transferredAdmissionBrand: unique symbol;

/** Opaque gate-private claim. It carries no caller-usable settlement method. */
export interface UpdateClaim<T> {
  readonly [updateClaimBrand]: T;
}

/** Opaque acknowledgement that a claim moved into the text coalescer. */
export interface TransferredAdmission<T> {
  readonly [transferredAdmissionBrand]: T;
}

function result<T, K extends AdmissionKind>(kind: K, completion: T | PromiseLike<T>): AdmissionResult<T> & { kind: K } {
  return { kind, completion: Promise.resolve(completion) };
}

/** Adapter-owned completion for work that attempted no runtime admission. */
export function completed<T>(completion: T | PromiseLike<T>): AdapterAdmissionResult<T> {
  return result("completed", completion);
}

/** Runtime-owner result constructors. Callers may map these results, not invent them. */
export const runtimeAdmission = {
  handoff<T>(completion: T | PromiseLike<T>): RuntimeAdmissionResult<T> {
    return result("handoff", completion);
  },
  busy<T>(completion: T | PromiseLike<T>): RuntimeAdmissionResult<T> {
    return result("busy", completion);
  },
  fenced<T>(completion: T | PromiseLike<T>): RuntimeAdmissionResult<T> {
    return result("fenced", completion);
  },
  rejected<T>(completion: T | PromiseLike<T>): RuntimeAdmissionResult<T> {
    return result("rejected", completion);
  },
} as const;

/** Callbacks the gate needs from the text coalescer. Wired after construction. */
export interface UpdateGateCoalescerCallbacks {
  /** Flush buffered text; UpdateGate drains the resulting update boundaries. */
  closeCoalescer: () => Promise<void>;
  /** Wait until buffered text has produced its structural admission decision. */
  awaitBufferedTextAdmission: () => Promise<void>;
}

type AuthorizationOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "authorized" }
  | { readonly kind: "admitted" }
  | { readonly kind: "closed" }
  | { readonly kind: "completed"; readonly decision: AdapterAdmissionResult<void> }
  | { readonly kind: "failed-before-decision"; readonly error: unknown };

interface AuthorizationState {
  outcome: AuthorizationOutcome;
  released: boolean;
  readonly promise: Promise<void>;
  release(): void;
}

type ClaimTerminal<T> =
  | { readonly kind: "closed" }
  | { readonly kind: "decision"; readonly decision: AdmissionResult<T> }
  | { readonly kind: "failed-before-decision"; readonly error: unknown };

interface ClaimState<T> {
  phase: "pending" | "transferred";
  terminal?: ClaimTerminal<T>;
  readonly terminalPromise: Promise<ClaimTerminal<T>>;
  resolveTerminal(terminal: ClaimTerminal<T>): void;
  finalize(): void;
}

/**
 * Process-lifetime owner of Telegram update admission and settlement.
 *
 * `runUpdate` owns every claim. Callers return an AdmissionResult and never
 * receive a release capability. The structural decision releases the runtime
 * admission drain; its completion remains tracked independently so delivery,
 * steering, and delegated work cannot block runtime disposal from starting.
 */
export class UpdateGate {
  private outerOpen = true;
  private innerOpen = true;
  private readonly inFlightUpdates = new Set<Promise<unknown>>();
  private readonly inFlightRuntimeAdmissions = new Set<Promise<void>>();
  private readonly inFlightAuthorizations = new Set<Promise<void>>();
  private readonly authorizations = new WeakMap<object, AuthorizationState>();
  private readonly claims = new WeakMap<object, ClaimState<unknown>>();
  private readonly transfers = new WeakMap<object, object>();
  private closure: Promise<void> | undefined;
  private draining = false;

  constructor(private readonly coalescerCallbacks: UpdateGateCoalescerCallbacks) {}

  /**
   * Execute the pre-allowlist boundary. An authorization already inside this
   * method is allowed to reach the inner gate after outer admission closes.
   */
  runAuthorization(ctx: object, next: () => Promise<void>): Promise<void> {
    if (!this.outerOpen) {
      log.info("Telegram update dropped after admission closed");
      const promise = Promise.resolve();
      this.authorizations.set(ctx, {
        outcome: { kind: "closed" },
        released: true,
        promise,
        release: () => {},
      });
      return promise;
    }
    if (this.authorizations.has(ctx)) {
      throw new Error("Telegram update authorization started more than once");
    }

    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    const state: AuthorizationState = {
      outcome: { kind: "pending" },
      released: false,
      promise,
      release: () => {
        if (state.released) return;
        state.released = true;
        resolve();
        this.inFlightAuthorizations.delete(promise);
      },
    };
    this.authorizations.set(ctx, state);
    this.inFlightAuthorizations.add(promise);

    let downstream: Promise<void>;
    try {
      downstream = next();
    } catch (error) {
      this.failAuthorization(state, error);
      throw error;
    }
    return downstream.then(
      () => this.finishAuthorization(state),
      (error: unknown) => {
        this.failAuthorization(state, error);
        throw error;
      },
    );
  }

  /** Commit a successful allowlist decision before routing the update. */
  commitAuthorization(ctx: object): void {
    const state = this.authorizations.get(ctx);
    if (state === undefined) throw new Error("Telegram authorization commit has no active update");
    if (state.outcome.kind !== "pending") {
      throw new Error(`Telegram authorization cannot commit after ${state.outcome.kind}`);
    }
    // Authorization transfers the update onward; it is not itself a structural
    // update decision.
    state.outcome = { kind: "authorized" };
  }

  private finishAuthorization(state: AuthorizationState): void {
    if (state.outcome.kind === "pending") {
      // A middleware return without authorization is an adapter-owned local
      // completion (deny/drop), not an absent structural outcome.
      state.outcome = { kind: "completed", decision: completed(undefined) };
    } else if (state.outcome.kind === "authorized") {
      const error = new Error(
        "authorized Telegram update completed without an admission boundary",
      );
      state.outcome = { kind: "failed-before-decision", error };
      state.release();
      throw error;
    }
    state.release();
  }

  private failAuthorization(state: AuthorizationState, error: unknown): void {
    if (state.outcome.kind === "pending" || state.outcome.kind === "authorized") {
      state.outcome = { kind: "failed-before-decision", error };
    }
    state.release();
  }

  /**
   * Execute one admitted Telegram boundary and consume exactly one structural
   * result. A pre-decision throw (including a missing/malformed result) is a
   * terminal failed-before-decision state: both safety nets are released and
   * the error propagates. Completion failures propagate without changing the
   * already-recorded decision.
   */
  runUpdate<T>(
    execute: (claim: UpdateClaim<T>) => AdmissionResult<T> | TransferredAdmission<T> |
      Promise<AdmissionResult<T> | TransferredAdmission<T>>,
  ): Promise<T | undefined>;
  runUpdate<T>(
    ctx: object,
    execute: (claim: UpdateClaim<T>) => AdmissionResult<T> | TransferredAdmission<T> |
      Promise<AdmissionResult<T> | TransferredAdmission<T>>,
  ): Promise<T | undefined>;
  runUpdate<T>(
    ctxOrExecute: object | ((claim: UpdateClaim<T>) => AdmissionResult<T> | TransferredAdmission<T> |
      Promise<AdmissionResult<T> | TransferredAdmission<T>>),
    maybeExecute?: (claim: UpdateClaim<T>) => AdmissionResult<T> | TransferredAdmission<T> |
      Promise<AdmissionResult<T> | TransferredAdmission<T>>,
  ): Promise<T | undefined> {
    const execute = typeof ctxOrExecute === "function" ? ctxOrExecute : maybeExecute;
    if (execute === undefined) throw new Error("Telegram update boundary is missing");
    if (typeof ctxOrExecute !== "function") this.acceptAuthorization(ctxOrExecute);
    const { claim, state } = this.createClaim<T>();
    const boundary = (async (): Promise<T | undefined> => {
      if (!this.innerOpen) {
        // `closed` is a gate-owned explicit terminal state.
        this.settleClaim(state, { kind: "closed" });
        return undefined;
      }

      let outcome: AdmissionResult<T> | TransferredAdmission<T>;
      let transferred = false;
      try {
        outcome = await execute(claim);
        if (this.transfers.get(outcome as object) === claim as object) {
          transferred = true;
        } else {
          if (state.phase === "transferred") {
            throw new Error("transferred Telegram claim also returned a structural decision");
          }
          this.assertAdmissionResult(outcome as AdmissionResult<T>);
        }
      } catch (error) {
        this.settleClaim(state, { kind: "failed-before-decision", error });
        throw error;
      }

      if (transferred) {
        const terminal = await state.terminalPromise;
        switch (terminal.kind) {
          case "closed": return undefined;
          case "failed-before-decision": throw terminal.error;
          case "decision": return await terminal.decision.completion;
        }
      }

      const admissionResult = outcome as AdmissionResult<T>;
      this.settleClaim(state, { kind: "decision", decision: admissionResult });
      return await admissionResult.completion;
    })();

    this.inFlightUpdates.add(boundary);
    const finish = (): void => { this.inFlightUpdates.delete(boundary); };
    void boundary.then(finish, finish);
    return boundary;
  }

  /**
   * Start a gate-owned update boundary without making a sequential transport
   * wait for its completion. Telegram long polling handles updates one at a
   * time, so text fragments must release the middleware chain to let the next
   * adjacent fragment reach the coalescer. The ordinary runUpdate boundary
   * remains in `inFlightUpdates` through decision and completion.
   */
  runCoalescedUpdate<T>(
    ctx: object,
    execute: (claim: UpdateClaim<T>) => AdmissionResult<T> | TransferredAdmission<T> |
      Promise<AdmissionResult<T>>,
  ): Promise<T | undefined> {
    let transferred = false;
    const boundary = this.runUpdate<T>(ctx, (claim) => {
      const outcome = execute(claim);
      if (!(outcome instanceof Promise)) {
        transferred = this.transfers.get(outcome as object) === claim as object;
      }
      return outcome;
    });
    if (!transferred) return boundary;
    void boundary.catch((error: unknown) => {
      log.error("detached Telegram update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return Promise.resolve(undefined);
  }

  private acceptAuthorization(ctx: object): void {
    const state = this.authorizations.get(ctx);
    if (state === undefined) throw new Error("Telegram update has no authorization state");
    if (state.outcome.kind !== "authorized") {
      throw new Error(`Telegram update cannot enter admission after ${state.outcome.kind}`);
    }
    state.outcome = { kind: "admitted" };
    state.release();
  }

  /** Move an opaque claim into the coalescer without deciding it. */
  transferUpdate<T>(claim: UpdateClaim<T>): TransferredAdmission<T> {
    const state = this.stateFor(claim);
    if (state.terminal !== undefined) throw new Error("cannot transfer a terminal Telegram claim");
    if (state.phase === "transferred") throw new Error("Telegram claim transferred more than once");
    state.phase = "transferred";
    const transfer = {} as TransferredAdmission<T>;
    this.transfers.set(transfer as object, claim as object);
    return transfer;
  }

  /** Atomically settle every transferred fragment with one merged decision. */
  settleTransferred<T>(claims: readonly UpdateClaim<T>[], admissionResult: AdmissionResult<T>): void {
    this.assertAdmissionResult(admissionResult);
    const states = claims.map((claim) => this.stateFor(claim));
    for (const state of states) {
      if (state.phase !== "transferred") throw new Error("cannot settle an untransferred Telegram claim");
      if (
        state.terminal !== undefined &&
        !(state.terminal.kind === "decision" && state.terminal.decision === admissionResult)
      ) {
        throw new Error("Telegram claim received contradictory decisions");
      }
    }
    for (const state of states) {
      this.settleClaim(state, { kind: "decision", decision: admissionResult });
    }
  }

  /** Terminal failed-before-decision settlement for a transferred group. */
  failTransferred<T>(claims: readonly UpdateClaim<T>[], error: unknown): void {
    const states = claims.map((claim) => this.stateFor(claim));
    for (const state of states) {
      if (state.phase !== "transferred") throw new Error("cannot fail an untransferred Telegram claim");
      if (
        state.terminal !== undefined &&
        !(state.terminal.kind === "failed-before-decision" && state.terminal.error === error)
      ) {
        throw new Error("Telegram claim failed after a structural decision");
      }
    }
    for (const state of states) {
      this.settleClaim(state, { kind: "failed-before-decision", error });
    }
  }

  /** Fail only claims that have not already reached a terminal state. */
  failUndecidedTransferred<T>(claims: readonly UpdateClaim<T>[], error: unknown): void {
    const states = claims.map((claim) => this.stateFor(claim));
    for (const state of states) {
      if (state.phase !== "transferred") throw new Error("cannot fail an untransferred Telegram claim");
    }
    for (const state of states) {
      if (state.terminal === undefined) {
        this.settleClaim(state, { kind: "failed-before-decision", error });
      }
    }
  }

  private createClaim<T>(): { claim: UpdateClaim<T>; state: ClaimState<T> } {
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
    let resolveTerminal!: (terminal: ClaimTerminal<T>) => void;
    const terminalPromise = new Promise<ClaimTerminal<T>>((resolve) => {
      resolveTerminal = resolve;
    });
    this.inFlightRuntimeAdmissions.add(admission);
    const state: ClaimState<T> = {
      phase: "pending",
      terminalPromise,
      resolveTerminal,
      finalize: () => {
        resolveAdmission();
        this.inFlightRuntimeAdmissions.delete(admission);
      },
    };
    const claim = {} as UpdateClaim<T>;
    this.claims.set(claim as object, state as ClaimState<unknown>);
    return { claim, state };
  }

  private stateFor<T>(claim: UpdateClaim<T>): ClaimState<T> {
    const state = this.claims.get(claim as object);
    if (state === undefined) throw new Error("unknown Telegram update claim");
    return state as ClaimState<T>;
  }

  private settleClaim<T>(state: ClaimState<T>, terminal: ClaimTerminal<T>): void {
    if (state.terminal !== undefined) {
      const repeated =
        (state.terminal.kind === "closed" && terminal.kind === "closed") ||
        (state.terminal.kind === "decision" && terminal.kind === "decision" &&
          state.terminal.decision === terminal.decision) ||
        (state.terminal.kind === "failed-before-decision" &&
          terminal.kind === "failed-before-decision" && state.terminal.error === terminal.error);
      if (repeated) return;
      throw new Error(
        `Telegram claim terminal transition contradicts ${state.terminal.kind}`,
      );
    }
    state.terminal = terminal;
    state.finalize();
    state.resolveTerminal(terminal);
  }

  private assertAdmissionResult<T>(value: AdmissionResult<T>): void {
    if (typeof value !== "object" || value === null) {
      throw new Error("Telegram update completed without an admission decision");
    }
    const candidate = value as { kind?: unknown; completion?: unknown };
    if (
      candidate.kind !== "handoff" &&
      candidate.kind !== "busy" &&
      candidate.kind !== "fenced" &&
      candidate.kind !== "rejected" &&
      candidate.kind !== "completed"
    ) {
      throw new Error(`Telegram update returned an invalid admission decision: ${String(candidate.kind)}`);
    }
    if (!(candidate.completion instanceof Promise)) {
      throw new Error("Telegram admission decision has no completion promise");
    }
  }

  closeAdmission(): Promise<void> {
    if (this.closure) return this.closure;
    this.outerOpen = false;
    this.closure = this.closeOnce();
    return this.closure;
  }

  private async closeOnce(): Promise<void> {
    try {
      await this.drainAuthorizations();
      await this.coalescerCallbacks.closeCoalescer();
    } finally {
      this.innerOpen = false;
      await this.drainAdmitted();
    }
  }

  async bufferedTextAdmission(): Promise<void> {
    await this.drainAuthorizations();
    await this.coalescerCallbacks.awaitBufferedTextAdmission();
  }

  async runtimeAdmission(): Promise<void> {
    while (this.inFlightRuntimeAdmissions.size > 0) {
      await Promise.allSettled([...this.inFlightRuntimeAdmissions]);
    }
  }

  private async drainAuthorizations(): Promise<void> {
    while (this.inFlightAuthorizations.size > 0) {
      await Promise.allSettled([...this.inFlightAuthorizations]);
    }
  }

  private async drainAdmitted(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inFlightUpdates.size > 0) {
        await Promise.allSettled([...this.inFlightUpdates]);
      }
    } finally {
      this.draining = false;
    }
  }
}
