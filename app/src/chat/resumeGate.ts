export type ProbePhase = "unprobed" | "probing" | "settled";

export interface ResumeGateEvents {
  idle(): void;
  settled(): void;
}

// Decides when Chat may attach a reader to the live turn.
export class ResumeGate {
  private phase: ProbePhase = "unprobed";
  private readonly seededMount: boolean;
  private seededSkipUsed = false;
  private events: ResumeGateEvents | null = null;
  private cooldown = false;
  serverLive = false;
  readerAttached = false;

  constructor(
    seededMount: boolean,
    private readonly schedule: (fn: () => void, ms: number) => void = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
  ) {
    this.seededMount = seededMount;
  }

  get probe(): ProbePhase {
    return this.phase;
  }

  subscribe(events: ResumeGateEvents): () => void {
    this.events = events;
    return () => {
      if (this.events === events) this.events = null;
    };
  }

  beginReconnect(): { skipNetwork: boolean } {
    const skipNetwork = this.seededMount && !this.seededSkipUsed;
    this.seededSkipUsed = true;
    if (this.phase === "unprobed") this.phase = "probing";
    return { skipNetwork };
  }

  reconnectAnswered(attached: boolean): void {
    this.readerAttached = attached;
    if (!attached) this.events?.idle();
  }

  // Run after the SDK's status writeback: the microtask cascade after
  // reconnect completes before this macrotask.
  probeSettled(): void {
    this.schedule(() => {
      if (this.phase === "settled") return;
      this.phase = "settled";
      this.events?.settled();
    }, 0);
  }

  readerEnded(): void {
    this.readerAttached = false;
  }

  requestResume(): boolean {
    // A resume begun during the mount probe has its "submitted" status
    // overwritten by the probe's "ready" writeback. Wait for the probe
    // to settle; probeSettled uses a macrotask to run after that writeback.
    if (
      this.readerAttached ||
      this.cooldown ||
      this.phase === "probing"
    ) {
      return false;
    }
    this.cooldown = true;
    this.schedule(() => {
      this.cooldown = false;
    }, 1000);
    return true;
  }
}
