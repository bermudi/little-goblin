// The mail watcher — the scheduler's twin (DESIGN.md, "Email"). Every
// 5 minutes it runs each enabled mail filter since its history-id
// cursor and hands new matches to the program firing owner's mail
// entry point, which owns the checkpoint policy — the watcher never
// writes program state. Expiry of outbox drafts is the approval
// gate's job — this module only polls. A dead token or quota error
// warns once per outage episode (per program), never per tick — in
// memory episodes: a restart re-warns, which is the honest state.

import { HistoryExpiredError, type MailHit, type ThreadContext } from "./mail.ts";
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
	fire(
		program: Program,
		hits: MailHit[],
		checkpoint: string,
		now: Date,
	): Promise<void>;
	/** Direct sends into the pinned conversation (built in tg/): outage
	 *  notices. Throwing retries next tick. */
	notify(address: { chatId: number; threadId: number | null }, text: string): Promise<void>;
	/** Test door for the poll clock. */
	now?(): Date;
}

export interface MailWatcher {
	/** One scan now — also the test door; production runs it on a timer. */
	tick(): Promise<void>;
	stop(): void;
}

const TICK_MS = 5 * 60_000;

export function startMailWatcher(deps: MailWatcherDeps, tickMs = TICK_MS): MailWatcher {
	// Per-program outage episodes: the last error message, present while
	// failing. A new message re-warns; equality stays silent; success
	// clears. Map identity is the program id.
	const failing = new Map<number, string>();
	// Ticks must not overlap — Gmail calls are async, so a slow pass
	// would stack another scan on top (the delegation watcher's rule).
	let current: Promise<void> | null = null;

	const scan = (): Promise<void> => {
		if (current !== null) return current;
		current = (async () => {
			try {
				const now = deps.now?.() ?? new Date();
				const gmail = deps.reader();
				if (gmail === null) {
					log.debug("mail watcher idle — mail is not configured");
				} else {
					for (const program of deps.programs.withMailFilter()) {
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
				}
			} finally {
				current = null;
			}
		})();
		return current;
	};
	const timer = setInterval(() => {
		void scan();
	}, tickMs);
	void scan(); // boot catch-up: the cursor persisted, missed mail fires
	return { tick: scan, stop: () => clearInterval(timer) };
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
				log.info("mail baseline lost to a mid-poll program edit — cursor skipped", { program: program.id, filter });
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
			// at all; the log says which (DESIGN.md's honest boundary).
			const head = await gmail.profileHistoryId();
			if (deps.programs.baselineMail(program, head)) {
				log.info("mail cursor expired — re-baselined", {
					program: program.id,
					name: program.name,
				});
			} else {
				log.info("mail baseline lost to a mid-poll program edit — cursor skipped", { program: program.id, filter });
			}
			recovered(deps, failing, program);
			return;
		}
		// The row can change while the poll is in flight (the webhook
		// route's fresh re-read rule): a disable, delete, or filter edit
		// that landed mid-poll wins over this poll's snapshot. A stale
		// charter must not fire, and setMailHistory must not clobber the
		// null cursor a filter edit just wrote to force re-baselining.
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
			// fire advances it (DESIGN.md, "Email").
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

function recovered(
	deps: MailWatcherDeps,
	failing: Map<number, string>,
	program: Program,
): void {
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
	log.warn("mail check failing", {
		program: program.id,
		name: program.name,
		error: message,
	});
	try {
		await deps.notify(
			{ chatId: program.chatId, threadId: program.threadId },
			`⚠️ mail check for "${program.name}" is failing (${message.slice(0, 150)}) — new matching mail won't wake it until this clears.`,
		);
	} catch (notifyErr) {
		// Delivery failed — unmark so the next tick retries the notice.
		if (failing.get(program.id) === message) failing.delete(program.id);
		log.warn("mail outage notice failed — retrying next tick", {
			program: program.id,
			error: String(notifyErr),
		});
	}
}
