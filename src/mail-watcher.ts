// Each enabled mail filter runs since its history-id cursor and hands
// new matches to the program firing owner's entry point — which owns
// the checkpoint; the watcher never writes program state. Outbox
// draft expiry is the approval gate's job.

import { HistoryExpiredError, type MailHit, type ThreadContext } from "./mail.ts";
import type { DevelopmentInput } from "./wake-store.ts";
import type { ResponsibilityStore } from "./responsibilities.ts";
import type { Program, ProgramsStore } from "./programs.ts";
import { log } from "./log.ts";

/** The watcher's poll surface: history intersect + baseline + thread
 *  context. mail-gws.ts's GwsMailReader in production, a fake at the
 *  edge in tests — structural, not nominal. */
export interface MailPoller {
	poll(filter: string, startHistoryId: string): Promise<{ hits: MailHit[]; historyId: string }>;
	profileHistoryId(): Promise<string>;
	threadFor(replyToId: string): Promise<ThreadContext | null>;
}

export interface MailWatcherDeps {
	programs: ProgramsStore;
	/** Live poll client, or null when mail is unconfigured. */
	reader(): MailPoller | null;
	/** The firing owner's mail entry point (scheduler.ts's fireMail) —
	 *  owns the fire and the checkpoint policy. Async: the injection
	 *  check scores the event before the turn lands. */
	fire(program: Program, hits: MailHit[], checkpoint: string, now: Date): Promise<void>;
	/** The destination router for outage notices: a chat-pinned program
	 *  notices its Telegram conversation; a responsibility-bound one
	 *  (chat_id 0 is not an address) notices its coordination lane.
	 *  Throwing retries next tick. */
	notify(program: Program, text: string): Promise<void>;
	/** Test door for the poll clock. */
	now?(): Date;
}

export interface MailWatcher {
	/** One scan now; after stop this only joins existing work (or is a no-op). */
	tick(): Promise<void>;
	/** Stops the timer and returns the in-flight scan, if any, so
	 *  shutdown can join it: a scan parked in a Gmail call must not come
	 *  back after the drain and fire into a closed runtime. */
	stop(): Promise<void>;
}

export interface MailNoticeRouting {
	/** The responsibility seam — a responsibility-bound program's lane. */
	resps: Pick<ResponsibilityStore, "get">;
	/** The durable development sink — the wake dispatcher's record. */
	record(input: DevelopmentInput): void;
	/** The Telegram send for chat-pinned programs. */
	sendTelegram(address: { chatId: number; threadId: number | null }, text: string): Promise<void>;
}

/** Where an outage notice goes. A chat-pinned program notices its
 *  Telegram conversation; a responsibility-bound one has no address
 *  (chat_id 0 is the destination marker) — its notice is a durable
 *  development on the work's coordination lane, delivered through the
 *  wake dispatcher like any other event. */
export function makeMailNoticeRouter(
	routing: MailNoticeRouting,
): (program: Program, text: string) => Promise<void> {
	return async (program, text) => {
		if (program.responsibilityId !== null) {
			const resp = routing.resps.get(program.responsibilityId);
			if (resp === null) {
				// The program outlived its responsibility — nobody to tell.
				log.warn("mail outage notice skipped — responsibility gone", {
					program: program.id,
					responsibility: program.responsibilityId,
				});
				return;
			}
			// Per-episode key: the watcher re-warns on a changed error, and
			// a recovery + re-failure must notify again, not dedupe onto an
			// old event.
			routing.record({
				sourceKey: `mail-outage:${program.id}:${crypto.randomUUID()}`,
				conversationId: resp.coordinationConversationId,
				kind: "mail-outage",
				text,
				facts: { program: program.id, name: program.name },
				origin: "mail-watcher",
				responsibilityId: resp.responsibilityId,
			});
			return;
		}
		await routing.sendTelegram({ chatId: program.chatId, threadId: program.threadId }, text);
	};
}

const TICK_MS = 5 * 60_000;

const activeWatchers = new WeakSet<object>();

/** One ticker per store object; duplicate starts fail until the old owner stops. */
export function startMailWatcher(deps: MailWatcherDeps, tickMs = TICK_MS): MailWatcher {
	if (activeWatchers.has(deps.programs))
		throw new Error("startMailWatcher already active for this store");
	activeWatchers.add(deps.programs);
	let stopped = false;
	let stopping: Promise<void> | null = null;
	// Per-program outage episodes: the last error message, present while
	// failing. A new message re-warns; equality stays silent; success
	// clears. Map identity is the program id, and the map lives in
	// memory — a restart re-warns, which is the honest state.
	const failing = new Map<number, string>();
	// Ticks must not overlap — Gmail calls are async, so a slow pass
	// would stack another scan on top.
	let current: Promise<void> | null = null;

	const scan = (): Promise<void> => {
		if (current !== null) return current;
		if (stopped) return Promise.resolve();
		// Assign the .finally wrapper, not the work promise: a body that
		// finishes without awaiting (mail unconfigured, or no enabled
		// filters) would run its cleanup before the assignment lands,
		// wedging `current` on a resolved promise — every later tick then
		// returns the dead promise and the watcher silently never scans
		// again.
		const work = (async () => {
			const now = deps.now?.() ?? new Date();
			// The reader and the filter query sit outside the per-program
			// guard below; a throw here would otherwise leave scan() as a
			// context-free unhandled rejection every tick.
			let gmail: MailPoller | null;
			let programs: Program[];
			try {
				gmail = deps.reader();
				programs = gmail === null ? [] : deps.programs.withMailFilter();
			} catch (err) {
				log.error("mail scan failed", err, {});
				return;
			}
			if (gmail === null) {
				log.debug("mail watcher idle — mail is not configured");
				return;
			}
			for (const program of programs) {
				try {
					await check(deps, failing, gmail, program, now);
				} catch (err) {
					// One bad row must not take the scan down — but
					// it surfaces as an error line, never a swallow.
					// (check() handles its own Gmail failures; this
					// is for store throws and programming errors.)
					log.error("mail check failed", err, {
						program: program.id,
						name: program.name,
					});
				}
			}
		})();
		current = work.finally(() => {
			current = null;
		});
		return current;
	};
	const timer = setInterval(() => {
		void scan();
	}, tickMs);
	void scan(); // boot catch-up: the cursor persisted, missed mail fires
	return {
		tick: scan,
		stop: () => {
			if (stopping !== null) return stopping;
			stopped = true;
			clearInterval(timer);
			stopping = (current ?? Promise.resolve()).finally(() => {
				activeWatchers.delete(deps.programs);
			});
			return stopping;
		},
	};
}

async function check(
	deps: MailWatcherDeps,
	failing: Map<number, string>,
	gmail: MailPoller,
	program: Program,
	now: Date,
): Promise<void> {
	const filter = program.mailFilter!;
	try {
		if (program.mailHistoryId === null) {
			// New filter: baseline at the current head — the mailbox's
			// backlog is history, not arrivals, so it never fires.
			const head = await gmail.profileHistoryId();
			if (deps.programs.baselineMail(program, head)) {
				log.info("mail filter baselined", { program: program.id, name: program.name, filter });
			} else {
				log.info("mail baseline lost to a mid-poll program edit — cursor skipped", {
					program: program.id,
					filter,
				});
			}
			recovered(deps, failing, program);
			return;
		}
		let hits: MailHit[];
		let historyId: string;
		try {
			({ hits, historyId } = await gmail.poll(filter, program.mailHistoryId));
		} catch (err) {
			if (!(err instanceof HistoryExpiredError)) throw err;
			// Google forgot the cursor — re-baseline like a new filter.
			// Mail between the old cursor and now may fire late or not
			// at all; the log says which.
			const head = await gmail.profileHistoryId();
			if (deps.programs.baselineMail(program, head)) {
				log.info("mail cursor expired — re-baselined", {
					program: program.id,
					name: program.name,
				});
			} else {
				log.info("mail baseline lost to a mid-poll program edit — cursor skipped", {
					program: program.id,
					filter,
				});
			}
			recovered(deps, failing, program);
			return;
		}
		// The row can change while the poll is in flight — a disable,
		// delete, or filter edit that landed mid-poll wins over this
		// poll's snapshot. A stale charter must not fire, and
		// setMailHistory must not clobber the null cursor a filter edit
		// just wrote to force re-baselining.
		const fresh = deps.programs.get(program.id);
		if (fresh === null) {
			// Deleted mid-poll — nothing to write, nothing to fire; the
			// episode key dies with the row.
			failing.delete(program.id);
			log.info("mail program deleted mid-poll — nothing fired", {
				program: program.id,
				name: program.name,
			});
			return;
		}
		const stillMine = fresh.mailFilter === filter && fresh.mailRevision === program.mailRevision;
		const cursorUntouched = fresh.mailHistoryId === program.mailHistoryId;
		if (stillMine && cursorUntouched) {
			// The entry point owns what happens next: an empty or disabled
			// poll consumes the checkpoint, a failed fire holds it, a landed
			// fire advances it.
			await deps.fire(fresh, hits, historyId, now);
		} else {
			// The edit won: no cursor write (it would clobber the null a
			// filter edit just wrote), no fire under a stale charter/filter.
			log.info("mail poll lost to a mid-poll program edit — cursor and fire skipped", {
				program: program.id,
				name: program.name,
			});
		}
		recovered(deps, failing, program);
	} catch (err) {
		await failed(deps, failing, program, err);
	}
}

function recovered(deps: MailWatcherDeps, failing: Map<number, string>, program: Program): void {
	if (!failing.has(program.id)) return;
	failing.delete(program.id);
	log.info("mail check recovered", { program: program.id, name: program.name });
}

// Warn once per episode: the first failure (or a changed error) warns
// and notices the pinned conversation; repeats stay debug-silent until
// a success clears the episode. A notice that fails to deliver leaves
// the episode unmarked, so it retries next tick.
async function failed(
	deps: MailWatcherDeps,
	failing: Map<number, string>,
	program: Program,
	err: unknown,
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	const prior = failing.get(program.id);
	if (prior === message) {
		log.debug("mail check still failing", { program: program.id, name: program.name });
		return;
	}
	failing.set(program.id, message);
	log.warn("mail check failing", err, {
		program: program.id,
		name: program.name,
	});
	try {
		await deps.notify(
			program,
			`⚠️ mail check for "${program.name}" is failing (${message.slice(0, 150)}) — new matching mail won't wake it until this clears.`,
		);
	} catch (notifyErr) {
		// Delivery failed — unmark so the next tick retries the notice.
		if (failing.get(program.id) === message) failing.delete(program.id);
		log.warn("mail outage notice failed — retrying next tick", notifyErr, {
			program: program.id,
		});
	}
}
