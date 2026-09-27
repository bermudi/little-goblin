// The mail watcher — the scheduler's twin (DESIGN.md, "Email"). Every
// 5 minutes it runs each enabled mail filter since its history-id
// cursor and fires new matches through the one program firing path,
// batched: one tick's matches become one turn. The same tick sweeps
// expired outbox rows and stamps their drafts. A dead token or quota
// error warns once per outage episode (per program), never per tick —
// in-memory episodes: a restart re-warns, which is the honest state.

import { HistoryExpiredError, type MailHit, type MailReader } from "./mail.ts";
import type { OutboxStore } from "./mail-outbox.ts";
import type { Program, ProgramsStore } from "./programs.ts";
import { log } from "./log.ts";

export interface MailWatcherDeps {
	programs: ProgramsStore;
	outbox: OutboxStore;
	/** Live read client, or null when mail is unconfigured. */
	reader(): MailReader | null;
	/** The one firing path — fireProgram bound with trigger "mail". */
	fire(program: Program, event: string, now: Date): boolean;
	/** Direct sends into the pinned conversation (built in tg/): outage
	 *  notices and expiry stamps. Throwing retries next tick. */
	notify(address: { chatId: number; threadId: number | null }, text: string): Promise<void>;
	stampDraft(
		address: { chatId: number; threadId: number | null },
		messageId: number,
		text: string,
	): Promise<void>;
	/** True while a Send tap's Gmail calls are in flight for the draft
	 *  (tg/mail-approval's sending set) — the expiry sweep must not
	 *  claim such a row: the send's own verdict decides it. */
	isSending?(id: number): boolean;
	/** Test door for the expiry sweep. */
	now?(): Date;
}

export interface MailWatcher {
	/** One scan now — also the test door; production runs it on a timer. */
	tick(): Promise<void>;
	stop(): void;
}

const TICK_MS = 5 * 60_000;

// The event body: one block per match (from/subject/date/snippet/id —
// the body is one `mail read` away, never pushed), oldest first.
export function formatMailEvent(hits: MailHit[]): string {
	return hits
		.map((h) =>
			[
				`from: ${h.from || "(no sender)"}`,
				`subject: ${h.subject || "(no subject)"}`,
				`date: ${h.date}`,
				`snippet: ${h.snippet}`,
				`id: ${h.id}`,
			].join("\n"),
		)
		.join("\n---\n");
}

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
				await sweepExpired(deps, now);
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
	gmail: MailReader,
	program: Program,
	now: Date,
): Promise<void> {
	const filter = program.mailFilter!;
	try {
		if (program.mailHistoryId === null) {
			// New filter: baseline at the current head — the mailbox's
			// backlog is history, not arrivals, so it never fires.
			const head = await gmail.profileHistoryId();
			deps.programs.setMailHistory(program.id, head);
			log.info("mail filter baselined", { program: program.id, name: program.name, filter });
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
			deps.programs.setMailHistory(program.id, head);
			log.info("mail cursor expired — re-baselined", {
				program: program.id,
				name: program.name,
			});
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
		const stillMine = fresh.mailFilter === filter;
		const cursorUntouched = fresh.mailHistoryId === program.mailHistoryId;
		if (stillMine && cursorUntouched) {
			if (historyId !== "") {
				deps.programs.setMailHistory(program.id, historyId);
			} else {
				log.warn("mail poll returned no checkpoint — cursor kept, retrying next tick", {
					program: program.id,
					name: program.name,
				});
			}
			if (hits.length > 0 && fresh.enabled) {
				const event = formatMailEvent(hits);
				// The cursor already advanced past these matches — markFired is
				// the informational stamp (the webhook route's rule), and it
				// only lands when the turn did.
				const landed = deps.fire(fresh, event, now);
				if (landed) {
					deps.programs.markFired(program.id, now);
					log.info("mail fired", {
						program: program.id,
						name: program.name,
						matches: hits.length,
					});
				} else {
					log.error("mail fire did not land", undefined, {
						program: program.id,
						name: program.name,
						matches: hits.length,
					});
				}
			}
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

// Expired drafts settle here when no tap beats the fuse. Stamping is
// best-effort per row — a Telegram failure must not stop the sweep,
// and the row is already expired, so a stale tap answers "already
// expired" and strips its own buttons.
async function sweepExpired(deps: MailWatcherDeps, now: Date): Promise<void> {
	let rows: ReturnType<OutboxStore["expireDue"]>;
	try {
		// Rows mid-send are excluded at the store: their Gmail send is
		// deciding them, and an "expired — never sent" stamp over a send
		// in flight would be a lie.
		rows = deps.outbox.expireDue(now, deps.isSending);
	} catch (err) {
		log.error("outbox expiry sweep failed", err);
		return;
	}
	await Promise.allSettled(
		rows
			.filter((row) => row.draftMessageId !== null)
			.map((row) =>
				deps
					.stampDraft(
						{ chatId: row.chatId, threadId: row.threadId },
						row.draftMessageId!,
						`⌛ Draft #${row.id} expired — never sent.`,
					)
					.catch((err: unknown) => {
						log.warn("expired draft stamp failed", { outbox: row.id, error: String(err) });
					}),
			),
	);
	if (rows.length > 0) {
		log.info("outbox expiry swept", { count: rows.length });
	}
}
