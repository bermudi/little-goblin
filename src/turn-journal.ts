import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import { stableStringify } from "./loop-detect.ts";

export type JournalStatus =
	| "running"
	| "interrupted"
	| "fenced"
	| "completed"
	| "error"
	| "resumed"
	| "abandoned";
export type JournalDelivery = "pending" | "delivered" | "undelivered" | "failed";
export type ToolCallState =
	| "planned"
	| "dispatched"
	| "completed"
	| "failed"
	| "resolved-done"
	| "resolved-retry"
	| "resolved-skip";

export type CallDecision = "record-result" | "authorize-retry" | "skip";
const decisionToState: Record<CallDecision, ToolCallState> = {
	"record-result": "resolved-done",
	"authorize-retry": "resolved-retry",
	skip: "resolved-skip",
};

export interface TurnRun {
	runId: string;
	conversationId: string;
	epoch: number;
	anchorSeq: number | null;
	steerMark: number | null;
	convSnapshot: unknown;
	toolNames: string[] | null;
	startedMs: number;
	finishedMs: number | null;
	status: JournalStatus;
	delivery: JournalDelivery;
	partial: unknown | null;
	loopState: unknown | null;
	// The durable user-input seqs this attempt owned at admission plus
	// every steer it folded in — resume reads it to tell the run's own
	// inputs from foreign later ones. NULL = the row predates tracking.
	ownedInputSeqs: number[] | null;
	sourceInputSeq: number | null;
	// True when the column held non-NULL garbage — resume refuses that
	// rather than silently applying the legacy policy.
	ownedInputSeqsUnreadable: boolean;
	// Generated resume-request event seqs registered on this (interrupted)
	// run — the journal-owned trust root for the stale-check exemption;
	// message metadata alone is forgeable. NULL = none registered.
	resumeRequestSeqs: number[] | null;
	// Same policy as ownership: a non-NULL garbage column refuses rather
	// than reading as an empty registry (which would misreport a genuine
	// registered event as foreign input).
	resumeRequestSeqsUnreadable: boolean;
	filterRetryUsed: boolean;
	createdAt: string;
	resumedFrom: string | null;
	calls: {
		planned: number;
		dispatched: number;
		completed: number;
		failed: number;
		resolved: number;
	};
}

export interface TurnToolCall {
	runId: string;
	toolCallId: string;
	name: string;
	args: unknown;
	argsHash: string;
	state: ToolCallState;
	replayed: boolean;
	// True once a resolved-retry grant has been atomically consumed by a
	// successor dispatch. Legacy rows (pre-column) migrate as consumed —
	// they cannot grant a second execution.
	retryConsumed: boolean;
	// True when this resolved-retry was granted on a KNOWN (completed or
	// failed) row rather than an ambiguous dispatched one. The row was
	// never ordinal-bearing, so the grant must not mint an ordinal —
	// numberedCalls excludes these.
	retryFromKnown: boolean;
	result: string | null;
	error: string | null;
	beganMs: number | null;
	settledMs: number | null;
	resolutionNote: string | null;
	resolvedMs: number | null;
}

export interface TurnJournal {
	beginRun(input: {
		runId: string;
		conversationId: string;
		epoch: number;
		anchorSeq: number | null;
		steerMark: number | null;
		convSnapshot: unknown;
		toolNames: string[];
		startedAt: string;
		// The admitted user-entry seqs — real runtime passes them all;
		// undefined keeps backward fixtures at legacy NULL ownership.
		ownedInputSeqs?: number[] | undefined;
		sourceInputSeq?: number | null | undefined;
		resumedFrom?: string | undefined;
		inheritFrom?: string[] | undefined;
	}): void;
	noteToolInput(runId: string, callId: string, name: string, args: unknown): void;
	// retryCallId marks the dispatch as the one execution an operator's
	// resolved-retry granted: the grant's CAS consumption and this
	// dispatch write commit in one transaction.
	noteToolDispatch(
		runId: string,
		callId: string,
		name: string,
		args: unknown,
		opts?: { retryCallId?: string },
	): void;
	noteToolResult(
		runId: string,
		callId: string,
		result: unknown,
		opts?: { replayed?: boolean },
	): void;
	noteToolError(runId: string, callId: string, error: unknown): void;
	checkpoint(
		runId: string,
		patch: {
			partial?: unknown;
			loopState?: unknown;
			filterRetryUsed?: boolean;
			ownedInputSeqs?: number[];
			steerMark?: number;
			sourceInputSeq?: number | null | undefined;
		},
	): void;
	// Registers a generated resume-request event on an interrupted source —
	// the same transaction that appends it to history. Refuses a source
	// that is not interrupted and a registry that does not decode.
	noteResumeRequest(runId: string, eventSeq: number): void;
	finishRun(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	resolveCall(runId: string, callId: string, decision: CallDecision, note?: string): void;
	markRun(runId: string, status: "resumed" | "abandoned"): void;
	inheritCalls(sourceRunId: string, intoRunId: string): void;
	interrupted(): TurnRun[];
	readonly interruptedAtOpen: readonly TurnRun[];
	get(runId: string): TurnRun | null;
	// The newest run admitted as this row's resume continuation — null
	// when none exists. A 'resumed' row's successor insert committed in
	// the same transaction as the mark, and repeated resumes of one
	// source each mint their own (the latest is the live continuation).
	successorOf(runId: string): string | null;
	callsFor(runId: string): TurnToolCall[];
}

const runRowSchema = z.object({
	run_id: z.string(),
	conversation_id: z.string(),
	epoch: z.number(),
	anchor_seq: z.number().nullable(),
	steer_mark: z.number().nullable(),
	conv_snapshot: z.string(),
	tool_names: z.string(),
	started_ms: z.number(),
	finished_ms: z.number().nullable(),
	status: z.enum([
		"running",
		"interrupted",
		"fenced",
		"completed",
		"error",
		"resumed",
		"abandoned",
	]),
	delivery: z.enum(["pending", "delivered", "undelivered", "failed"]),
	partial: z.string().nullable(),
	loop_state: z.string().nullable(),
	owned_input_seqs: z.string().nullable(),
	source_input_seq: z.number().int().positive().nullable(),
	resume_request_seqs: z.string().nullable(),
	filter_retry_used: z.number(),
	created_at: z.string(),
	resumed_from: z.string().nullable(),
	calls_planned: z.number(),
	calls_dispatched: z.number(),
	calls_completed: z.number(),
	calls_failed: z.number(),
	calls_resolved: z.number(),
});

const callRowSchema = z.object({
	run_id: z.string(),
	tool_call_id: z.string(),
	name: z.string(),
	args: z.string(),
	args_hash: z.string(),
	state: z.enum([
		"planned",
		"dispatched",
		"completed",
		"failed",
		"resolved-done",
		"resolved-retry",
		"resolved-skip",
	]),
	replayed: z.number(),
	retry_consumed: z.number(),
	retry_from_known: z.number(),
	result: z.string().nullable(),
	error: z.string().nullable(),
	began_ms: z.number().nullable(),
	settled_ms: z.number().nullable(),
	resolution_note: z.string().nullable(),
	resolved_ms: z.number().nullable(),
});

const RESULT_BUDGET = 8000;
const ARGS_BUDGET = 8000;
const ARGS_TRUNCATED = "[truncated]";
const ERROR_BUDGET = 1000;

function boundedArgsText(canonical: string): string {
	return canonical.length <= ARGS_BUDGET
		? canonical
		: `${canonical.slice(0, ARGS_BUDGET - ARGS_TRUNCATED.length)}${ARGS_TRUNCATED}`;
}

function boundedJson(value: unknown, budget: number): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "undefined";
	} catch {
		text = String(value);
	}
	return text.length <= budget ? text : text.slice(0, budget);
}

function boundedError(error: unknown, budget: number): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.length <= budget ? text : text.slice(0, budget);
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// A call SIGNATURE (name + full canonical-args hash), not execution
// identity: the recovery guard matches new invocations to historical
// calls with it, and the loop detector keys on it.
export function replayKey(name: string, args: unknown): string {
	return `${name}:${sha256hex(stableStringify(args))}`;
}

export const RESOLVED_DONE_EMPTY =
	"[turn-journal decision: outcome recorded by operator — no result text given]";

export const RESOLVED_RETRY_NOTE =
	"[turn-journal decision: previous execution outcome unknown — operator authorized re-running this call]";
export const RESOLVED_SKIP_NOTE =
	"[turn-journal decision: previous execution outcome unknown — operator skipped re-running this call]";

export function recordedOutput(call: TurnToolCall): unknown {
	if (call.result === null) return RESOLVED_DONE_EMPTY;
	return tryParseJson(call.result);
}

function tryParseJson(text: string, ctx?: { run: string; field: string }): unknown {
	try {
		return JSON.parse(text);
	} catch {
		if (ctx !== undefined) {
			log.warn("turn run row field unreadable", { run: ctx.run, field: ctx.field });
		}
		return text;
	}
}

// A JSON seq[] column: absent (NULL), valid, or malformed — the third
// case must stay distinguishable; legacy NULL and corruption are
// different policies at resume. Sequences are durable event seqs —
// positive safe integers — never message ids (those are forgeable).
function decodeSeqList(
	text: string | null,
	runId: string,
	field: string,
): number[] | "malformed" | null {
	if (text === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		log.warn("turn run row field unreadable", { run: runId, field });
		return "malformed";
	}
	const valid = z.array(z.number().int().positive()).safeParse(parsed);
	if (valid.success) return valid.data;
	log.warn("turn run row field unreadable", { run: runId, field });
	return "malformed";
}

function decodeToolNames(text: string, runId: string): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		log.warn("turn run row field unreadable", { run: runId, field: "tool_names" });
		return null;
	}
	const valid = z.array(z.string()).safeParse(parsed);
	if (valid.success) return valid.data;
	log.warn("turn run row field unreadable", { run: runId, field: "tool_names" });
	return null;
}

function decodeRun(raw: unknown): TurnRun {
	const r = runRowSchema.parse(raw);
	const owned = decodeSeqList(r.owned_input_seqs, r.run_id, "owned_input_seqs");
	const resumeRequests = decodeSeqList(r.resume_request_seqs, r.run_id, "resume_request_seqs");
	return {
		runId: r.run_id,
		conversationId: r.conversation_id,
		epoch: r.epoch,
		anchorSeq: r.anchor_seq,
		steerMark: r.steer_mark,
		convSnapshot: tryParseJson(r.conv_snapshot, { run: r.run_id, field: "conv_snapshot" }),
		toolNames: decodeToolNames(r.tool_names, r.run_id),
		startedMs: r.started_ms,
		finishedMs: r.finished_ms,
		status: r.status,
		delivery: r.delivery,
		partial: r.partial === null ? null : tryParseJson(r.partial),
		loopState:
			r.loop_state === null
				? null
				: tryParseJson(r.loop_state, { run: r.run_id, field: "loop_state" }),
		ownedInputSeqs: owned === "malformed" ? null : owned,
		sourceInputSeq: r.source_input_seq,
		ownedInputSeqsUnreadable: owned === "malformed",
		resumeRequestSeqs: resumeRequests === "malformed" ? null : resumeRequests,
		resumeRequestSeqsUnreadable: resumeRequests === "malformed",
		filterRetryUsed: r.filter_retry_used !== 0,
		createdAt: r.created_at,
		resumedFrom: r.resumed_from,
		calls: {
			planned: r.calls_planned,
			dispatched: r.calls_dispatched,
			completed: r.calls_completed,
			failed: r.calls_failed,
			resolved: r.calls_resolved,
		},
	};
}

function decodeCall(raw: unknown): TurnToolCall {
	const r = callRowSchema.parse(raw);
	return {
		runId: r.run_id,
		toolCallId: r.tool_call_id,
		name: r.name,
		args: tryParseJson(boundedArgsText(r.args)),
		argsHash: r.args_hash,
		state: r.state,
		replayed: r.replayed !== 0,
		retryConsumed: r.retry_consumed !== 0,
		retryFromKnown: r.retry_from_known !== 0,
		result: r.result,
		error: r.error,
		beganMs: r.began_ms,
		settledMs: r.settled_ms,
		resolutionNote: r.resolution_note,
		resolvedMs: r.resolved_ms,
	};
}

const RUN_SELECT = `SELECT r.*,
	(SELECT COUNT(*) FROM turn_tool_calls c WHERE c.run_id = r.run_id AND c.state = 'planned') AS calls_planned,
	(SELECT COUNT(*) FROM turn_tool_calls c WHERE c.run_id = r.run_id AND c.state = 'dispatched') AS calls_dispatched,
	(SELECT COUNT(*) FROM turn_tool_calls c WHERE c.run_id = r.run_id AND c.state = 'completed') AS calls_completed,
	(SELECT COUNT(*) FROM turn_tool_calls c WHERE c.run_id = r.run_id AND c.state = 'failed') AS calls_failed,
	(SELECT COUNT(*) FROM turn_tool_calls c WHERE c.run_id = r.run_id AND c.state IN ('resolved-done','resolved-retry','resolved-skip')) AS calls_resolved
	FROM turn_runs r`;

export function openTurnJournal(db: Database): TurnJournal {
	db.run(`CREATE TABLE IF NOT EXISTS turn_runs (
		run_id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		epoch INTEGER NOT NULL,
		anchor_seq INTEGER,
		steer_mark INTEGER,
		conv_snapshot TEXT NOT NULL,
		tool_names TEXT NOT NULL,
		started_ms INTEGER NOT NULL,
		finished_ms INTEGER,
		status TEXT NOT NULL,
		delivery TEXT NOT NULL DEFAULT 'pending',
		partial TEXT,
		loop_state TEXT,
		filter_retry_used INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		resumed_from TEXT
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS turn_tool_calls (
		run_id TEXT NOT NULL REFERENCES turn_runs(run_id) ON DELETE CASCADE,
		tool_call_id TEXT NOT NULL,
		name TEXT NOT NULL,
		args TEXT NOT NULL,
		args_hash TEXT NOT NULL,
		state TEXT NOT NULL,
		replayed INTEGER NOT NULL DEFAULT 0,
		retry_consumed INTEGER NOT NULL DEFAULT 0,
		retry_from_known INTEGER NOT NULL DEFAULT 0,
		origin_run TEXT,
		result TEXT,
		error TEXT,
		began_ms INTEGER,
		settled_ms INTEGER,
		resolution_note TEXT,
		resolved_ms INTEGER,
		PRIMARY KEY (run_id, tool_call_id)
	)`);
	const runCols = new Set(
		(db.query("PRAGMA table_info(turn_runs)").all() as { name: string }[]).map((c) => c.name),
	);
	if (!runCols.has("resumed_from")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN resumed_from TEXT");
	}
	if (!runCols.has("owned_input_seqs")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN owned_input_seqs TEXT");
	}
	if (!runCols.has("resume_request_seqs")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN resume_request_seqs TEXT");
	}
	if (!runCols.has("source_input_seq")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN source_input_seq INTEGER");
	}
	const callCols = new Set(
		(db.query("PRAGMA table_info(turn_tool_calls)").all() as { name: string }[]).map((c) => c.name),
	);
	if (!callCols.has("resolution_note")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN resolution_note TEXT");
	}
	if (!callCols.has("resolved_ms")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN resolved_ms INTEGER");
	}
	if (!callCols.has("replayed")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0");
	}
	// Existing rows default consumed: whether a pre-migration resolved-retry
	// was already spent is unknowable, so legacy grants fail closed.
	if (!callCols.has("retry_consumed")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN retry_consumed INTEGER NOT NULL DEFAULT 1");
	}
	// Pre-column resolved-retry rows were all granted on dispatched
	// ambiguity — grants on known calls postdate the column — so 0 is the
	// exact default, not a guess.
	if (!callCols.has("retry_from_known")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN retry_from_known INTEGER NOT NULL DEFAULT 0");
	}
	// The origin run of an inherited evidence copy — NULL for a call this
	// run made itself. Rows copied before the column existed read NULL
	// and take their immediate source's namespace at the next copy.
	if (!callCols.has("origin_run")) {
		db.exec("ALTER TABLE turn_tool_calls ADD COLUMN origin_run TEXT");
	}
	const stale = db
		.query<{ run_id: string; conversation_id: string; started_ms: number }, [number]>(
			"UPDATE turn_runs SET status = 'interrupted', finished_ms = ? WHERE status = 'running' RETURNING run_id, conversation_id, started_ms",
		)
		.all(Date.now());
	if (stale.length > 0) {
		for (const r of stale) {
			log.warn("interrupted turn found", {
				run: r.run_id,
				conversation: r.conversation_id,
				started: new Date(r.started_ms).toISOString(),
			});
		}
	}

	const qBegin = db.query(`INSERT INTO turn_runs (
		run_id, conversation_id, epoch, anchor_seq, steer_mark,
		conv_snapshot, tool_names, started_ms, status, created_at, resumed_from,
		owned_input_seqs, source_input_seq
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`);
	// The registry lives on the interrupted source row — a generated
	// resume event is trusted only when the source named it.
	const qNoteResume = db.query(
		"UPDATE turn_runs SET resume_request_seqs = ? WHERE run_id = ? AND status = 'interrupted'",
	);
	// The chunk seam (planned) and the fence seam (dispatch/result) ride different SDK pipelines — either can commit first, so every write upserts; the only invariant held is that terminal states never move.
	const qInput = db.query(`INSERT INTO turn_tool_calls
		(run_id, tool_call_id, name, args, args_hash, state, retry_consumed)
		VALUES (?, ?, ?, ?, ?, 'planned', 0)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			name = excluded.name, args = excluded.args, args_hash = excluded.args_hash
		WHERE turn_tool_calls.name = ''`);
	const qDispatch = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, began_ms, retry_consumed)
		VALUES (?, ?, ?, ?, ?, 'dispatched', ?, 0)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'dispatched', began_ms = excluded.began_ms,
			name = excluded.name, args = excluded.args, args_hash = excluded.args_hash
		WHERE turn_tool_calls.state = 'planned'
			OR (turn_tool_calls.state = 'dispatched' AND turn_tool_calls.name = '')`,
	);
	const qResult = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, replayed, result, settled_ms, retry_consumed)
		VALUES (?, ?, '', 'null', '', 'completed', ?, ?, ?, 0)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'completed', replayed = excluded.replayed,
			result = excluded.result, settled_ms = excluded.settled_ms
		WHERE turn_tool_calls.state IN ('planned', 'dispatched')`,
	);
	const qError = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, error, settled_ms, retry_consumed)
		VALUES (?, ?, '', 'null', '', 'failed', ?, ?, 0)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'failed', error = excluded.error, settled_ms = excluded.settled_ms
		WHERE turn_tool_calls.state IN ('planned', 'dispatched')`,
	);
	const qFinish = db.query(
		"UPDATE turn_runs SET status = ?, delivery = ?, finished_ms = ? WHERE run_id = ?",
	);
	const qCallState = db.query<{ state: string; replayed: number }, [string, string]>(
		"SELECT state, replayed FROM turn_tool_calls WHERE run_id = ? AND tool_call_id = ?",
	);
	const qResolve = db.query(
		`UPDATE turn_tool_calls SET state = ?, resolution_note = ?, result = ?, resolved_ms = ?
		WHERE run_id = ? AND tool_call_id = ? AND state = 'dispatched'`,
	);
	// authorize-retry reaches known calls too — dispatched ambiguity plus
	// completed/failed/resolved-done executions. The recorded
	// result/error columns stay: a grant is about one more execution,
	// not about erasing what happened. A fresh grant also REOPENS the
	// consumed bit — a migrated row reads consumed by default, and the
	// operator's new decision is what re-arms it. retry_from_known marks
	// grants that converted a formerly-unnumbered row, so the ordinal
	// list stays stable.
	const qResolveRetry = db.query(
		`UPDATE turn_tool_calls SET state = 'resolved-retry', resolution_note = ?, resolved_ms = ?,
			retry_consumed = 0,
			retry_from_known = CASE WHEN state IN ('completed','failed') THEN 1 ELSE retry_from_known END
		WHERE run_id = ? AND tool_call_id = ?
			AND state IN ('dispatched','completed','failed','resolved-done')
			AND replayed = 0`,
	);
	// One-time grant consumption: the named source call must be an
	// unconsumed resolved-retry whose name+full-args signature matches
	// this dispatch.
	const qConsumeRetry = db.query(
		`UPDATE turn_tool_calls SET retry_consumed = 1
		WHERE run_id = ? AND tool_call_id = ? AND state = 'resolved-retry'
			AND retry_consumed = 0 AND name = ? AND args_hash = ?`,
	);
	const qRunStatus = db.query<{ status: string }, [string]>(
		"SELECT status FROM turn_runs WHERE run_id = ?",
	);
	const qMark = db.query(
		`UPDATE turn_runs SET status = ?, finished_ms = COALESCE(finished_ms, ?)
		WHERE run_id = ? AND status = 'interrupted'`,
	);
	const qGet = db.query(`${RUN_SELECT} WHERE r.run_id = ?`);
	const qSuccessor = db.query<{ run_id: string }, [string]>(
		"SELECT run_id FROM turn_runs WHERE resumed_from = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
	);
	const qInterrupted = db.query(
		`${RUN_SELECT} WHERE r.status = 'interrupted' ORDER BY r.started_ms, r.run_id`,
	);
	const qCalls = db.query("SELECT * FROM turn_tool_calls WHERE run_id = ? ORDER BY rowid");
	const interruptedAtOpen = stale.map((r) => decodeRun(qGet.get(r.run_id)));
	// Inherited evidence copies are namespaced by their ORIGIN run, never
	// carried under the raw provider id. The primary key (run_id,
	// tool_call_id) spans both the inherited copies and this attempt's
	// own calls, and providers that number tool-call ids per response
	// (the part-id precedent at turn/stream.ts) hand the successor's
	// fresh execution an id a terminal inherited row already holds —
	// every upsert guard then silently drops that execution's records,
	// and the retry-grant target check hard-fails the turn. Keying the
	// copy on COALESCE(origin_run, source) keeps the namespace idempotent
	// across hops: one piece of evidence copied along two paths (a
	// continuation inherits both the failed attempt and the resume
	// source) lands on a single row — first insert wins, so the more
	// settled copy keeps beating the stale one — while the successor's
	// own calls never collide with evidence. A namespaced row stores its
	// origin and its id as `<origin>:<raw>`, so the raw id survives every
	// hop: re-prefixing strips the stored origin's prefix first. Rows
	// copied before origin_run existed read NULL and take their immediate
	// source's namespace at the next copy. A provider emitting an id that
	// already reads as `<run-id>:<id>` would re-enter the namespace;
	// provider ids are not run-id-shaped.
	const qInherit = db.query(
		`INSERT OR IGNORE INTO turn_tool_calls
			(run_id, tool_call_id, name, args, args_hash, state, replayed, result, error,
			 began_ms, settled_ms, resolution_note, resolved_ms, retry_consumed, retry_from_known, origin_run)
		 SELECT ?,
			COALESCE(origin_run, ?) || ':' ||
				CASE WHEN origin_run IS NULL THEN tool_call_id
					ELSE SUBSTR(tool_call_id, LENGTH(origin_run) + 2) END,
			name, args, args_hash, state, replayed, result, error,
			began_ms, settled_ms, resolution_note, resolved_ms, retry_consumed, retry_from_known,
			COALESCE(origin_run, ?)
		 FROM turn_tool_calls WHERE run_id = ? AND state != 'dispatched'`,
	);

	return {
		beginRun(input) {
			const insert = (): void => {
				qBegin.run(
					input.runId,
					input.conversationId,
					input.epoch,
					input.anchorSeq,
					input.steerMark,
					JSON.stringify(input.convSnapshot),
					JSON.stringify(input.toolNames),
					Date.parse(input.startedAt),
					input.startedAt,
					input.resumedFrom ?? null,
					input.ownedInputSeqs === undefined ? null : JSON.stringify(input.ownedInputSeqs),
					input.sourceInputSeq ?? null,
				);
			};
			if (input.resumedFrom === undefined && (input.inheritFrom?.length ?? 0) === 0) {
				insert();
				return;
			}
			let resumedMarked = false;
			db.transaction(() => {
				insert();
				for (const pred of input.inheritFrom ?? []) {
					if (qRunStatus.get(pred) === null) {
						throw new Error(`inherit predecessor run ${pred} is gone`);
					}
					qInherit.run(input.runId, pred, pred, pred);
				}
				if (input.resumedFrom === undefined) return;
				const src = qRunStatus.get(input.resumedFrom);
				if (src === null) throw new Error(`resume source run ${input.resumedFrom} is gone`);
				qInherit.run(input.runId, input.resumedFrom, input.resumedFrom, input.resumedFrom);
				if (src.status === "interrupted") {
					qMark.run("resumed", Date.now(), input.resumedFrom);
					resumedMarked = true;
				} else if (src.status !== "resumed") {
					throw new Error(
						`resume source run ${input.resumedFrom} is '${src.status}' — refusing to continue it`,
					);
				}
			})();
			if (resumedMarked) {
				log.info("interrupted run marked", { run: input.resumedFrom, status: "resumed" });
			}
		},
		noteToolInput(runId, callId, name, args) {
			const canonical = stableStringify(args);
			qInput.run(runId, callId, name, boundedArgsText(canonical), sha256hex(canonical));
		},
		noteToolDispatch(runId, callId, name, args, opts) {
			const canonical = stableStringify(args);
			const argsHash = sha256hex(canonical);
			if (opts?.retryCallId === undefined) {
				qDispatch.run(runId, callId, name, boundedArgsText(canonical), argsHash, Date.now());
				return;
			}
			const retryCallId = opts.retryCallId;
			db.transaction(() => {
				// The target row may already exist as 'planned' (the model's
				// chunk seam wrote it); anything further along means the
				// dispatch already landed — refuse to double-book it.
				const target = qCallState.get(runId, callId);
				if (target !== null && target.state !== "planned") {
					throw new Error(`retry dispatch ${callId} on run ${runId} is already '${target.state}'`);
				}
				const consumed = qConsumeRetry.run(runId, retryCallId, name, argsHash);
				if (consumed.changes !== 1) {
					throw new Error(
						`retry grant ${retryCallId} on run ${runId} is not an unconsumed matching ` +
							`resolved-retry — refusing to execute`,
					);
				}
				qDispatch.run(runId, callId, name, boundedArgsText(canonical), argsHash, Date.now());
			})();
			log.info("operator-authorized retry consumed", {
				run: runId,
				call: callId,
				source: retryCallId,
			});
		},
		noteToolResult(runId, callId, result, opts) {
			qResult.run(
				runId,
				callId,
				opts?.replayed === true ? 1 : 0,
				boundedJson(result, RESULT_BUDGET),
				Date.now(),
			);
		},
		noteToolError(runId, callId, error) {
			qError.run(runId, callId, boundedError(error, ERROR_BUDGET), Date.now());
		},
		checkpoint(runId, patch) {
			const sets: string[] = [];
			const vals: (string | number | null)[] = [];
			if (patch.partial !== undefined) {
				sets.push("partial = ?");
				vals.push(boundedJson(patch.partial, RESULT_BUDGET));
			}
			if (patch.loopState !== undefined) {
				sets.push("loop_state = ?");
				vals.push(JSON.stringify(patch.loopState));
			}
			if (patch.filterRetryUsed !== undefined) {
				sets.push("filter_retry_used = ?");
				vals.push(patch.filterRetryUsed ? 1 : 0);
			}
			if (patch.ownedInputSeqs !== undefined) {
				sets.push("owned_input_seqs = ?");
				vals.push(JSON.stringify(patch.ownedInputSeqs));
			}
			if (patch.steerMark !== undefined) {
				sets.push("steer_mark = ?");
				vals.push(patch.steerMark);
			}
			if (patch.sourceInputSeq !== undefined) {
				sets.push("source_input_seq = ?");
				vals.push(patch.sourceInputSeq);
			}
			if (sets.length === 0) return;
			db.run(`UPDATE turn_runs SET ${sets.join(", ")} WHERE run_id = ?`, [...vals, runId]);
		},
		noteResumeRequest(runId, eventSeq) {
			const row = db
				.query<{ status: string; resume_request_seqs: string | null }, [string]>(
					"SELECT status, resume_request_seqs FROM turn_runs WHERE run_id = ?",
				)
				.get(runId);
			if (row === null) throw new Error(`no turn run ${runId}`);
			if (row.status !== "interrupted") {
				throw new Error(
					`run ${runId} is '${row.status}' — only 'interrupted' runs take resume requests`,
				);
			}
			// A bad seq would write a registry the reader can never
			// decode — decodeSeqList rejects non-positive integers, so the
			// next read flips the whole column to unreadable.
			if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0) {
				throw new Error(`resume request seq ${eventSeq} is not a durable event seq`);
			}
			const decoded = decodeSeqList(row.resume_request_seqs, runId, "resume_request_seqs");
			if (decoded === "malformed") {
				throw new Error(`run ${runId} resume request registry is unreadable`);
			}
			const written = qNoteResume.run(JSON.stringify([...(decoded ?? []), eventSeq]), runId);
			// The guarded UPDATE matching zero rows means the run left
			// 'interrupted' since the check above — logging success would
			// leave an unregistered event reading as foreign input.
			if (written.changes !== 1) {
				throw new Error(`run ${runId} left 'interrupted' — resume request not registered`);
			}
			log.info("resume request registered on interrupted run", {
				run: runId,
				seq: eventSeq,
			});
		},
		finishRun(runId, status, delivery) {
			qFinish.run(status, delivery, Date.now(), runId);
		},
		resolveCall(runId, callId, decision, note) {
			const row = qCallState.get(runId, callId);
			if (row === null) {
				throw new Error(`no tool call ${callId} on run ${runId}`);
			}
			if (decision === "authorize-retry") {
				// Known calls can be granted another execution — the row's
				// recorded result/error stays evidence. A synthetic journaled
				// (replayed) row never grants; a resolved-* row takes no new
				// decision — its successor's dispatched call owns ambiguity.
				if (row.replayed !== 0) {
					throw new Error(
						`call ${callId} on run ${runId} is a journaled recovery row — it cannot take a decision`,
					);
				}
				// The run-status check and the grant commit in one
				// transaction — a run that left 'interrupted' between the
				// listing and this write takes no new decision.
				db.transaction(() => {
					const run = qRunStatus.get(runId);
					if (run === null) throw new Error(`no turn run ${runId}`);
					if (run.status !== "interrupted") {
						throw new Error(
							`run ${runId} is '${run.status}' — only 'interrupted' runs take decisions`,
						);
					}
					if (qResolveRetry.run(note ?? null, Date.now(), runId, callId).changes !== 1) {
						throw new Error(
							`call ${callId} on run ${runId} is '${row.state}' — authorize-retry needs a ` +
								`'dispatched', 'completed', 'failed' or 'resolved-done' call`,
						);
					}
				})();
				log.info("interrupted tool call resolved", { run: runId, call: callId, decision });
				return;
			}
			if (row.state !== "dispatched") {
				throw new Error(
					`call ${callId} on run ${runId} is '${row.state}' — only 'dispatched' calls take a decision`,
				);
			}
			qResolve.run(
				decisionToState[decision],
				note ?? null,
				decision === "record-result" && note !== undefined
					? boundedJson(note, RESULT_BUDGET)
					: null,
				Date.now(),
				runId,
				callId,
			);
			log.info("interrupted tool call resolved", { run: runId, call: callId, decision });
		},
		markRun(runId, status) {
			const row = qRunStatus.get(runId);
			if (row === null) throw new Error(`no turn run ${runId}`);
			if (row.status !== "interrupted") {
				throw new Error(
					`run ${runId} is '${row.status}' — only 'interrupted' runs take '${status}'`,
				);
			}
			qMark.run(status, Date.now(), runId);
			log.info("interrupted run marked", { run: runId, status });
		},
		inheritCalls(sourceRunId, intoRunId) {
			qInherit.run(intoRunId, sourceRunId, sourceRunId, sourceRunId);
		},
		interrupted() {
			return qInterrupted.all().map(decodeRun);
		},
		interruptedAtOpen,
		get(runId) {
			const raw = qGet.get(runId);
			return raw === null ? null : decodeRun(raw);
		},
		successorOf(runId) {
			return qSuccessor.get(runId)?.run_id ?? null;
		},
		callsFor(runId) {
			return qCalls.all(runId).map(decodeCall);
		},
	};
}
