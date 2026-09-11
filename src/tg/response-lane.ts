/**
 * Outcome of {@link ResponseLane.enter}:
 *   "proceed"  the lane was idle; the caller may start its write now.
 *   "skipped"  the lane was busy and the caller was non-force; it must return
 *              without writing (a later flush picks the work up).
 *   "awaited"  the lane was busy and the caller was force; the in-flight
 *              write has settled and the caller may proceed.
 */
export type LaneEntry = "proceed" | "skipped" | "awaited";

/**
 * Coordinates one in-flight Telegram write (`Promise<void>`) per lane.
 *
 * MessageBuffer owns one lane per coordination point (response create, status
 * edit, response edit, whole-flush, segment seal) and expresses the three
 * postures each site needs:
 *
 *   - `enter(force)`: non-force reports "skipped" while busy; force awaits
 *     the in-flight write, then proceeds. Force callers resume in arrival
 *     order, so the earliest force flush claims the lane first.
 *   - `wait()`: await-if-busy; returns the promise to await, or null when
 *     idle.
 *   - `isBusy()`: report-and-return for callers whose in-flight work loops
 *     and re-reads state (the status coalescing loop bails here; the
 *     in-flight edit picks up whatever mutated during the round-trip).
 *
 * `enter` and `wait` decide synchronously whenever no wait is required, and
 * `track` claims the lane synchronously when invoked. That atomicity is
 * load-bearing: a caller that sees an idle lane claims it in the same
 * synchronous run, so a concurrent synchronous caller can never slip into
 * the gap between check and claim.
 *
 * `track(work)` owns the assign/clear discipline: the lane reports busy
 * until `work` settles, then clears itself on resolve AND on reject — but
 * only if `work` is still the tracked write, so a chained replacement is
 * never clobbered by its predecessor settling.
 */
export class ResponseLane {
  private inFlight: Promise<void> | null = null;

  /** True while a tracked write is in flight. */
  isBusy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * The in-flight write, or null. Exposed for tail-chaining (a seal whose
   * work begins by awaiting the previous seal) and for settle sweeps that
   * await every lane without observing rejections.
   */
  get current(): Promise<void> | null {
    return this.inFlight;
  }

  /**
   * Skip/await posture. Idle ("proceed") and non-force-on-busy ("skipped")
   * decisions are synchronous; only a force caller on a busy lane receives a
   * promise, resolving "awaited" once the write that was in flight at entry
   * settles (propagating its rejection, like a direct await would).
   */
  enter(force: boolean): LaneEntry | Promise<"awaited"> {
    const current = this.inFlight;
    if (current === null) return "proceed";
    if (!force) return "skipped";
    return current.then((): "awaited" => "awaited");
  }

  /**
   * Await-if-busy posture: the in-flight write to await, or null when idle
   * so the caller can continue without yielding.
   */
  wait(): Promise<void> | null {
    return this.inFlight;
  }

  /**
   * Track `work` as this lane's in-flight write, awaiting it so callers
   * observe the same completion or rejection as a direct await. The lane is
   * claimed synchronously when `track` is invoked; the marker clears when
   * `work` settles unless a newer write has already taken the lane.
   */
  async track(work: Promise<void>): Promise<void> {
    this.inFlight = work;
    try {
      await work;
    } finally {
      if (this.inFlight === work) this.inFlight = null;
    }
  }
}
