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
		resumedFrom?: string | undefined;
		inheritFrom?: string[] | undefined;
	}): void;
	noteToolInput(runId: string, callId: string, name: string, args: unknown): void;
	noteToolDispatch(runId: string, callId: string, name: string, args: unknown): void;
	noteToolResult(
		runId: string,
		callId: string,
		result: unknown,
		opts?: { replayed?: boolean },
	): void;
	noteToolError(runId: string, callId: string, error: unknown): void;
	checkpoint(
		runId: string,
		patch: { partial?: unknown; loopState?: unknown; filterRetryUsed?: boolean },
	): void;
	finishRun(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	resolveCall(runId: string, callId: string, decision: CallDecision, note?: string): void;
	markRun(runId: string, status: "resumed" | "abandoned"): void;
	replayMap(runId: string): Map<string, unknown[]>;
	skippedMap(runId: string): Map<string, string>;
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
		conv_snapshot, tool_names, started_ms, status, created_at, resumed_from
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`);
	// The chunk seam (planned) and the fence seam (dispatch/result) ride different SDK pipelines — either can commit first, so every write upserts; the only invariant held is that terminal states never move.
	const qInput = db.query(`INSERT INTO turn_tool_calls
		(run_id, tool_call_id, name, args, args_hash, state)
		VALUES (?, ?, ?, ?, ?, 'planned')
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			name = excluded.name, args = excluded.args, args_hash = excluded.args_hash
		WHERE turn_tool_calls.name = ''`);
	const qDispatch = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, began_ms)
		VALUES (?, ?, ?, ?, ?, 'dispatched', ?)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'dispatched', began_ms = excluded.began_ms,
			name = excluded.name, args = excluded.args, args_hash = excluded.args_hash
		WHERE turn_tool_calls.state = 'planned'
			OR (turn_tool_calls.state = 'dispatched' AND turn_tool_calls.name = '')`,
	);
	const qResult = db.query(
		`INSERT INTO turn_tool_calls (run_id, tool_call_id, name, args, args_hash, state, replayed, result, settled_ms)
		VALUES (?, ?, '', 'null', '', 'completed', ?, ?, ?)
		ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
			state = 'completed', replayed = excluded.replayed,
			result = excluded.result, settled_ms = excluded.settled_ms
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
	const qSuccessor = db.query<{ run_id: string }, [string]>(
		"SELECT run_id FROM turn_runs WHERE resumed_from = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
	);
	const qInterrupted = db.query(
		`${RUN_SELECT} WHERE r.status = 'interrupted' ORDER BY r.started_ms, r.run_id`,
	);
	const qCalls = db.query("SELECT * FROM turn_tool_calls WHERE run_id = ? ORDER BY rowid");
	const interruptedAtOpen = stale.map((r) => decodeRun(qGet.get(r.run_id)));
	const qInherit = db.query(
		`INSERT OR IGNORE INTO turn_tool_calls
			(run_id, tool_call_id, name, args, args_hash, state, replayed, result, error,
			 began_ms, settled_ms, resolution_note, resolved_ms)
		 SELECT ?, tool_call_id, name, args, args_hash, state, replayed, result, error,
			began_ms, settled_ms, resolution_note, resolved_ms
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
					qInherit.run(input.runId, pred);
				}
				if (input.resumedFrom === undefined) return;
				const src = qRunStatus.get(input.resumedFrom);
				if (src === null) throw new Error(`resume source run ${input.resumedFrom} is gone`);
				qInherit.run(input.runId, input.resumedFrom);
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
		noteToolDispatch(runId, callId, name, args) {
			const canonical = stableStringify(args);
			qDispatch.run(
				runId,
				callId,
				name,
				boundedArgsText(canonical),
				sha256hex(canonical),
				Date.now(),
			);
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
				if (c.name === "") continue;
				if (c.replayed) continue;
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
		inheritCalls(sourceRunId, intoRunId) {
			qInherit.run(intoRunId, sourceRunId);
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
