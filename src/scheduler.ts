// The scheduler — a ticker that turns due jobs into ordinary turns
// (DESIGN.md, "Scheduled work"). Firing is runtime.submit of a
// `[scheduled: name]` user message into the job's pinned conversation
// with a normal delivery sink: no special execution path, the lane
// queue orders it behind any live turn, epoch fencing applies. Boot
// catch-up falls out of the due() query — a fire missed while the
// process was down is just "due" on the first tick.

import type { Api } from "grammy";
import type { UIMessage } from "ai";
import type { ConversationAddress, ConversationStore } from "./conversation.ts";
import { paths, type Config, type TtsConfig } from "./config.ts";
import { userMessage, type Runtime } from "./runtime.ts";
import { log } from "./log.ts";
import { makeDeliverySink } from "./tg/delivery.ts";
import type { Job, JobsStore } from "./jobs.ts";

export interface SchedulerDeps {
	jobs: JobsStore;
	store: ConversationStore;
	runtime: Runtime;
	api: Api;
	configRef: { current: Config };
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
	const addr: ConversationAddress =
		job.threadId === null
			? { kind: "dm", chatId: job.chatId }
			: { kind: "topic", chatId: job.chatId, threadId: job.threadId };
	const conv = deps.store.resolve(addr, paths.workspace());
	const lateMs = now.getTime() - new Date(job.nextRun).getTime();
	log.info("job fired", {
		job: job.id,
		name: job.name,
		conversation: conv.id,
		...(lateMs > TICK_MS ? { lateMs } : {}),
	});
	const parts: UIMessage["parts"] = [
		{ type: "text", text: `[scheduled: ${job.name}] ${job.prompt}` },
	];
	const tts = deps.configRef.current.tts;
	const sink = makeDeliverySink(
		deps.api,
		conv,
		undefined,
		undefined,
		tts ? { voiceMode: conv.voice, synthesize: (text) => deps.synthesize(text, tts) } : undefined,
	);
	try {
		deps.runtime.submit(conv, userMessage(parts), sink);
	} catch (err) {
		// Same contract as the intake flush: a constructed sink is already
		// "typing" — release it with the error or it ghosts forever. The
		// job is NOT marked ran: it stays due and fires after a restart.
		void sink.onDone({
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		});
		log.error("job submit failed", err, { job: job.id, name: job.name });
		return;
	}
	// Submit landed (in history even if the turn never runs) — record
	// the run and advance to the next future occurrence.
	deps.jobs.markRan(job.id, now);
}
