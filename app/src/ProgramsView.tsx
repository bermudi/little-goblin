// The Programs page (design/app.md → Non-chat page layout, #183): a summary
// strip, pending approvals with their evidence open, programs as a table.
// Opening a program replaces the list with its detail and a back link.
import { type CSSProperties, useState } from "react";
import { cronWords } from "../../src/cron-words.ts";
import type { AppProgramMutationResponse } from "../../src/http/app-wire.ts";
import type { OperatorProgramItem } from "../../src/http/operator-wire.ts";
import { ApprovalsPanel, SecretReveal, useApprovals } from "./Approvals.tsx";
import { deleteProgram, listPrograms, programHook, toggleProgram, updateProgram } from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { KV, ts, tzAbbrev, useLoad } from "./opsShared.tsx";

// The scheduler scans every 30 s (src/scheduler.ts TICK_MS); a program is
// only "late" once a few scans have passed its due time.
const LATE_AFTER_MS = 90_000;

export type ProgramStatus =
	| { kind: "disabled" }
	| { kind: "late"; minutes: number }
	| { kind: "enabled" };

/** What the stored row can say: whether it runs, and whether its next run is
 *  overdue. Run outcomes (failed) are not recorded, so none is shown. */
export function programStatus(p: OperatorProgramItem, now: number): ProgramStatus {
	if (!p.enabled) return { kind: "disabled" };
	if (p.cron !== null && p.nextRun !== null) {
		const overdue = now - Date.parse(p.nextRun);
		if (overdue > LATE_AFTER_MS) return { kind: "late", minutes: Math.floor(overdue / 60_000) };
	}
	return { kind: "enabled" };
}

/** The schedule in words, or how a program without one is triggered. */
export function triggerWords(p: OperatorProgramItem): string {
	if (p.cron !== null) return cronWords(p.cron) ?? p.cron;
	if (p.hasHook) return "Webhook";
	if (p.mailFilter !== null) return "On new mail";
	return "Manual";
}

/** Trigger words plus the zone the cron is evaluated in — the same zone the
 *  run-time columns render, so the two never read as different clocks. */
function scheduleLabel(p: OperatorProgramItem, timeZone: string): string {
	const words = triggerWords(p);
	return p.cron === null ? words : `${words} ${tzAbbrev(timeZone)}`;
}

function lateness(p: OperatorProgramItem): string {
	if (p.cron === null) return "—";
	return p.maxLatenessMinutes === null ? "unlimited" : `${p.maxLatenessMinutes} min`;
}

function StatusPill({ status }: { status: ProgramStatus }) {
	switch (status.kind) {
		case "disabled":
			return <span className="pill">disabled</span>;
		case "late":
			return <span className="pill warn">late {status.minutes} min</span>;
		case "enabled":
			return <span className="pill on">enabled</span>;
	}
}

export function ProgramsView({
	token,
	now = Date.now(),
}: {
	token: string | null;
	now?: number;
}) {
	const { data, err, reload } = useLoad(() => listPrograms(token));
	const approvals = useApprovals(token);
	const [openId, setOpenId] = useState<number | null>(null);
	if (err !== null)
		return (
			<div className="ops">
				<p className="error">{err}</p>
			</div>
		);
	if (data === null)
		return (
			<div className="ops">
				<p className="empty">Loading…</p>
			</div>
		);
	const timeZone = data.serverTimeZone;
	const open = data.programs.find((p) => p.id === openId) ?? null;
	if (open !== null) {
		return (
			<ProgramDetail
				token={token}
				program={open}
				now={now}
				timeZone={timeZone}
				onBack={() => setOpenId(null)}
				onChanged={reload}
			/>
		);
	}
	const waiting = (approvals.data?.programs.length ?? 0) + (approvals.data?.mail.length ?? 0);
	const enabled = data.programs.filter((p) => p.enabled).length;
	const late = data.programs.filter((p) => programStatus(p, now).kind === "late").length;
	return (
		<div className="ops programs-page">
			<div className="sumstrip">
				<Tile n={waiting} label="awaiting approval" warn={waiting > 0} />
				<Tile n={`${enabled}/${data.programs.length}`} label="enabled" />
				<Tile n={late} label="late" warn={late > 0} />
			</div>
			<h2 className="ops-h2">Pending approvals ({waiting})</h2>
			<ApprovalsPanel token={token} approvals={approvals} onChanged={reload} />
			<h2 className="ops-h2">Programs ({data.programs.length})</h2>
			{data.programs.length === 0 ? (
				<p className="empty">No programs defined.</p>
			) : (
				<ProgramTable programs={data.programs} now={now} timeZone={timeZone} onOpen={setOpenId} />
			)}
		</div>
	);
}

function Tile({ n, label, warn }: { n: number | string; label: string; warn?: boolean }) {
	return (
		<div className={warn === true ? "sumtile warn" : "sumtile"}>
			<b>{n}</b>
			<span>{label}</span>
		</div>
	);
}

const PROGRAM_COLS = {
	"--dt-cols":
		"minmax(11rem, 2.2fr) minmax(9rem, 1.4fr) 6.5rem minmax(8rem, 1.2fr) minmax(8rem, 1.2fr) 6.5rem",
} as CSSProperties;

function ProgramTable({
	programs,
	now,
	timeZone,
	onOpen,
}: {
	programs: OperatorProgramItem[];
	now: number;
	timeZone: string;
	onOpen(id: number): void;
}) {
	return (
		<div className="dtable" style={PROGRAM_COLS}>
			<div className="dt-head" aria-hidden="true">
				<span>Program</span>
				<span>Schedule</span>
				<span>Max lateness</span>
				<span>Last run</span>
				<span>Next run</span>
				<span>Status</span>
			</div>
			{programs.map((p) => (
				<button type="button" className="dt-row" key={p.id} onClick={() => onOpen(p.id)}>
					<span className="dt-cell dt-main">{p.name}</span>
					<span className="dt-cell" data-label="Schedule">
						{scheduleLabel(p, timeZone)}
					</span>
					<span className="dt-cell dt-hide-m">{lateness(p)}</span>
					<span className="dt-cell" data-label="Last run">
						{p.lastRun === null ? "never" : ts(p.lastRun, timeZone)}
					</span>
					<span className="dt-cell" data-label="Next run">
						{ts(p.nextRun, timeZone)}
					</span>
					<span className="dt-cell dt-status">
						<StatusPill status={programStatus(p, now)} />
					</span>
				</button>
			))}
		</div>
	);
}

function ProgramDetail({
	token,
	program,
	now,
	timeZone,
	onBack,
	onChanged,
}: {
	token: string | null;
	program: OperatorProgramItem;
	now: number;
	timeZone: string;
	onBack(): void;
	onChanged(): void;
}) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<AppProgramMutationResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [name, setName] = useState(program.name);
	const [charter, setCharter] = useState(program.charter);
	const [cron, setCron] = useState(program.cron ?? "");
	const [maxLateness, setMaxLateness] = useState(
		program.maxLatenessMinutes === null ? "" : String(program.maxLatenessMinutes),
	);
	const [mailFilter, setMailFilter] = useState(program.mailFilter ?? "");
	const confirm = useConfirm();

	const run = async (action: () => Promise<AppProgramMutationResponse>) => {
		setBusy(true);
		setErr(null);
		try {
			const out = await action();
			setResult(out);
			if (out.status === "deleted") onBack();
			if (out.status !== "error") onChanged();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		const text = maxLateness.trim();
		const parsed = text === "" ? null : Number(text);
		if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
			setErr("max lateness must be a positive whole number of minutes");
			return;
		}
		await run(() =>
			updateProgram(token, program.id, {
				name: name.trim(),
				charter,
				cron: cron.trim() === "" ? null : cron.trim(),
				maxLatenessMinutes: parsed,
				mailFilter: mailFilter.trim() === "" ? null : mailFilter.trim(),
			}),
		);
	};

	const remove = async () => {
		if (
			!(await confirm.ask({
				message: `Delete program "${program.name}"?`,
				confirmLabel: "Delete",
				danger: true,
			}))
		)
			return;
		await run(() => deleteProgram(token, program.id));
	};

	const words = program.cron === null ? null : cronWords(program.cron);
	return (
		<div className="ops programs-page">
			<div className="ops-back">
				<button type="button" className="ghost" onClick={onBack}>
					‹ Programs
				</button>
			</div>
			<div className="prog-title">
				<h2>{program.name}</h2>
				<StatusPill status={programStatus(program, now)} />
			</div>
			<h2 className="ops-h2">Facts</h2>
			<div className="card prog-facts">
				<KV k="schedule" v={scheduleLabel(program, timeZone)} />
				{words !== null && program.cron !== null && <KV k="cron" v={program.cron} mono />}
				<KV k="max lateness" v={lateness(program)} />
				<KV
					k="last run"
					v={program.lastRun === null ? "never" : ts(program.lastRun, timeZone)}
				/>
				<KV k="next run" v={ts(program.nextRun, timeZone)} />
				{program.lastSkippedAt !== null && (
					<KV
						k="last skip"
						v={`${ts(program.lastSkippedAt, timeZone)} — ${program.lastSkipReason ?? "skipped"}`}
					/>
				)}
				{program.hasHook && <KV k="hook" v="attached" mono />}
				{program.mailFilter !== null && <KV k="mail filter" v={program.mailFilter} mono />}
				<KV k="pinned to" v={program.target} mono />
			</div>
			<h2 className="ops-h2">Instructions</h2>
			{program.charter === "" ? (
				<p className="empty">No instructions.</p>
			) : (
				<div className="prose prog-charter">{program.charter}</div>
			)}
			<div className="approval-actions prog-actions">
				<button
					type="button"
					disabled={busy}
					onClick={() => void run(() => toggleProgram(token, program.id))}
				>
					{program.enabled ? "Disable" : "Enable"}
				</button>
				<button type="button" disabled={busy} onClick={() => setEditing((v) => !v)}>
					{editing ? "Close editor" : "Edit"}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						void run(() => programHook(token, program.id, program.hasHook ? "rotate" : "enable"))
					}
				>
					{program.hasHook ? "Rotate hook" : "Enable hook"}
				</button>
				{program.hasHook && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void run(() => programHook(token, program.id, "disable"))}
					>
						Disable hook
					</button>
				)}
				<button
					type="button"
					className="danger"
					disabled={busy}
					onClick={() => void remove()}
				>
					Delete
				</button>
			</div>
			{editing && (
				<div className="program-editor prose">
					<label>
						Name
						<input value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label>
						Instructions
						<textarea value={charter} onChange={(e) => setCharter(e.target.value)} rows={8} />
					</label>
					<label>
						Cron ({tzAbbrev(timeZone)})
						<input
							value={cron}
							onChange={(e) => setCron(e.target.value)}
							placeholder="blank clears the schedule"
						/>
					</label>
					<label>
						Max lateness minutes
						<input
							value={maxLateness}
							onChange={(e) => setMaxLateness(e.target.value)}
							placeholder="blank = unlimited"
						/>
					</label>
					<label>
						Mail filter
						<input
							value={mailFilter}
							onChange={(e) => setMailFilter(e.target.value)}
							placeholder="blank clears the filter"
						/>
					</label>
					<div className="approval-actions">
						<button type="button" disabled={busy} onClick={() => void save()}>
							Save changes
						</button>
					</div>
				</div>
			)}
			{busy && <p className="cap">Working…</p>}
			{err !== null && <p className="error">{err}</p>}
			{result !== null && (
				<div className={`approval-result st-${result.status}`}>
					{result.message}
					{result.hookUrl !== undefined && <SecretReveal url={result.hookUrl} />}
				</div>
			)}
			{confirm.view}
		</div>
	);
}
