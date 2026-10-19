// The project feed read model — one durable surface composed from
// responsibilities, attachments, prompt operations, and work events
// joined to their wake dispositions. Read-only; a page reload reads
// the same durable truth. Delivery failures surface per event via
// the wake join — never inferred from the event alone.

import type { Database } from "bun:sqlite";
import type {
	Attachment,
	PromptOperation,
	Responsibility,
	ResponsibilityStore,
} from "./responsibilities.ts";
import type { ProgramsStore } from "./programs.ts";

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

export interface FeedItem {
	responsibility: Responsibility;
	attachments: Attachment[];
	operations: PromptOperation[];
	events: FeedEvent[];
	/** The linked follow-up Program's next fire — null without one. */
	nextCheckinAt: string | null;
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

function feedEvents(db: Database, responsibilityId: string): FeedEvent[] {
	const rows = db
		.query<EventRow, [string]>(
			`SELECT e.event_id, e.source_key, e.conversation_id, e.kind, e.text,
				e.facts_json, e.origin, e.created_at,
				w.wake_id, w.state AS wake_state, w.last_error AS wake_error,
				w.settled_at AS wake_settled_at, w.run_id AS wake_run_id
			FROM work_events e
			LEFT JOIN wake_events we ON we.event_id = e.event_id
			LEFT JOIN wake_deliveries w ON w.wake_id = we.wake_id
			WHERE e.responsibility_id = ?
			ORDER BY e.event_id`,
		)
		.all(responsibilityId);
	return rows.map((r) => ({
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
	}));
}

function item(deps: FeedDeps, responsibility: Responsibility): FeedItem {
	const events = feedEvents(deps.db, responsibility.responsibilityId);
	const linked =
		responsibility.followupProgramId === null || deps.programs === undefined
			? null
			: deps.programs.get(Number(responsibility.followupProgramId));
	const followup =
		linked !== null && linked.responsibilityId === responsibility.responsibilityId ? linked : null;
	const armed = followup !== null && followup.enabled && responsibility.status === "active";
	return {
		responsibility: {
			...responsibility,
			armed,
			notArmedReason: armed
				? null
				: followup !== null
					? !followup.enabled
						? "follow-up program disabled"
						: `responsibility ${responsibility.status}`
					: responsibility.followupProgramId !== null
						? "follow-up program missing"
						: (responsibility.notArmedReason ?? "follow-up program not linked"),
		},
		attachments: deps.resps.attachmentsFor(responsibility.responsibilityId),
		operations: deps.resps.operationsFor(responsibility.responsibilityId),
		events,
		nextCheckinAt: armed ? followup!.nextRun : null,
		lastActivityAt: events.length === 0 ? null : events[events.length - 1]!.createdAt,
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
