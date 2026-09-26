// The scheduler — a ticker that turns due jobs into ordinary turns
// (DESIGN.md, "Scheduled work"). Firing is runtime.submit of a
// `[scheduled: name]` user message into the job's pinned conversation
// with a normal delivery sink: no special execution path, the lane
// queue orders it behind any live turn, epoch fencing applies. Boot
// catch-up falls out of the due() query — a fire missed while the
// process was down is just "due" on the first tick.

import type { Api } from "grammy";
import type { ConversationStore } from "./conversation.ts";
import type { ConfigRef, TtsConfig } from "./config.ts";
import type { Runtime } from "./runtime.ts";
import { log } from "./log.ts";
import { wake } from "./wake.ts";
import type { Job, JobsStore } from "./jobs.ts";

export interface SchedulerDeps {
	jobs: JobsStore;
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

const TICK_MS = 30_000;

export function startScheduler(deps: SchedulerDeps, tickMs = TICK_MS): Scheduler {
	const scan = (): void => {
		const now = new Date();
		for (const job of deps.jobs.due(now)) {
			// One bad row must not take the scan down with it — but it
			// surfaces as an error line, never a swallow.
			try {
				fire(deps, job, now);
			} catch (err) {
				log.error("job scan failed", err, { job: job.id, name: job.name });
			}
		}
	};
	const timer = setInterval(scan, tickMs);
	// First scan at boot: catch-up for everything missed while down.
	scan();
	return { tick: scan, stop: () => clearInterval(timer) };
}

function fire(deps: SchedulerDeps, job: Job, now: Date): void {
	const lateMs = now.getTime() - new Date(job.nextRun).getTime();
	log.info("job fired", {
		job: job.id,
		name: job.name,
		conversation:
			job.threadId === null ? `dm:${job.chatId}` : `topic:${job.chatId}:${job.threadId}`,
		...(lateMs > TICK_MS ? { lateMs } : {}),
	});
	const landed = wake(
		deps,
		{ chatId: job.chatId, threadId: job.threadId },
		`[scheduled: ${job.name}] ${job.prompt}`,
	);
	if (!landed) {
		log.error("job submit failed", undefined, { job: job.id, name: job.name });
	}
	// One attempt per occurrence (DESIGN.md: never a replay): advance
	// even on failure, or a persistent submit error refires this job
	// — and re-delivers the error — on every tick.
	deps.jobs.markRan(job.id, now);
}
