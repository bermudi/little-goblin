import { log } from "../log.ts";

/**
 * Handle for one admitted Telegram update.
 *
 * Replaces the threaded `onRuntimeAdmission: () => void` callback that was
 * passed through coalescer → intake → steer paths. The handle guarantees
 * exactly-once release: {@link UpdateHandle.releaseRuntimeAdmission} is
 * idempotent, so the coalescer's settle path and intake's runtime hand-off
 * can both call it without double-release.
 *
 * The narrow public surface (`releaseRuntimeAdmission` only) is what intake,
 * coalescer, and commands receive. The gate's internal handle adds
 * authorization release and coalescer-handoff marking, which only the outer
 * middleware and the text handler use.
 */
export interface UpdateHandle {
  /** Release the runtime-admission barrier. Idempotent. */
  releaseRuntimeAdmission(): void;
}

/**
 * Full handle returned by the gate's {@link UpdateGate.beginUpdate}. The
 * outer middleware and the text handler use the extra methods; intake and
 * coalescer see only {@link UpdateHandle}.
 */
export interface AdmissionHandle extends UpdateHandle {
  /** Release the authorization barrier. Idempotent. */
  releaseAuthorization(): void;
  /** Mark this update as handed to the text coalescer. The gate's settle
   * safety net will not release runtime admission for a coalesced update —
   * the coalescer owns that release. */
  markHandedToCoalescer(): void;
}

/** Callbacks the gate needs from the text coalescer. Wired after the
 * coalescer is constructed, breaking the gate ↔ intake ↔ coalescer cycle. */
export interface UpdateGateCoalescerCallbacks {
  /** Flush buffered text and drain coalescer dispatches. */
  closeCoalescer: () => Promise<void>;
  /** Wait until buffered text has reached its runtime admission call. */
  awaitBufferedTextAdmission: () => Promise<void>;
}

interface AdmissionState {
  released: boolean;
  handedToCoalescer: boolean;
  authorizationReleased: boolean;
  readonly runtimePromise: Promise<void>;
  readonly authorizationPromise: Promise<void>;
  releaseRuntime: () => void;
  releaseAuth: () => void;
}

/**
 * One process-level admission gate for Telegram updates.
 *
 * Absorbs the three in-flight Sets, the per-update WeakMap, the three drain
 * functions, and the coalescer close coupling that previously lived in
 * `bot.ts`, plus intake's `admit(kind)` / `closeAdmission()`. Handlers
 * receive an {@link AdmissionHandle} instead of a threaded
 * `onRuntimeAdmission` callback and release exactly once.
 *
 * The gate has two admission levels:
 * - **Outer** ({@link isOuterOpen}): the middleware gate. Closes
 *   synchronously when {@link closeAdmission} is called, rejecting new
 *   updates immediately.
 * - **Inner** ({@link admit}): the intake gate. Closes after the coalescer
 *   flush, so buffered text that was already admitted can still enter
 *   intake.
 */
export class UpdateGate {
  private outerOpen = true;
  private innerOpen = true;
  private readonly inFlightUpdates = new Set<Promise<unknown>>();
  private readonly inFlightRuntimeAdmissions = new Set<Promise<void>>();
  private readonly inFlightAuthorizations = new Set<Promise<void>>();
  private readonly states = new WeakMap<object, AdmissionState>();
  private closure: Promise<void> | undefined;
  private draining = false;

  private readonly coalescerCallbacks: UpdateGateCoalescerCallbacks;

  constructor(coalescerCallbacks: UpdateGateCoalescerCallbacks) {
    this.coalescerCallbacks = coalescerCallbacks;
  }

  // ─── outer gate ─────────────────────────────────────────────────────

  /** Is the middleware still accepting Telegram updates? */
  isOuterOpen(): boolean {
    return this.outerOpen;
  }

  // ─── inner gate (intake admission) ──────────────────────────────────

  /** May intake still admit new work? Logged drops use `kind` for context. */
  admit(kind: string): boolean {
    if (this.innerOpen) return true;
    log.info("telegram intake dropped after admission closed", { kind });
    return false;
  }

  // ─── per-update tracking ────────────────────────────────────────────

  /**
   * Begin tracking an admitted update. Returns a handle the handler uses to
   * release barriers exactly once. The handle is also stored for ctx-keyed
   * lookup via {@link handleFor}.
   */
  beginUpdate(ctx: object): AdmissionHandle {
    const state = this.createState();
    this.states.set(ctx, state);
    return this.handleFromState(state);
  }

  /**
   * Look up the handle for a ctx. Returns `undefined` after the state has
   * been cleaned up (e.g. the downstream promise has settled).
   */
  handleFor(ctx: object): AdmissionHandle | undefined {
    const state = this.states.get(ctx);
    return state === undefined ? undefined : this.handleFromState(state);
  }

  /**
   * Track a downstream promise so shutdown can drain it. Returns the same
   * promise for the caller to return to grammy.
   */
  trackAdmitted(downstream: Promise<unknown>): Promise<unknown> {
    this.inFlightUpdates.add(downstream);
    const release = (): void => { this.inFlightUpdates.delete(downstream); };
    void downstream.then(release, release);
    return downstream;
  }

  /**
   * Clean up per-ctx state when the downstream promise settles. Releases
   * authorization (if not already released) and runtime admission (if the
   * update was not handed to the coalescer). This is the safety net that
   * guarantees no barrier leaks even if a handler crashes before calling
   * `releaseRuntimeAdmission`.
   */
  settleUpdate(ctx: object, downstream: Promise<void>): void {
    void downstream.then(
      () => this.settleState(ctx),
      () => this.settleState(ctx),
    );
  }

  private settleState(ctx: object): void {
    const state = this.states.get(ctx);
    if (state === undefined) return;
    if (!state.authorizationReleased) state.releaseAuth();
    if (!state.handedToCoalescer) state.releaseRuntime();
    this.states.delete(ctx);
  }

  // ─── close + drains ─────────────────────────────────────────────────

  /**
   * Close the Telegram admission gate. Idempotent and single-flight.
   *
   * Sequence:
   * 1. Set `outerOpen = false` synchronously — the middleware rejects new
   *    updates immediately.
   * 2. Drain in-flight authorizations — let updates already inside the
   *    allowlist middleware finish their allow/deny decision.
   * 3. Close the coalescer — flush buffered text and drain dispatches.
   * 4. Set `innerOpen = false` — intake stops admitting new work.
   * 5. Drain admitted updates — wait for every admitted handler to settle.
   *
   * The returned promise may remain pending on runtime work; deployment
   * shutdown starts runtime disposal before awaiting it.
   */
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

  /**
   * Wait only until text held in a coalescing buffer has reached its runtime
   * admission call. Intentionally separate from {@link closeAdmission},
   * which drains complete handlers.
   */
  async bufferedTextAdmission(): Promise<void> {
    await this.drainAuthorizations();
    await this.coalescerCallbacks.awaitBufferedTextAdmission();
  }

  /**
   * Wait until every admitted update has handed work to the runtime, or has
   * been proven not to need runtime work.
   */
  async runtimeAdmission(): Promise<void> {
    while (this.inFlightRuntimeAdmissions.size > 0) {
      await Promise.allSettled([...this.inFlightRuntimeAdmissions]);
    }
  }

  // ─── internal ───────────────────────────────────────────────────────

  private createState(): AdmissionState {
    let resolveRuntime!: () => void;
    const runtimePromise = new Promise<void>((res) => { resolveRuntime = res; });
    let resolveAuth!: () => void;
    const authorizationPromise = new Promise<void>((res) => { resolveAuth = res; });

    const state: AdmissionState = {
      released: false,
      handedToCoalescer: false,
      authorizationReleased: false,
      runtimePromise,
      authorizationPromise,
      releaseRuntime: () => {},
      releaseAuth: () => {},
    };

    state.releaseRuntime = (): void => {
      if (state.released) return;
      state.released = true;
      resolveRuntime();
      this.inFlightRuntimeAdmissions.delete(runtimePromise);
    };
    state.releaseAuth = (): void => {
      if (state.authorizationReleased) return;
      state.authorizationReleased = true;
      resolveAuth();
      this.inFlightAuthorizations.delete(authorizationPromise);
    };

    this.inFlightRuntimeAdmissions.add(runtimePromise);
    this.inFlightAuthorizations.add(authorizationPromise);
    return state;
  }

  private handleFromState(state: AdmissionState): AdmissionHandle {
    return {
      releaseRuntimeAdmission: state.releaseRuntime,
      releaseAuthorization: state.releaseAuth,
      markHandedToCoalescer: (): void => {
        state.handedToCoalescer = true;
      },
    };
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
