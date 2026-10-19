import type { System1Client } from "../system1.ts";
import { LoopDetector, LOOP_DETECT_WARN, type LoopDetectorState } from "../loop-detect.ts";
import { LOOP_CHARS, LOOP_QUESTIONS, LOOP_WINDOW, loopState } from "../loop-watchdog.ts";
import { log } from "../log.ts";
import { summarize, toolOk, type ToolCallDigest } from "../reviewer.ts";

export type ForcedKind = "repeat" | "watchdog" | "context";

export interface LoopWatchdog {
	decide: System1Client["decide"];
	every: number;
}

export interface LoopTurnState {
	detector: LoopDetectorState;
	watchdogRing: ToolCallDigest[];
	watchdogStrikes: number;
	completedCalls: number;
	modelCalls: number;
	warnings: string[];
	cutKind: ForcedKind | null;
	forcedKind: ForcedKind | null;
}

const REPEAT_WARN = `Loop check: you have made the same tool call and gotten the same result ${LOOP_DETECT_WARN} times this turn. Repeating it will not change the outcome. Change approach, or stop and tell the operator what is blocking you. If you are deliberately waiting on something, wait longer between checks.`;
const WATCHDOG_WARN =
	"Progress check: your recent tool calls look stuck — they are not producing new information. Change approach, or if this cannot be done this way, stop and tell the operator what is blocking you.";

const LOOP_STUCK_SCORE = 0.7;

const CONTEXT_LANDING_PCT = 0.85;

export interface TurnStateDeps {
	convId: string;
	watchdog: LoopWatchdog | null;
	request: string;
}

export class TurnState {
	private detector: LoopDetector;
	private watchdogRing: ToolCallDigest[];
	private watchdogStrikes: number;
	private completedCalls: number;
	private modelCalls: number;
	private warnings: string[];
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
		this.modelCalls = loop?.modelCalls ?? 0;
		this.warnings = loop === undefined ? [] : [...loop.warnings];
		this.cutKind = loop?.cutKind ?? null;
		this.forcedKind = loop?.forcedKind ?? null;
	}

	noteContextLanding(prevInput: number | undefined, contextWindow: number | undefined): void {
		if (this.cutKind !== null || contextWindow === undefined || prevInput === undefined) return;
		if (prevInput >= contextWindow * CONTEXT_LANDING_PCT) this.cutKind = "context";
	}

	issueLanding(): ForcedKind | null {
		if (this.cutKind === null || this.landingIssued) return null;
		this.forcedKind = this.cutKind;
		this.landingIssued = true;
		return this.cutKind;
	}

	decidedCut(): ForcedKind | null {
		return this.cutKind;
	}

	forcedCompletion(): ForcedKind | null {
		return this.forcedKind;
	}

	isLandingIssued(): boolean {
		return this.landingIssued;
	}

	drainWarnings(): string[] {
		const unsent = this.warnings.slice(this.warnCursor);
		this.warnCursor = this.warnings.length;
		return unsent;
	}

	noteModelCall(): void {
		this.modelCalls++;
	}

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

	snapshot(): LoopTurnState {
		return {
			detector: this.detector.snapshot(),
			watchdogRing: [...this.watchdogRing],
			watchdogStrikes: this.watchdogStrikes,
			completedCalls: this.completedCalls,
			modelCalls: this.modelCalls,
			warnings: [...this.warnings],
			cutKind: this.cutKind,
			forcedKind: this.forcedKind,
		};
	}
}
