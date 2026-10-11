// The log tail view: bounded, server-filtered slices of goblin.log —
// never the whole file (ruling 2026-10-11). The server owns the window
// and the filters; this view only picks them and renders lines.
import { useCallback, useEffect, useState } from "react";
import { tailLog } from "./api.ts";
import { describe } from "./opsShared.tsx";
import type { LogTailResponse } from "../../src/http/operator-wire.ts";

const LIMITS = [100, 200, 500, 1000] as const;
const LEVELS = ["debug", "info", "warn", "error"] as const;

function hhmmss(ts: string | null): string {
	if (ts === null) return "—";
	const t = Date.parse(ts);
	if (Number.isNaN(t)) return ts;
	return new Date(t).toLocaleTimeString(undefined, { hour12: false });
}

export function LogView({ token }: { token: string | null }) {
	const [level, setLevel] = useState<string>("");
	const [applied, setApplied] = useState<{ level: string | null; q: string | null; limit: number }>(
		{
			level: null,
			q: null,
			limit: 200,
		},
	);
	const [qDraft, setQDraft] = useState("");
	const [limit, setLimit] = useState<number>(200);
	const [data, setData] = useState<LogTailResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const load = useCallback(() => {
		setErr(null);
		tailLog(token, { limit: applied.limit, level: applied.level, q: applied.q }).then(
			(d) => setData(d),
			(e) => setErr(describe(e)),
		);
	}, [token, applied]);

	useEffect(() => {
		load();
	}, [load]);

	const apply = () => {
		setApplied({
			level: level === "" ? null : level,
			q: qDraft.trim() === "" ? null : qDraft.trim(),
			limit,
		});
	};

	return (
		<div className="ops">
			<h2 className="ops-h2">Log</h2>
			<div className="log-controls">
				<select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="level filter">
					<option value="">all levels</option>
					{LEVELS.map((l) => (
						<option key={l} value={l}>
							{l}
						</option>
					))}
				</select>
				<input
					value={qDraft}
					onChange={(e) => setQDraft(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && apply()}
					placeholder="substring — e.g. a conversation id"
					aria-label="substring filter"
				/>
				<select
					value={limit}
					onChange={(e) => setLimit(Number(e.target.value))}
					aria-label="line limit"
				>
					{LIMITS.map((n) => (
						<option key={n} value={n}>
							last {n}
						</option>
					))}
				</select>
				<button type="button" onClick={apply}>
					apply
				</button>
				<button type="button" onClick={load}>
					refresh
				</button>
			</div>
			{err !== null && <p className="error">{err}</p>}
			{data !== null && data.truncated && (
				<p className="empty">
					Older or filtered-out lines exist beyond this slice — tighten the filter or raise the
					limit.
				</p>
			)}
			{data !== null && data.lines.length === 0 && <p className="empty">No matching lines.</p>}
			{data !== null && data.lines.length > 0 && (
				<div className="logview">
					{data.lines.map((l, i) => (
						<div className={`logline lv-${l.level}`} key={i} title={l.line}>
							<span className="log-ts mono">{hhmmss(l.ts)}</span>
							<span className="log-level mono">{l.level}</span>
							<span className="log-msg">{l.msg}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
