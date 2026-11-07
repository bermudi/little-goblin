// The log page: a bounded, server-filtered tail of goblin.log shown as a
// table (design/app.md → Non-chat page layout). The server owns the window,
// the level and the text filter; this view picks them, folds quiet repeats,
// and opens one line's fields in place. Never the whole file.
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { tailLog } from "./api.ts";
import { describe } from "./opsShared.tsx";
import type { LogTailItem, LogTailResponse } from "../../src/http/operator-wire.ts";

const LIMITS = [100, 200, 500, 1000] as const;
// "level" on the wire means "at least this severity".
const LEVEL_CHIPS = [
	{ level: "", label: "All", hint: "Every line, debug included" },
	{ level: "info", label: "Info+", hint: "Hide debug lines" },
	{ level: "warn", label: "Warnings+", hint: "Warnings and errors" },
	{ level: "error", label: "Errors", hint: "Errors only" },
] as const;
const SEARCH_DELAY_MS = 300;
const COLS = {
	"--dt-cols": "8.5rem 5rem minmax(14rem, 2.5fr) minmax(12rem, 3fr)",
} as CSSProperties;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

// Today shows the clock only; an older line also names its day.
function whenShort(ts: string | null, now: Date): string {
	if (ts === null) return "—";
	const t = new Date(ts);
	if (Number.isNaN(t.getTime())) return ts;
	const clock = t.toLocaleTimeString(undefined, { hour12: false });
	if (sameDay(t, now)) return clock;
	return `${t.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}

function whenFull(ts: string | null): string {
	if (ts === null) return "no timestamp";
	const t = new Date(ts);
	if (Number.isNaN(t.getTime())) return ts;
	return t.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", hour12: false });
}

function scalar(v: unknown): string | null {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return null;
}

// The few fields worth a glance in the row: scalars only, the error first;
// everything else (stacks, nested data) waits in the opened line.
function keyFields(fields: Record<string, unknown>): string {
	const entries = Object.entries(fields).flatMap(([k, v]) => {
		const s = k === "stack" ? null : scalar(v);
		return s === null ? [] : [[k, s.replace(/\s+/g, " ")] as const];
	});
	entries.sort(([a], [b]) => Number(b === "error") - Number(a === "error"));
	return entries
		.slice(0, 6)
		.map(([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 60)}…` : v}`)
		.join("  ");
}

type Row =
	| { kind: "line"; id: string; line: LogTailItem }
	| { kind: "group"; id: string; lines: LogTailItem[] };

// Consecutive debug/info lines with the same level and message are one
// quiet repeat. Warnings and errors never fold: each one is an event.
// Rows come back newest first.
function toRows(lines: LogTailItem[], fold: boolean): Row[] {
	const rows: Row[] = [];
	let i = 0;
	while (i < lines.length) {
		const first = lines[i]!;
		let j = i + 1;
		if (fold && (first.level === "debug" || first.level === "info")) {
			while (j < lines.length && lines[j]!.level === first.level && lines[j]!.msg === first.msg)
				j++;
		}
		if (j - i > 1) rows.push({ kind: "group", id: `g${i}`, lines: lines.slice(i, j) });
		else rows.push({ kind: "line", id: `l${i}`, line: first });
		i = j;
	}
	return rows.reverse();
}

function FieldValue({ value }: { value: unknown }) {
	const s = scalar(value);
	if (s !== null) {
		return s.includes("\n") ? <pre className="log-pre">{s}</pre> : <span>{s}</span>;
	}
	if (value === null) return <span className="log-null">null</span>;
	return <pre className="log-pre">{JSON.stringify(value, null, 2)}</pre>;
}

function LineDetail({ line }: { line: LogTailItem }) {
	const entries = Object.entries(line.fields);
	return (
		<div className="log-detail">
			<dl>
				<dt>time</dt>
				<dd>
					{whenFull(line.ts)}
					{line.ts !== null && <span className="log-iso"> · {line.ts}</span>}
				</dd>
				<dt>level</dt>
				<dd>{line.level}</dd>
				<dt>message</dt>
				<dd>{line.msg}</dd>
				{entries.map(([k, v]) => (
					<FieldRow key={k} name={k} value={v} />
				))}
			</dl>
			{entries.length === 0 && <p className="log-nofields">This line has no other fields.</p>}
		</div>
	);
}

function FieldRow({ name, value }: { name: string; value: unknown }) {
	return (
		<>
			<dt>{name}</dt>
			<dd>
				<FieldValue value={value} />
			</dd>
		</>
	);
}

function LineRow({
	line,
	now,
	open,
	onToggle,
	sub = false,
	repeat,
}: {
	line: LogTailItem;
	now: Date;
	open: boolean;
	onToggle: () => void;
	sub?: boolean;
	repeat?: { count: number; first: string | null };
}) {
	return (
		<>
			<button
				type="button"
				className={`dt-row log-row lv-${line.level}${sub ? " sub" : ""}${open ? " open" : ""}`}
				aria-expanded={open}
				onClick={onToggle}
			>
				<span className="dt-cell dt-mono log-when" title={whenFull(line.ts)}>
					{whenShort(line.ts, now)}
				</span>
				<span className="dt-cell dt-status">
					<span className={`pill lv-${line.level}`}>{line.level}</span>
				</span>
				<span className="dt-cell log-msg" title={line.msg}>
					{line.msg}
					{repeat !== undefined && (
						<span
							className="log-times"
							title={`${repeat.count} identical lines, from ${whenFull(repeat.first)}`}
						>
							×{repeat.count}
						</span>
					)}
				</span>
				<span className="dt-cell dt-mono log-fields">
					{repeat !== undefined ? `since ${whenShort(repeat.first, now)}` : keyFields(line.fields)}
				</span>
			</button>
			{open && repeat === undefined && <LineDetail line={line} />}
		</>
	);
}

// A folded repeat: one row with ×N; opening it lists the lines, newest first.
function GroupRows({
	row,
	now,
	open,
	onToggle,
}: {
	row: Extract<Row, { kind: "group" }>;
	now: Date;
	open: ReadonlySet<string>;
	onToggle: (id: string) => void;
}) {
	const newest = row.lines[row.lines.length - 1]!;
	const isOpen = open.has(row.id);
	return (
		<>
			<LineRow
				line={newest}
				now={now}
				open={isOpen}
				onToggle={() => onToggle(row.id)}
				repeat={{ count: row.lines.length, first: row.lines[0]!.ts }}
			/>
			{isOpen &&
				[...row.lines].reverse().map((l, k) => {
					const id = `${row.id}.${k}`;
					return (
						<LineRow
							key={id}
							line={l}
							now={now}
							sub
							open={open.has(id)}
							onToggle={() => onToggle(id)}
						/>
					);
				})}
		</>
	);
}

export function LogView({ token }: { token: string | null }) {
	const [level, setLevel] = useState<string>("");
	const [qDraft, setQDraft] = useState("");
	const [q, setQ] = useState<string | null>(null);
	const [limit, setLimit] = useState<number>(200);
	const [fold, setFold] = useState(true);
	const [data, setData] = useState<LogTailResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	// One fence for every tail — a slower filter's response must not
	// overwrite the newer controls' results when it lands out of order.
	const tailSeq = useRef(0);
	const load = useCallback(() => {
		const seq = ++tailSeq.current;
		setErr(null);
		tailLog(token, { limit, level: level === "" ? null : level, q }).then(
			(d) => {
				if (seq !== tailSeq.current) return;
				setData(d);
				setOpen(new Set());
			},
			(e) => {
				if (seq !== tailSeq.current) return;
				setErr(describe(e));
			},
		);
	}, [token, limit, level, q]);

	useEffect(() => {
		load();
	}, [load]);

	// Typing searches by itself after a short pause; Enter does not wait.
	const typed = qDraft.trim() === "" ? null : qDraft.trim();
	useEffect(() => {
		if (typed === q) return;
		const t = setTimeout(() => setQ(typed), SEARCH_DELAY_MS);
		return () => clearTimeout(t);
	}, [typed, q]);

	const toggle = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const now = new Date();
	const rows = data === null ? [] : toRows(data.lines, fold);
	const errors = data?.lines.filter((l) => l.level === "error").length ?? 0;
	const warns = data?.lines.filter((l) => l.level === "warn").length ?? 0;
	const olderMatching = data === null ? 0 : data.matched - data.lines.length;
	const nextLimit = LIMITS.find((n) => n > limit);

	return (
		<div className="ops logpage">
			<h2 className="ops-h2">Log</h2>
			<div className="log-controls">
				<div className="log-levels" role="group" aria-label="level filter">
					{LEVEL_CHIPS.map((c) => (
						<button
							key={c.level}
							type="button"
							className={level === c.level ? "on" : ""}
							aria-pressed={level === c.level}
							title={c.hint}
							onClick={() => setLevel(c.level)}
						>
							{c.label}
						</button>
					))}
				</div>
				<input
					type="search"
					value={qDraft}
					onChange={(e) => setQDraft(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && setQ(typed)}
					placeholder="Search text — e.g. a conversation id"
					aria-label="text filter"
				/>
				<select
					value={limit}
					onChange={(e) => setLimit(Number(e.target.value))}
					aria-label="line limit"
				>
					{LIMITS.map((n) => (
						<option key={n} value={n}>
							newest {n}
						</option>
					))}
				</select>
				<label className="log-fold">
					<input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} />
					Fold repeats
				</label>
				<button type="button" className="log-refresh" onClick={load}>
					Refresh
				</button>
			</div>
			{err !== null && <p className="error">{err}</p>}
			{data !== null && (
				<p className="log-summary">
					{data.lines.length} {data.lines.length === 1 ? "line" : "lines"}, newest first
					{errors > 0 && <span className="log-count bad"> · {errors} errors</span>}
					{warns > 0 && <span className="log-count warn"> · {warns} warnings</span>}
				</p>
			)}
			{data !== null && data.lines.length === 0 && <p className="empty">No matching lines.</p>}
			{data !== null && data.lines.length > 0 && (
				<div className="dtable logtable" style={COLS}>
					<div className="dt-head" aria-hidden="true">
						<span>Time</span>
						<span>Level</span>
						<span>Message</span>
						<span>Fields</span>
					</div>
					{rows.map((r) =>
						r.kind === "line" ? (
							<LineRow
								key={r.id}
								line={r.line}
								now={now}
								open={open.has(r.id)}
								onToggle={() => toggle(r.id)}
							/>
						) : (
							<GroupRows key={r.id} row={r} now={now} open={open} onToggle={toggle} />
						),
					)}
				</div>
			)}
			{data !== null && olderMatching > 0 && (
				<p className="log-more">
					{olderMatching} older matching {olderMatching === 1 ? "line is" : "lines are"} not shown.{" "}
					{nextLimit !== undefined ? (
						<button type="button" className="log-refresh" onClick={() => setLimit(nextLimit)}>
							Show newest {nextLimit}
						</button>
					) : (
						"Narrow the filter to reach them."
					)}
				</p>
			)}
			{data !== null && olderMatching <= 0 && data.truncated && (
				<p className="log-more">
					Older lines (or lines that could not be read) lie outside the last{" "}
					{Math.round(data.scannedBytes / 1024)} KiB scanned. The log file has them.
				</p>
			)}
		</div>
	);
}
