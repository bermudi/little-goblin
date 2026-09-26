// The scheduler — a ticker that turns due programs into ordinary turns
// (DESIGN.md, "Programs"). Firing is one path for every trigger:
// fireProgram submits a `[program: name · trigger: …]` user message
// into the program's pinned conversation with a normal delivery sink —
// no special execution path, the lane queue orders it behind any live
// turn, epoch fencing applies. Boot catch-up falls out of the due()
// query — a fire missed while the process was down is just "due" on
// the first tick.

import type { Api } from "grammy";
import type { ConversationStore } from "./conversation.ts";
import type { ConfigRef, TtsConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";
import { log } from "./log.ts";
import { wake } from "./wake.ts";
import type { Program, ProgramsStore } from "./programs.ts";

export interface SchedulerDeps {
	programs: ProgramsStore;
	store: ConversationStore;
	runtime: Runtime;
	api: Api;
	configRef: ConfigRef;
	synthesize(text: string, tts: TtsConfig): Promise<Uint8Array[]>;
}

export interface Scheduler {
	/** One scan now — also the test door; production runs it on a timer. */
	tick(): void;
	stop(): void;
}

export type ProgramTrigger = "schedule" | "webhook";

const TICK_MS = 30_000;

export function startScheduler(deps: SchedulerDeps, tickMs = TICK_MS): Scheduler {
	const scan = (): void => {
		const now = new Date();
		for (const program of deps.programs.due(now)) {
			// One bad row must not take the scan down with it — but it
			// surfaces as an error line, never a swallow.
			try {
				fireProgram(deps, program, "schedule", undefined, now);
			} catch (err) {
				log.error("program scan failed", err, {
					program: program.id,
					name: program.name,
				});
			}
		}
	};
	const timer = setInterval(scan, tickMs);
	// First scan at boot: catch-up for everything missed while down.
	scan();
	return { tick: scan, stop: () => clearInterval(timer) };
}

export function fireProgram(
	deps: SchedulerDeps,
	program: Program,
	trigger: ProgramTrigger,
	event: string | undefined,
	now: Date,
): void {
	const lateMs =
		program.nextRun === null
			? 0
			: now.getTime() - new Date(program.nextRun).getTime();
	log.info("program fired", {
		program: program.id,
		name: program.name,
		trigger,
		conversation:
			program.threadId === null
				? `dm:${program.chatId}`
				: `topic:${program.chatId}:${program.threadId}`,
		...(lateMs > TICK_MS ? { lateMs } : {}),
	});
	// The webhook `event` payload is accepted here but not yet appended —
	// hook delivery is a later step; today only "schedule" fires.
	void event;
	const landed = wake(
		deps,
		{ chatId: program.chatId, threadId: program.threadId },
		`[program: ${program.name} · trigger: ${trigger}]\n${program.charter}`,
	);
	if (!landed) {
		log.error("program submit failed", undefined, {
			program: program.id,
			name: program.name,
		});
	}
	// One attempt per occurrence (DESIGN.md: never a replay): advance
	// even on failure, or a persistent submit error refires this
	// program — and re-delivers the error — on every tick.
	deps.programs.markRan(program.id, now);
}
