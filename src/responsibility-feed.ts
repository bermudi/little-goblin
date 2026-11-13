// The project feed read model — one durable surface composed from
// responsibilities, attachments, prompt operations, and work events
// joined to their wake dispositions. Read-only; a page reload reads
// the same durable truth. Delivery failures surface per event via
// the wake join — never inferred from the event alone.

import type { Database } from "bun:sqlite";
import { armedView, type ResponsibilityStore } from "./responsibilities.ts";
import type { Attachment, PromptOperation, Responsibility } from "./responsibility-types.ts";
import { latestFireAtOrBefore, nextFire, type ProgramsStore } from "./programs.ts";
import { type ResponsibilityReport, toReport } from "./responsibility-reports.ts";
import { responsibilityStage, type ResponsibilityStage } from "./responsibility-stage.ts";

export interface FeedWake {
	wakeId: number;
	state: string;
	lastError: string | null;
	settledAt: string | null;
	runId: string | null;
}

export interface FeedEvent {
	eventId: number;
	sourceKey: string;
	kind: string;
	text: string;
	facts: unknown;
	origin: string;
	createdAt: string;
	conversationId: string;
	wake: FeedWake | null;
}

/** Whose word a post is, and whether goblin has stood behind it. A
 *  worker's claim stays `unreviewed` until goblin files a later report
 *  of its own on the same responsibility. */
export type PostReview = "assessed" | "unreviewed" | "reviewed" | "migrated";

/** An outcome post — a report, the work's stated result or need. Routine
 *  activity (check-ins, observations) stays in `events`. */
export interface FeedPost {
	report: ResponsibilityReport;
	review: PostReview;
	/** Stated at the responsibility's current revision; false once an
	 *  operator correction has answered or overtaken it. */
	current: boolean;
}

export interface FeedItem {
	responsibility: Responsibility;
	attachments: Attachment[];
	operations: PromptOperation[];
	/** Whom the work waits for — the one derivation (responsibility-stage.ts). */
	stage: ResponsibilityStage;
	latestReport: ResponsibilityReport | null;
	/** Newest first, bounded by FEED_POST_WINDOW. */
	posts: FeedPost[];
	/** Older reports the window omitted — the rows remain. */
	postsTruncated: number;
	events: FeedEvent[];
	/** Older durable events the window omitted — the rows remain. */
	eventsTruncated: number;
	/** Earliest scheduled evaluation at/after the planned review. */
	nextCheckinAt: string | null;
	nextCheckinReason: string | null;
	/** Newest development timestamp — the pill's freshness. */
	lastActivityAt: string | null;
}

export interface FeedDeps {
	db: Database;
	resps: ResponsibilityStore;
	/** Optional — the feed degrades to nextCheckinAt null without it. */
	programs?: Pick<ProgramsStore, "get"> | undefined;
}

interface EventRow {
	event_id: number;
	source_key: string;
	conversation_id: string;
	kind: string;
	text: string;
	facts_json: string;
	origin: string;
	created_at: string;
	wake_id: number | null;
	wake_state: string | null;
	wake_error: string | null;
	wake_settled_at: string | null;
	wake_run_id: string | null;
}

// The wire carries each responsibility's newest developments, not all
// of them: an anchored coordination conversation can never be deleted
// (its history is unprunable by ruling), while the app refetches every 15s —
// so the payload is bounded by this window, never by the work.
export const FEED_EVENT_WINDOW = 50;
export const FEED_POST_WINDOW = 20;

function feedPosts(
	db: Database,
	resp: Pick<Responsibility, "responsibilityId" | "revision">,
): { posts: FeedPost[]; truncated: number } {
	const reports = db
		.query<unknown, [string, number]>(
			"SELECT * FROM responsibility_reports WHERE responsibility_id = ? ORDER BY report_id DESC LIMIT ?",
		)
		.all(resp.responsibilityId, FEED_POST_WINDOW)
		.map(toReport);
	const total = db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM responsibility_reports WHERE responsibility_id = ?",
		)
		.get(resp.responsibilityId)!.n;
	// Walking newest → oldest: a worker claim is reviewed once any goblin
	// report follows it. A goblin report older than the window cannot
	// follow a claim inside it, so the window decides nothing wrongly.
	let goblinAfter = false;
	const posts = reports.map((report): FeedPost => {
		const review: PostReview =
			report.reporter === "goblin"
				? "assessed"
				: report.reporter === "migration"
					? "migrated"
					: goblinAfter
						? "reviewed"
						: "unreviewed";
		if (report.reporter === "goblin") goblinAfter = true;
		return { report, review, current: report.revision === resp.revision };
	});
	return { posts, truncated: total - posts.length };
}

function feedEvents(
	db: Database,
	responsibilityId: string,
): { events: FeedEvent[]; truncated: number } {
	const rows = db
		.query<EventRow, [string, number]>(
			`SELECT e.event_id, e.source_key, e.conversation_id, e.kind, e.text,
				e.facts_json, e.origin, e.created_at,
				w.wake_id, w.state AS wake_state, w.last_error AS wake_error,
				w.settled_at AS wake_settled_at, w.run_id AS wake_run_id
			FROM work_events e
			LEFT JOIN wake_events we ON we.event_id = e.event_id
			LEFT JOIN wake_deliveries w ON w.wake_id = we.wake_id
			WHERE e.event_id IN (
				SELECT event_id FROM work_events
				WHERE responsibility_id = ?
				ORDER BY event_id DESC
				LIMIT ?
			)
			ORDER BY e.event_id`,
		)
		.all(responsibilityId, FEED_EVENT_WINDOW);
	const total = db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM work_events WHERE responsibility_id = ?",
		)
		.get(responsibilityId)!.n;
	return {
		events: rows.map((r) => ({
			eventId: r.event_id,
			sourceKey: r.source_key,
			kind: r.kind,
			text: r.text,
			facts: JSON.parse(r.facts_json) as unknown,
			origin: r.origin,
			createdAt: r.created_at,
			conversationId: r.conversation_id,
			wake:
				r.wake_id === null
					? null
					: {
							wakeId: r.wake_id,
							state: r.wake_state!,
							lastError: r.wake_error,
							settledAt: r.wake_settled_at,
							runId: r.wake_run_id,
						},
		})),
		truncated: total - rows.length,
	};
}

function item(deps: FeedDeps, responsibility: Responsibility): FeedItem {
	const { events, truncated } = feedEvents(deps.db, responsibility.responsibilityId);
	const arm = armedView(responsibility, deps.programs);
	const followup =
		responsibility.followupProgramId === null || deps.programs === undefined
			? null
			: deps.programs.get(Number(responsibility.followupProgramId));
	let nextCheckinAt: string | null = null;
	if (arm.armed && followup?.cron !== null && followup?.nextRun != null) {
		const due = responsibility.followup.dueAt;
		nextCheckinAt =
			Date.parse(followup.nextRun) >= Date.parse(due)
				? followup.nextRun
				: nextFire(
						followup.cron,
						latestFireAtOrBefore(
							followup.cron,
							new Date(followup.nextRun),
							new Date(Date.parse(due) - 1),
						),
					).toISOString();
	}
	const operations = deps.resps.operationsFor(responsibility.responsibilityId);
	const latestReport = deps.resps.latestReport(responsibility.responsibilityId);
	const { posts, truncated: postsTruncated } = feedPosts(deps.db, responsibility);
	return {
		responsibility: {
			...responsibility,
			armed: arm.armed,
			notArmedReason: arm.reason,
		},
		attachments: deps.resps.attachmentsFor(responsibility.responsibilityId),
		operations,
		stage: responsibilityStage(responsibility, latestReport, operations),
		latestReport,
		posts,
		postsTruncated,
		events,
		eventsTruncated: truncated,
		nextCheckinAt,
		nextCheckinReason: nextCheckinAt === null ? null : responsibility.followup.reason,
		// Freshness is the newest of a development and a report: a post filed
		// just now must not read "no activity" because no event carries it.
		lastActivityAt: [
			events.length === 0 ? null : events[events.length - 1]!.createdAt,
			latestReport?.createdAt ?? null,
		].reduce<string | null>((a, b) => (a === null || (b !== null && b > a) ? b : a), null),
	};
}

/** The project feed — every responsibility under one project. */
export function feedForProject(deps: FeedDeps, projectId: string): FeedItem[] {
	return deps.resps.forProject(projectId).map((r) => item(deps, r));
}

/** The home aggregation — open responsibilities across projects,
 *  newest activity first. The client links into the project. */
export function feedOpen(deps: FeedDeps): FeedItem[] {
	return deps.resps
		.open()
		.map((r) => item(deps, r))
		.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}
