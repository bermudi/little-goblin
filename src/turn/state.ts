// TurnState — one attempt's loop machinery (design/model.md → "No step
// budget": loops are caught, not capped). What bounds a turn, in order
// of who fires first: the repeat detector (deterministic hash), the
// loop watchdog (system1, on a cadence of completed calls), the context
// landing (85% of the catalog window), and the operator's /stop —
// whichever fires first owns the landing: one final tools-off step,
// then the loop ends. A turn always ends in an answer.
//
// State is classified by lifetime (design/runtime-turn.md): the
// recovery-carried fields are exactly LoopTurnState's; everything else
// (the warn cursor, a landing already issued, a check in flight) dies
// with the attempt. The runtime's stream callbacks reach this state
// only through methods here, never by rebinding a local.

import type { JevClient } from "../jev.ts";
import { LoopDetector, LOOP_DETECT_WARN, type LoopDetectorState } from "../loop-detect.ts";
import { LOOP_CHARS, LOOP_QUESTIONS, LOOP_WINDOW, loopState } from "../loop-watchdog.ts";
import { log } from "../log.ts";
import { summarize, toolOk, type ToolCallDigest } from "../reviewer.ts";

// Which landing forced the answer — the repeat detector, the loop
// watchdog, or the context landing. Stamped on the finish metadata and
// TurnDone so every delivery surface marks a forced reply as forced,
// never as natural.
export type ForcedKind = "repeat" | "watchdog" | "context";

// The watchdog wiring, owned by the Runtime (conversation-scoped): the
// decide function plus its cadence, normalized at wiring time. Null =
// watchdog off; the detector and the context landing still bound the
// turn.
export interface LoopWatchdog {
	decide: JevClient["decide"];
	every: number;
}

// The recovery-carried loop state — the exhaustive whitelist of what an
// overflow resume inherits. One logical turn keeps one loop history:
// the detector's records, the watchdog's ring and escalation, the
// warnings already queued (re-sent once in the resumed attempt), and a
// landing already decided — a cut the failed attempt decided still cuts
// the resume.
export interface LoopTurnState {
	detector: LoopDetectorState;
	watchdogRing: ToolCallDigest[];
	// Consecutive stuck verdicts: 0 clean, 1 warned — a second ≥0.7 cuts.
	watchdogStrikes: number;
	// Completed tool calls this turn — the watchdog's cadence counter.
	completedCalls: number;
	warnings: string[];
	cutKind: ForcedKind | null;
	forcedKind: ForcedKind | null;
}

// A warning rides the next request as a user-role, request-only tail
// message — never durable history; the SDK carries the prepareStep
// messages override forward, so it lands exactly once per step. The
// warn cursor is what keeps it once per attempt.
const REPEAT_WARN =
	`Loop check: you have made the same tool call and gotten the same result ${LOOP_DETECT_WARN} times this turn. Repeating it will not change the outcome. Change approach, or stop and tell the operator what is blocking you. If you are deliberately waiting on something, wait longer between checks.`;
const WATCHDOG_WARN =
	"Progress check: your recent tool calls look stuck — they are not producing new information. Change approach, or if this cannot be done this way, stop and tell the operator what is blocking you.";

// Watchdog verdicts: at/over this score is "stuck". Calibrated against
// stored turns by scripts/loop-calibrate.ts.
const LOOP_STUCK_SCORE = 0.7;

// The context landing's fill line: a step whose reported input reached
// this fraction of the catalog window makes the next step the landing.
const CONTEXT_LANDING_PCT = 0.85;

export interface TurnStateDeps {
	convId: string;
	watchdog: LoopWatchdog | null;
	// The operator's triggering message text — the watchdog state's
	// request line.
	request: string;
}

export class TurnState {
	private detector: LoopDetector;
	// The watchdog reads its own ring of the last LOOP_WINDOW calls —
	// independent of the reviewer's evidence ring, whose prod cap is too
	// shallow.
	private watchdogRing: ToolCallDigest[];
	private watchdogStrikes: number;
	private completedCalls: number;
	private warnings: string[];
	// Attempt-scoped, never snapshotted: how many warnings this attempt
	// already sent, whether the forced step was issued, and a check in
	// flight when the attempt dies (void for the resume).
	private warnCursor = 0;
	private landingIssued = false;
	private watchdogInFlight = false;
	private cutKind: ForcedKind | null;
	private forcedKind: ForcedKind | null;

	constructor(
		private readonly deps: TurnStateDeps,
		loop?: LoopTurnState,
	) {
		this.detector = LoopDetector.restore(loop?.detector);
		this.watchdogRing = loop === undefined ? [] : [...loop.watchdogRing];
		this.watchdogStrikes = loop?.watchdogStrikes ?? 0;
		this.completedCalls = loop?.completedCalls ?? 0;
		this.warnings = loop === undefined ? [] : [...loop.warnings];
		this.cutKind = loop?.cutKind ?? null;
		this.forcedKind = loop?.forcedKind ?? null;
	}

	// The context landing: a step whose input reached the fill line makes
	// the next step the tools-off landing — the physical bound on a turn,
	// since an overflow resume can't compact the in-flight reply. An
	// earlier landing keeps ownership.
	noteContextLanding(prevInput: number | undefined, contextWindow: number | undefined): void {
		if (this.cutKind !== null || contextWindow === undefined || prevInput === undefined) return;
		if (prevInput >= contextWindow * CONTEXT_LANDING_PCT) this.cutKind = "context";
	}

	// Issue the cut's forced tools-off step exactly once per attempt:
	// stamp forcedKind (finish metadata reads it) and let stopWhen end
	// the loop after this one step. Returns the kind on the pass that
	// issues, null otherwise.
	issueLanding(): ForcedKind | null {
		if (this.cutKind === null || this.landingIssued) return null;
		this.forcedKind = this.cutKind;
		this.landingIssued = true;
		return this.cutKind;
	}

	// The cut decided for this turn, if any — the forced flag and the
	// cut nudge read it on every prepareStep pass.
	decidedCut(): ForcedKind | null {
		return this.cutKind;
	}

	// Which landing fired, if any — finish metadata, the defiance guard,
	// and the completed TurnDone read it.
	forcedCompletion(): ForcedKind | null {
		return this.forcedKind;
	}

	// stopWhen: end the loop after the one forced step.
	isLandingIssued(): boolean {
		return this.landingIssued;
	}

	// Warnings queued since the last boundary. The cursor advances to the
	// whole queue — the override carries forward, so each warning rides a
	// request exactly once per attempt.
	drainWarnings(): string[] {
		const unsent = this.warnings.slice(this.warnCursor);
		this.warnCursor = this.warnings.length;
		return unsent;
	}

	// One completed tool call: feed the repeat detector, grow the
	// watchdog's ring, and run its cadence — one check in flight at a
	// time, async and fail-open. A verdict lands between steps; the
	// stream's prepareStep folds it into the next request.
	noteCompletedCall(tool: string, input: unknown, result: unknown, failed: boolean): void {
		this.completedCalls++;
		const verdict = this.detector.record(tool, input, result);
		if (verdict.action === "warn") {
			this.warnings.push(REPEAT_WARN);
		} else if (verdict.action === "cut") {
			this.cutKind ??= "repeat";
		}
		if (verdict.action !== "none") {
			log.warn("loop detector", {
				conversation: this.deps.convId,
				tool,
				count: verdict.count,
				action: verdict.action,
			});
		}
		const watchdog = this.deps.watchdog;
		if (watchdog === null) return;
		this.watchdogRing.push({
			tool,
			args: summarize(input, LOOP_CHARS),
			result: failed
				? summarize(result, LOOP_CHARS)
				: summarize(result ?? "(no result)", LOOP_CHARS),
			ok: !failed && toolOk(result),
		});
		if (this.watchdogRing.length > LOOP_WINDOW) this.watchdogRing.shift();
		if (this.completedCalls % watchdog.every !== 0 || this.watchdogInFlight) return;
		this.watchdogInFlight = true;
		void watchdog
			.decide(loopState(this.deps.request, this.completedCalls, this.watchdogRing), LOOP_QUESTIONS)
			.then((decision) => {
				const score = decision.answers["stuck"] ?? 0;
				let action: "none" | "warn" | "cut" = "none";
				if (score >= LOOP_STUCK_SCORE) {
					// Escalation: the first consecutive stuck verdict warns,
					// the second cuts, a pass resets to clean.
					if (this.watchdogStrikes >= 1) {
						action = "cut";
						this.cutKind ??= "watchdog";
					} else {
						action = "warn";
						this.watchdogStrikes = 1;
						this.warnings.push(WATCHDOG_WARN);
					}
				} else {
					this.watchdogStrikes = 0;
				}
				log.info("loop watchdog", {
					conversation: this.deps.convId,
					toolCalls: this.completedCalls,
					stuck: score,
					action,
				});
			})
			.catch((err: unknown) => {
				log.warn("loop watchdog unavailable — fail-open", err, {
					conversation: this.deps.convId,
				});
			})
			.finally(() => {
				this.watchdogInFlight = false;
			});
	}

	// The recovery payload. Copied by value — a watchdog verdict still in
	// flight when the attempt dies cannot leak into the resume: the
	// whitelist is everything that survives, and only as data.
	snapshot(): LoopTurnState {
		return {
			detector: this.detector.snapshot(),
			watchdogRing: [...this.watchdogRing],
			watchdogStrikes: this.watchdogStrikes,
			completedCalls: this.completedCalls,
			warnings: [...this.warnings],
			cutKind: this.cutKind,
			forcedKind: this.forcedKind,
		};
	}
}
