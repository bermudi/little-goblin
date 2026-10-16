// The crash journal (design/runtime-turn.md → The turn journal): the
// durable record of what an admitted turn owned and how far each tool
// call got before the process died. Shares the conversation store's
// SQLite handle like the tg inbox — a run row and the history its turn
// answers live on the same file, same WAL, same crash boundary.
//
// A turn's row exists BEFORE any tool side effect can run; tool calls
// move planned → dispatched → completed|failed. `dispatched` with no
// result is the ambiguous state — execute was entered, so the side
// effect may or may not have landed. Rows still `running` at open mean
// the process died mid-turn (a graceful shutdown fences first): they
// reclassify `interrupted` at open and are surfaced to the operator,
// never replayed.
//
// The resume path (src/turn-resume.ts) is the only way out of
// `interrupted`: the operator resolves each `dispatched` call into
// `resolved-done` (asserted outcome recorded as the replayable
// result), `resolved-retry`, or `resolved-skip`, then a fresh admission
// re-runs the turn — the fence replays recorded results for completed
// and resolved-done calls instead of executing. The source row ends
// `resumed` (or `abandoned` when the operator drops it); both are
// terminal for resume.

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
// `dispatched` means still ambiguous — a resolved-* state is the
// operator's decision landed on that ambiguity, not a settlement the
// SDK observed.
export type ToolCallState =
	| "planned"
	| "dispatched"
	| "completed"
	| "failed"
	| "resolved-done"
	| "resolved-retry"
	| "resolved-skip";

// The operator's vocabulary for a crash-ambiguous call — what the
// surfaces take (/decide, the app route); the resolved-* states are
// where each lands.
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
	// The admission-time settings snapshot (model, thinking) as JSON.
	convSnapshot: unknown;
	toolNames: string[];
	startedMs: number;
	finishedMs: number | null;
	status: JournalStatus;
	delivery: JournalDelivery;
	// Richest durable assistant-partial snapshot (for a future resume);
	// null when nothing useful accumulated before the end.
	partial: unknown | null;
	loopState: unknown | null;
	filterRetryUsed: boolean;
	createdAt: string;
	// The interrupted run this admission resumed — provenance only; the
	// source row keeps its own record.
	resumedFrom: string | null;
	// Per-state call counts — `dispatched` is the still-ambiguous
	// bucket; `resolved` holds every operator-decided call.
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
	// Bounded JSON text (~8000 chars) — possibly cut mid-document, so
	// kept as text rather than promised-parseable JSON.
	result: string | null;
	// Error name + message, bounded (~1000 chars). Never a stack.
	error: string | null;
	beganMs: number | null;
	settledMs: number | null;
	// The operator's decision record on a crash-ambiguous call — the
	// note they gave (null = none) and when it landed.
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
		// Operator-resume admissions link their fresh run row to the
		// interrupted source run they continue.
		resumedFrom?: string | undefined;
	}): void;
	// The stream saw the model's call. Upsert: a retried step
	// re-emitting the same call id can't duplicate or rewrite the row,
	// and if a fence-seam write beat the chunk to the row, this fills
	// its marker identity (name/args/hash) without touching the state.
	noteToolInput(runId: string, callId: string, name: string, args: unknown): void;
	// execute was entered. Upsert with the same marker shape — the SDK's
	// execution pipeline can commit before the chunk seam lands; a
	// settled row never regresses.
	noteToolDispatch(runId: string, callId: string): void;
	// The result, recorded before the loop continues. Upsert guards on
	// unsettled states so a late duplicate can't rewrite a settled call.
	noteToolResult(runId: string, callId: string, result: unknown): void;
	noteToolError(runId: string, callId: string, error: unknown): void;
	// Patch the nullable progress columns — only provided keys move.
	checkpoint(
		runId: string,
		patch: { partial?: unknown; loopState?: unknown; filterRetryUsed?: boolean },
	): void;
	// Terminal stamp. 'fenced' and 'error' are distinct outcomes — a
	// fenced turn was cancelled, an errored one failed.
	finishRun(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	// The operator's decision on a crash-ambiguous call. Only a
	// 'dispatched' row moves — every other state throws.
	// 'record-result' stores the operator's asserted outcome as the
	// call's replayable result; 'authorize-retry' and 'skip' leave
	// `result` NULL — the resolution itself is the note.
	resolveCall(runId: string, callId: string, decision: CallDecision, note?: string): void;
	// The operator lifecycle moves out of 'interrupted' — 'resumed' when
	// a fresh admission takes the turn over, 'abandoned' when it never
	// will. Terminal; only 'interrupted' rows accept them.
	markRun(runId: string, status: "resumed" | "abandoned"): void;
	// name:argsHash → recorded outputs (FIFO per key) for calls a resume
	// may replay — completed and resolved-done only. Rebuilt per call;
	// the fence consumes one entry per matching dispatch.
	replayMap(runId: string): Map<string, unknown[]>;
	// name:argsHash → refusal text for resolved-skip calls: the
	// operator declined the side effect, so a resumed turn answers a
	// re-ask with the decision instead of executing it.
	skippedMap(runId: string): Map<string, string>;
	interrupted(): TurnRun[];
	get(runId: string): TurnRun | null;
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
	result: z.string().nullable(),
	error: z.string().nullable(),
	began_ms: z.number().nullable(),
	settled_ms: z.number().nullable(),
	resolution_note: z.string().nullable(),
	resolved_ms: z.number().nullable(),
});

const RESULT_BUDGET = 8000;
const ERROR_BUDGET = 1000;

// Bounded JSON for the result column — full fidelity up to the cap,
// String() rather than a throw on unserializable values. A truncated
// document is stored as cut text, so readers must not assume it parses.
function boundedJson(value: unknown, budget: number): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "undefined";
	} catch {
		text = String(value);
	}
	return text.length <= budget ? text : text.slice(0, budget);
}

// Name + message, never a stack — the journal row is an index into
// goblin.log, which carries the full error.
function boundedError(error: unknown, budget: number): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.length <= budget ? text : text.slice(0, budget);
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// The fence's replay-map key for one tool execution: registered name +
// canonical-args hash — the same recipe the journal's args_hash column
// stores, so a re-emitted call matches its recorded row.
export function replayKey(name: string, args: unknown): string {
	return `${name}:${sha256hex(stableStringify(args))}`;
}

// What a resolved-done call replays when the operator asserted the
// outcome without result text — honest, visible, and never executes.
export const RESOLVED_DONE_EMPTY =
	"[turn-journal decision: outcome recorded by operator — no result text given]";

// The model-visible record of a decided call, used as the seeded
// partial's answer and — for a skip — as the fence's refusal when the
// resumed model re-asks for the declined call.
export const RESOLVED_RETRY_NOTE =
	"[turn-journal decision: previous execution outcome unknown — operator authorized re-running this call]";
export const RESOLVED_SKIP_NOTE =
	"[turn-journal decision: previous execution outcome unknown — operator skipped re-running this call]";

// A call's recorded output as resume readers see it: parsed JSON when
// the stored text survived whole, the raw cut text when it didn't, and
// the explicit marker for a note-less resolved-done.
export function recordedOutput(call: TurnToolCall): unknown {
	if (call.result === null) return RESOLVED_DONE_EMPTY;
	return tryParseJson(call.result);
}

// `partial` is stored bounded — a cut document must not crash readers,
// so an unparseable one comes back as its raw text (a resume reader
// sees a string where messages were expected and knows it's unusable).
function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function decodeRun(raw: unknown): TurnRun {
	const r = runRowSchema.parse(raw);
	return {
		runId: r.run_id,
		conversationId: r.conversation_id,
		epoch: r.epoch,
		anchorSeq: r.anchor_seq,
		steerMark: r.steer_mark,
		convSnapshot: JSON.parse(r.conv_snapshot),
		toolNames: z.array(z.string()).parse(JSON.parse(r.tool_names)),
		startedMs: r.started_ms,
		finishedMs: r.finished_ms,
		status: r.status,
		delivery: r.delivery,
		partial: r.partial === null ? null : tryParseJson(r.partial),
		loopState: r.loop_state === null ? null : (JSON.parse(r.loop_state) as unknown),
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
		args: JSON.parse(r.args) as unknown,
		argsHash: r.args_hash,
		state: r.state,
		result: r.result,
		error: r.error,
		beganMs: r.began_ms,
		settledMs: r.settled_ms,
		resolutionNote: r.resolution_note,
		resolvedMs: r.resolved_ms,
	};
}

// Run row plus its per-state call counts — every reader gets the same
// shape so `dispatched > 0` is always answerable from a TurnRun.
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
		result TEXT,
		error TEXT,
		began_ms INTEGER,
		settled_ms INTEGER,
		resolution_note TEXT,
		resolved_ms INTEGER,
		PRIMARY KEY (run_id, tool_call_id)
	)`);
	// The tables predate the resume columns — CREATE covers a fresh
	// database, ALTER fills an existing one.
	const runCols = new Set(
		(db.query("PRAGMA table_info(turn_runs)").all() as { name: string }[]).map((c) => c.name),
	);
	if (!runCols.has("resumed_from")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN resumed_from TEXT");
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
	// A graceful shutdown fences live rows before it dies, so 'running'
	// at open means the process was killed mid-turn — SIGKILL, OOM, host
	// power. Reclassify, log each, leave the rows for the boot notice.
	const stale = db
		.query<{ run_id: string; conversation_id: string; started_ms: number }, []>(
			"SELECT run_id, conversation_id, started_ms FROM turn_runs WHERE status = 'running'",
		)
		.all();
	if (stale.length > 0) {
		db.run(
			"UPDATE turn_runs SET status = 'interrupted', finished_ms = ? WHERE status = 'running'",
			[Date.now()],
		);
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
		conv_snapshot, tool_names, started_ms, status, created_at, resumed_from
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`);
	// The chunk seam (planned) and the fence seam (dispatch/result) ride
	// different SDK pipelines — either can commit first. Every write is
	// an upsert: a missing row gets marker identity (name '', args JSON
	// null so decode still parses), and the planned write fills identity
	// into a marker row whenever it arrives. The only invariant held is
	// settlement: terminal states never move.
	const qInput = db.query(`INSERT INTO turn_tool_calls
		(run_id, tool_call_id, name, args, args_hash, state)
		VALUES (?, ?, ?, ?, ?, 'planned')
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			name = excluded.name, args = excluded.args, args_hash = excluded.args_hash
		WHERE turn_tool_calls.name = ''`);
	const qDispatch = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, began_ms)
		VALUES (?, ?, '', 'null', '', 'dispatched', ?)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'dispatched', began_ms = excluded.began_ms
		WHERE turn_tool_calls.state = 'planned'`,
	);
	// The blind-insert half (a result whose planned row never landed —
	// the stream was cut before the chunk) marks the unknowns — args as
	// JSON null so decode still parses; the conflict half only moves
	// unsettled rows.
	const qResult = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, result, settled_ms)
		VALUES (?, ?, '', 'null', '', 'completed', ?, ?)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'completed', result = excluded.result, settled_ms = excluded.settled_ms
		WHERE turn_tool_calls.state IN ('planned', 'dispatched')`,
	);
	const qError = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, error, settled_ms)
		VALUES (?, ?, '', 'null', '', 'failed', ?, ?)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'failed', error = excluded.error, settled_ms = excluded.settled_ms
		WHERE turn_tool_calls.state IN ('planned', 'dispatched')`,
	);
	const qFinish = db.query(
		"UPDATE turn_runs SET status = ?, delivery = ?, finished_ms = ? WHERE run_id = ?",
	);
	// Resolved-* states are terminal like completed/failed: qResult and
	// qError's WHERE already exclude them, so a late stream write can
	// never overwrite an operator decision.
	const qCallState = db.query<{ state: string }, [string, string]>(
		"SELECT state FROM turn_tool_calls WHERE run_id = ? AND tool_call_id = ?",
	);
	const qResolve = db.query(
		`UPDATE turn_tool_calls SET state = ?, resolution_note = ?, result = ?, resolved_ms = ?
		WHERE run_id = ? AND tool_call_id = ? AND state = 'dispatched'`,
	);
	const qRunStatus = db.query<{ status: string }, [string]>(
		"SELECT status FROM turn_runs WHERE run_id = ?",
	);
	const qMark = db.query(
		`UPDATE turn_runs SET status = ?, finished_ms = COALESCE(finished_ms, ?)
		WHERE run_id = ? AND status = 'interrupted'`,
	);
	const qGet = db.query(`${RUN_SELECT} WHERE r.run_id = ?`);
	const qInterrupted = db.query(
		`${RUN_SELECT} WHERE r.status = 'interrupted' ORDER BY r.started_ms, r.run_id`,
	);
	const qCalls = db.query("SELECT * FROM turn_tool_calls WHERE run_id = ? ORDER BY rowid");

	return {
		beginRun(input) {
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
			);
		},
		noteToolInput(runId, callId, name, args) {
			const canonical = stableStringify(args);
			qInput.run(runId, callId, name, canonical, sha256hex(canonical));
		},
		noteToolDispatch(runId, callId) {
			qDispatch.run(runId, callId, Date.now());
		},
		noteToolResult(runId, callId, result) {
			qResult.run(runId, callId, boundedJson(result, RESULT_BUDGET), Date.now());
		},
		noteToolError(runId, callId, error) {
			qError.run(runId, callId, boundedError(error, ERROR_BUDGET), Date.now());
		},
		checkpoint(runId, patch) {
			const sets: string[] = [];
			const vals: (string | number)[] = [];
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
			if (sets.length === 0) return;
			db.run(`UPDATE turn_runs SET ${sets.join(", ")} WHERE run_id = ?`, [...vals, runId]);
		},
		finishRun(runId, status, delivery) {
			qFinish.run(status, delivery, Date.now(), runId);
		},
		resolveCall(runId, callId, decision, note) {
			const row = qCallState.get(runId, callId);
			if (row === null) {
				throw new Error(`no tool call ${callId} on run ${runId}`);
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
		replayMap(runId) {
			const map = new Map<string, unknown[]>();
			for (const c of qCalls.all(runId).map(decodeCall)) {
				if (c.name === "") continue; // marker rows carry no call identity
				if (c.state !== "completed" && c.state !== "resolved-done") continue;
				const queue = map.get(`${c.name}:${c.argsHash}`);
				const output = recordedOutput(c);
				if (queue === undefined) map.set(`${c.name}:${c.argsHash}`, [output]);
				else queue.push(output);
			}
			return map;
		},
		skippedMap(runId) {
			const map = new Map<string, string>();
			for (const c of qCalls.all(runId).map(decodeCall)) {
				if (c.name === "" || c.state !== "resolved-skip") continue;
				const note =
					c.resolutionNote === null
						? RESOLVED_SKIP_NOTE
						: `${RESOLVED_SKIP_NOTE} — ${c.resolutionNote}`;
				map.set(`${c.name}:${c.argsHash}`, note);
			}
			return map;
		},
		interrupted() {
			return qInterrupted.all().map(decodeRun);
		},
		get(runId) {
			const raw = qGet.get(runId);
			return raw === null ? null : decodeRun(raw);
		},
		callsFor(runId) {
			return qCalls.all(runId).map(decodeCall);
		},
	};
}
