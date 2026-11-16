import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withoutReasoningCipher } from "./agent/codex/replay-state.ts";
import { parseEvent } from "./conversation-events.ts";
import { log } from "./log.ts";
import { stableStringify } from "./loop-detect.ts";
import { isMachineryText } from "./tags.ts";

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

// The run row's step checkpoint — what the tool-authority seam's saveStep
// (#195) persists as each step ends: the assistant partial, the loop
// state, and the steer-fold ownership writes ride the same patch.
export interface TurnCheckpointPatch {
	partial?: unknown;
	loopState?: unknown;
	filterRetryUsed?: boolean;
	ownedInputSeqs?: number[];
	steerMark?: number;
	sourceInputSeq?: number | null | undefined;
}

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
	// every steer it folded in — the unlanded-progress anchor and the
	// stranded-input count read it to tell a run's own inputs from
	// foreign later ones. NULL = the row predates tracking.
	ownedInputSeqs: number[] | null;
	admissionExchangeExcluded: boolean;
	sourceInputSeq: number | null;
	filterRetryUsed: boolean;
	// The durable reply committed with this stamp — one transaction, so
	// the fact can never lag the message. Boot recovery's interrupted
	// rail reads it as "the reply is the record": no 'no final reply'
	// progress event over a reply that is history. NULL on pre-column
	// rows reads false — those runs genuinely never recorded it.
	replyLanded: boolean;
	// The landed reply's event seq — recorded in the same stamp so boot
	// recovery can re-deliver the exact message. NULL on pre-column rows:
	// the reply exists but cannot be identified, so they fall back to the
	// interrupted notice.
	replySeq: number | null;
	createdAt: string;
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
	// True when this resolved-retry was granted on a KNOWN (completed or
	// failed) row rather than an ambiguous dispatched one. The row was
	// never ordinal-bearing — legacy rows only; nothing writes the grant
	// columns any more (#594), and the interrupted rail reads this to
	// keep such rows out of its numbered list.
	retryFromKnown: boolean;
	result: string | null;
	error: string | null;
	beganMs: number | null;
	settledMs: number | null;
	resolutionNote: string | null;
	resolvedMs: number | null;
}

// #579 — one DM the boot owes the operator for a crash found at open.
// The row is written when the window is consumed (reclassify, stranded
// count) and claimed only when a send lands, so a boot that dies before
// the Telegram attach hands the debt to the next one.
export interface InterruptedBootNotice {
	id: number;
	run: TurnRun;
}
export interface StrandedBootNotice {
	id: number;
	conversationId: string;
	count: number;
}
export interface PendingBootNotices {
	interrupted: InterruptedBootNotice[];
	stranded: StrandedBootNotice[];
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
		admissionExchangeExcluded?: boolean | undefined;
		sourceInputSeq?: number | null | undefined;
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
	checkpoint(runId: string, patch: TurnCheckpointPatch): void;
	// The attempt's durable reply committed — written inside the reply's
	// own append transaction so a kill in the delivery window can never
	// leave a reply behind a run row that still claims none. replySeq is
	// that append's first seq — the reply's durable address.
	noteReplyLanded(runId: string, replySeq: number | null): void;
	// Interrupted runs whose reply landed but was never delivered — the
	// boot re-delivery set (#482). Covers rows interrupted at this open
	// AND older rows a previous re-delivery attempt left pending.
	landedPendingReplies(): TurnRun[];
	// One-time claim on a pending delivery: flips delivery to 'delivered'
	// only while still 'pending' — true when THIS caller won the claim,
	// so two recovery passes can never both mark (or both send).
	markReplyDelivered(runId: string): boolean;
	finishRun(
		runId: string,
		status: "fenced" | "completed" | "error",
		delivery: "delivered" | "undelivered" | "failed",
	): void;
	inheritCalls(sourceRunId: string, intoRunId: string): void;
	interrupted(): TurnRun[];
	// #579 — the boot-notice outbox. Open consumes the crash windows
	// into pending boot_notices rows; the notices stay owed across
	// boots until a send lands (see markBootNoticeDelivered). The
	// interrupted runs resolve at read time — a row whose run left
	// 'interrupted' is the sender's to drop, not the reader's.
	pendingBootNotices(): PendingBootNotices;
	// One-time claim on a boot notice: flips delivered_at only while
	// still NULL — true when THIS caller won the claim, so two sends
	// can never both mark (or both re-send on a later boot).
	markBootNoticeDelivered(id: number, now?: number): boolean;
	get(runId: string): TurnRun | null;
	// The newest run whose resumed_from names this row — null when none
	// exists. Only legacy operator-resume rows carry the link; nothing
	// writes it any more (#594).
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
	admission_exchange_excluded: z.number().nullable(),
	source_input_seq: z.number().int().positive().nullable(),
	filter_retry_used: z.number(),
	reply_landed: z.number().nullable(),
	reply_seq: z.number().int().positive().nullable(),
	created_at: z.string(),
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
// The step checkpoint must stay valid JSON at any size — a char-truncated
// row parses as a string at read time and seeds nothing, so over-budget
// degrades by content instead: provider ciphertext first, then the
// oldest messages.
const PARTIAL_BUDGET = 512_000;

function serializePartial(partial: unknown, runId: string): string {
	const text = JSON.stringify(partial) ?? "null";
	if (text.length <= PARTIAL_BUDGET) return text;
	const value = withoutReasoningCipher(partial);
	let stripped = JSON.stringify(value) ?? "null";
	log.warn("turn checkpoint over budget — reasoning cipher stripped", {
		run: runId,
		beforeChars: text.length,
		afterChars: stripped.length,
	});
	if (stripped.length <= PARTIAL_BUDGET) return stripped;
	if (Array.isArray(value)) {
		let dropped = 0;
		const list = [...value];
		while (stripped.length > PARTIAL_BUDGET && list.length > 0) {
			list.shift();
			dropped++;
			stripped = JSON.stringify(list) ?? "[]";
		}
		if (dropped > 0) {
			log.warn("turn checkpoint over budget — oldest messages dropped", {
				run: runId,
				dropped,
			});
		}
	}
	return stripped;
}

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

// A resolved-skip is the one legacy decision still load-bearing: a
// continuation honoring it refuses to re-run the call, and the note it
// carried explains why.
export const RESOLVED_SKIP_NOTE =
	"[turn-journal decision: previous execution outcome unknown — operator skipped re-running this call]";

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

// A JSON seq[] column: absent (NULL), valid, or malformed — malformed
// reads as NULL with a warning; a corrupt ownership list must not
// silently widen the stranded-input count. Sequences are durable event
// seqs — positive safe integers — never message ids (those are forgeable).
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
		// A pre-column interrupted run never recorded its admission view.
		// It may have consumed excluded unowned context, now hidden by a fold.
		admissionExchangeExcluded: r.admission_exchange_excluded !== 0,
		sourceInputSeq: r.source_input_seq,
		filterRetryUsed: r.filter_retry_used !== 0,
		replyLanded: r.reply_landed === 1,
		replySeq: r.reply_seq,
		createdAt: r.created_at,
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

export interface OpenTurnJournalOpts {
	/** design/runtime-turn.md → Unlanded-turn progress: called inside the
	 *  open transaction that reclassifies a 'running' row to
	 *  'interrupted', with the decoded row and its calls — the hook
	 *  appends the run's progress event to history, committing with the
	 *  reclassify or not at all. Absent = reclassify only (test rigs). */
	onInterrupted?(run: TurnRun, calls: TurnToolCall[]): void;
}

export function openTurnJournal(db: Database, opts: OpenTurnJournalOpts = {}): TurnJournal {
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
	db.run(
		"CREATE INDEX IF NOT EXISTS turn_runs_conv_status ON turn_runs(conversation_id, status, started_ms, run_id)",
	);
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
	// One row per open — the previous row's opened_at bounds the dead
	// process's lifetime for the stranded-input count (#577).
	db.run(`CREATE TABLE IF NOT EXISTS journal_opens (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		opened_at TEXT NOT NULL
	)`);
	// #579 — the boot-notice outbox. A row is owed from the moment its
	// crash window is consumed at open until a Telegram send lands;
	// delivered_at NULL marks the debt. The conversation cascade keeps
	// rows from outliving the conversation they would name.
	db.run(`CREATE TABLE IF NOT EXISTS boot_notices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		run_id TEXT,
		conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		stranded_count INTEGER,
		created_at TEXT NOT NULL,
		delivered_at TEXT
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
	if (!runCols.has("admission_exchange_excluded")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN admission_exchange_excluded INTEGER");
	}
	if (!runCols.has("resume_request_seqs")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN resume_request_seqs TEXT");
	}
	if (!runCols.has("source_input_seq")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN source_input_seq INTEGER");
	}
	// Nullable like the rest of the added columns: a pre-column row never
	// recorded the fact, so it cannot read as landed.
	if (!runCols.has("reply_landed")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN reply_landed INTEGER");
	}
	// Same additive rule: a pre-column landed reply has no recorded seq,
	// so NULL means "landed but unaddressable" — never backfilled.
	if (!runCols.has("reply_seq")) {
		db.exec("ALTER TABLE turn_runs ADD COLUMN reply_seq INTEGER");
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

	const qBegin = db.query(`INSERT INTO turn_runs (
		run_id, conversation_id, epoch, anchor_seq, steer_mark,
		conv_snapshot, tool_names, started_ms, status, created_at,
		owned_input_seqs, source_input_seq, admission_exchange_excluded
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`);
	const qReplyLanded = db.query(
		"UPDATE turn_runs SET reply_landed = 1, reply_seq = ? WHERE run_id = ?",
	);
	const qLandedPending = db.query(
		`${RUN_SELECT} WHERE r.status = 'interrupted' AND r.reply_landed = 1 AND r.delivery = 'pending' ORDER BY r.started_ms, r.run_id`,
	);
	const qMarkDelivered = db.query(
		"UPDATE turn_runs SET delivery = 'delivered' WHERE run_id = ? AND delivery = 'pending'",
	);
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
	const qRunStatus = db.query<{ status: string }, [string]>(
		"SELECT status FROM turn_runs WHERE run_id = ?",
	);
	const qGet = db.query(`${RUN_SELECT} WHERE r.run_id = ?`);
	const qSuccessor = db.query<{ run_id: string }, [string]>(
		"SELECT run_id FROM turn_runs WHERE resumed_from = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
	);
	const qInterrupted = db.query(
		`${RUN_SELECT} WHERE r.status = 'interrupted' ORDER BY r.started_ms, r.run_id`,
	);
	const qCalls = db.query("SELECT * FROM turn_tool_calls WHERE run_id = ? ORDER BY rowid");
	// A row still 'running' at open means the process died mid-turn.
	// Reclassify it 'interrupted' and — when the open wires the hook —
	// record its unlanded progress in history in the SAME transaction
	// (design/runtime-turn.md → Unlanded-turn progress): a crash between
	// the two must neither lose the record nor duplicate it, so a hook
	// throw rolls the reclassify back and fails the open loud; the next
	// boot retries both. The boot-notice row rides the same transaction
	// (#579): a reclassified run without its owed notice cannot exist.
	const qStale = db.query<
		{ run_id: string; conversation_id: string; started_ms: number },
		[number]
	>(
		"UPDATE turn_runs SET status = 'interrupted', finished_ms = ? WHERE status = 'running' RETURNING run_id, conversation_id, started_ms",
	);
	const qNoticeInterrupted = db.query(
		"INSERT INTO boot_notices (kind, run_id, conversation_id, created_at) VALUES ('interrupted', ?, ?, ?)",
	);
	// One clock read per open: the reclassify stamp and this open's
	// journal_opens row share it.
	const openMs = Date.now();
	const reclassify = (): void => {
		for (const r of qStale.all(openMs)) {
			log.warn("interrupted turn found", {
				run: r.run_id,
				conversation: r.conversation_id,
				started: new Date(r.started_ms).toISOString(),
			});
			const run = decodeRun(qGet.get(r.run_id));
			opts.onInterrupted?.(run, qCalls.all(run.runId).map(decodeCall));
			qNoticeInterrupted.run(r.run_id, r.conversation_id, new Date(openMs).toISOString());
		}
	};
	if (opts.onInterrupted === undefined) reclassify();
	else db.transaction(reclassify)();
	// Stranded-input candidates (#481): user events the dead process
	// accepted but never admitted to a turn — above every run's owned
	// floor (anchor and source seqs stand in for legacy NULL ownership)
	// and above the last assistant reply (an answered input is not
	// stranded even if its run's ownership never journaled). json_each
	// over a NULL owned_input_seqs yields zero rows, so legacy rows
	// contribute only their anchor/source seqs. The created_at bound
	// scopes the count to the dead process's lifetime (#577): created
	// since the previous journal open — only input it could have
	// accepted is stranded, pre-journal history and input an earlier
	// restart already settled stay out. Machinery speech and generated
	// resume markers are filtered below; post-open submissions belong
	// to the live runtime — the count is fixed at open and lands in
	// boot_notices, never recomputed.
	const qStranded = db.query<{ conversation_id: string; seq: number; data: string }, [string]>(
		`SELECT e.conversation_id, e.seq, e.data FROM events e
		 WHERE e.role = 'user'
		   AND e.created_at >= ?
		   AND e.seq > COALESCE((
				SELECT MAX(x) FROM (
					SELECT je.value AS x FROM turn_runs r
						JOIN json_each(r.owned_input_seqs) je
					 WHERE r.conversation_id = e.conversation_id
					UNION ALL
					SELECT anchor_seq FROM turn_runs
					 WHERE conversation_id = e.conversation_id AND anchor_seq IS NOT NULL
					UNION ALL
					SELECT source_input_seq FROM turn_runs
					 WHERE conversation_id = e.conversation_id AND source_input_seq IS NOT NULL
				)), 0)
		   AND e.seq > COALESCE((
				SELECT MAX(seq) FROM events a
				 WHERE a.conversation_id = e.conversation_id AND a.role = 'assistant'), 0)`,
	);
	const qPrevOpen = db.query<{ opened_at: string }, []>(
		"SELECT opened_at FROM journal_opens ORDER BY id DESC LIMIT 1",
	);
	const qRecordOpen = db.query("INSERT INTO journal_opens (opened_at) VALUES (?)");
	const qNoticeStranded = db.query(
		"INSERT INTO boot_notices (kind, conversation_id, stranded_count, created_at) VALUES ('stranded', ?, ?, ?)",
	);
	const qPendingNotices = db.query<
		{
			id: number;
			kind: "interrupted" | "stranded";
			run_id: string | null;
			conversation_id: string;
			stranded_count: number | null;
		},
		[]
	>("SELECT id, kind, run_id, conversation_id, stranded_count FROM boot_notices WHERE delivered_at IS NULL ORDER BY id");
	const qClaimNotice = db.query(
		"UPDATE boot_notices SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
	);
	const resumeMarker = z.object({ goblinResume: z.object({ sourceRunId: z.string() }) });
	// A first-ever open knows no prior process lifetime — nothing is
	// provably stranded, so the map stays empty rather than counting
	// all of history.
	const prevOpen = qPrevOpen.get()?.opened_at ?? null;
	const strandedAtOpen = ((): ReadonlyMap<string, number> => {
		const counts = new Map<string, number>();
		if (prevOpen === null) return counts;
		for (const row of qStranded.all(prevOpen)) {
			const message = parseEvent(row.conversation_id, row.seq, "user", row.data);
			// A corrupt row decodes to a placeholder — it was never a
			// readable message, so nothing answerable was stranded.
			if (message === null) continue;
			const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
			if (isMachineryText(text)) continue;
			if (resumeMarker.safeParse(message.metadata).success) continue;
			counts.set(row.conversation_id, (counts.get(row.conversation_id) ?? 0) + 1);
		}
		return counts;
	})();
	const openedAt = new Date(openMs).toISOString();
	// The stranded notice rows and this open's journal_opens row commit
	// together (#579): the window is never consumed without the notice
	// it owes. A crash before the transaction leaves both unwritten —
	// the next open re-derives the same window.
	db.transaction(() => {
		for (const [conversationId, count] of strandedAtOpen) {
			qNoticeStranded.run(conversationId, count, openedAt);
		}
		qRecordOpen.run(openedAt);
	})();
	log.info("turn journal opened", {
		openedAt,
		previousOpen: prevOpen,
		strandedConversations: strandedAtOpen.size,
	});
	// Inherited evidence copies are namespaced by their ORIGIN run, never
	// carried under the raw provider id. The primary key (run_id,
	// tool_call_id) spans both the inherited copies and this attempt's
	// own calls, and providers that number tool-call ids per response
	// (the part-id precedent at turn/stream.ts) hand the successor's
	// fresh execution an id a terminal inherited row already holds —
	// every upsert guard then silently drops that execution's records.
	// Keying the
	// copy on COALESCE(origin_run, source) keeps the namespace idempotent
	// across hops: one piece of evidence copied along two paths (a
	// continuation inherits both the failed attempt and an older
	// terminal source) lands on a single row — first insert wins, so the more
	// settled copy keeps beating the stale one — while the successor's
	// own calls never collide with evidence. A namespaced row stores its
	// origin and its id as `<origin>:<raw>`, so the raw id survives every
	// hop: re-prefixing strips the stored origin's prefix first. Rows
	// copied before origin_run existed read NULL and take their immediate
	// source's namespace at the next copy. A provider emitting an id that
	// already reads as `<run-id>:<id>` would re-enter the namespace;
	// provider ids are not run-id-shaped. The grant columns
	// (retry_consumed) are deliberately not copied — nothing reads them.
	const qInherit = db.query(
		`INSERT OR IGNORE INTO turn_tool_calls
			(run_id, tool_call_id, name, args, args_hash, state, replayed, result, error,
			 began_ms, settled_ms, resolution_note, resolved_ms, retry_from_known, origin_run)
		 SELECT ?,
			COALESCE(origin_run, ?) || ':' ||
				CASE WHEN origin_run IS NULL THEN tool_call_id
					ELSE SUBSTR(tool_call_id, LENGTH(origin_run) + 2) END,
			name, args, args_hash, state, replayed, result, error,
			began_ms, settled_ms, resolution_note, resolved_ms, retry_from_known,
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
					input.ownedInputSeqs === undefined ? null : JSON.stringify(input.ownedInputSeqs),
					input.sourceInputSeq ?? null,
					input.admissionExchangeExcluded === true ? 1 : 0,
				);
			};
			// A continuation's evidence inheritance commits with its own
			// row: inheriting from a predecessor that vanished would leave
			// the run blind to side effects it must not repeat.
			if ((input.inheritFrom?.length ?? 0) === 0) {
				insert();
				return;
			}
			db.transaction(() => {
				insert();
				for (const pred of input.inheritFrom ?? []) {
					if (qRunStatus.get(pred) === null) {
						throw new Error(`inherit predecessor run ${pred} is gone`);
					}
					qInherit.run(input.runId, pred, pred, pred);
				}
			})();
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
			const vals: (string | number | null)[] = [];
			if (patch.partial !== undefined) {
				sets.push("partial = ?");
				vals.push(serializePartial(patch.partial, runId));
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
		finishRun(runId, status, delivery) {
			qFinish.run(status, delivery, Date.now(), runId);
		},
		noteReplyLanded(runId, replySeq) {
			qReplyLanded.run(replySeq, runId);
		},
		landedPendingReplies() {
			return qLandedPending.all().map(decodeRun);
		},
		markReplyDelivered(runId) {
			return qMarkDelivered.run(runId).changes > 0;
		},
		inheritCalls(sourceRunId, intoRunId) {
			qInherit.run(intoRunId, sourceRunId, sourceRunId, sourceRunId);
		},
		interrupted() {
			return qInterrupted.all().map(decodeRun);
		},
		pendingBootNotices() {
			const pending: PendingBootNotices = { interrupted: [], stranded: [] };
			for (const row of qPendingNotices.all()) {
				if (row.kind === "stranded") {
					pending.stranded.push({
						id: row.id,
						conversationId: row.conversation_id,
						count: row.stranded_count ?? 0,
					});
					continue;
				}
				// The run row cannot predecease its notice (the conversation
				// cascade removes both) — a missing row is corruption, so it
				// stays loud and pending rather than silently dropping.
				const run = row.run_id === null ? null : qGet.get(row.run_id);
				if (run === null) {
					log.warn("boot notice run row unreadable — left pending", undefined, {
						notice: row.id,
						run: row.run_id,
						conversation: row.conversation_id,
					});
					continue;
				}
				pending.interrupted.push({ id: row.id, run: decodeRun(run) });
			}
			return pending;
		},
		markBootNoticeDelivered(id, now = Date.now()) {
			return qClaimNotice.run(new Date(now).toISOString(), id).changes > 0;
		},
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
