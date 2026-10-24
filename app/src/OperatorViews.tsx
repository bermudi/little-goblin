import { useEffect, useState } from "react";
import {
	ApiError,
	deleteProgram,
	getServiceStatus,
	listDelegations,
	listPrograms,
	programHook,
	toggleProgram,
	updateProgram,
} from "./api.ts";
import { ApprovalsPanel, SecretReveal } from "./Approvals.tsx";
import { describe, KV, ts, uptime, useLoad } from "./opsShared.tsx";
import type {
	OperatorDelegationItem,
	OperatorProgramItem,
	OperatorStatusResponse,
} from "../../src/http/operator-wire.ts";
import type { AppProgramMutationResponse } from "../../src/http/app-wire.ts";

export function ProgramsView({ token }: { token: string | null }) {
	const { data, err, reload } = useLoad(() => listPrograms(token));
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
	return (
		<div className="ops">
			<h2 className="ops-h2">Pending approvals</h2>
			<ApprovalsPanel token={token} />
			<h2 className="ops-h2">Programs ({data.programs.length})</h2>
			{data.programs.length === 0 && <p className="empty">No programs defined.</p>}
			{data.programs.map((p: OperatorProgramItem) => (
				<ProgramCard key={p.id} token={token} program={p} onChanged={reload} />
			))}
		</div>
	);
}

function ProgramCard({
	token,
	program,
	onChanged,
}: {
	token: string | null;
	program: OperatorProgramItem;
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

	const run = async (action: () => Promise<AppProgramMutationResponse>) => {
		setBusy(true);
		setErr(null);
		try {
			const out = await action();
			setResult(out);
			if (out.status !== "error") onChanged();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		const lateness = maxLateness.trim();
		const parsedLateness = lateness === "" ? null : Number(lateness);
		if (parsedLateness !== null && (!Number.isInteger(parsedLateness) || parsedLateness <= 0)) {
			setErr("max lateness must be a positive whole number of minutes");
			return;
		}
		await run(() =>
			updateProgram(token, program.id, {
				name: name.trim(),
				charter,
				cron: cron.trim() === "" ? null : cron.trim(),
				maxLatenessMinutes: parsedLateness,
				mailFilter: mailFilter.trim() === "" ? null : mailFilter.trim(),
			}),
		);
	};

	return (
		<div className="card">
			<div className="op-item-head">
				<span className="op-item-title">{program.name}</span>
				<span className={program.enabled ? "pill on" : "pill"}>
					{program.enabled ? "enabled" : "disabled"}
				</span>
			</div>
			{program.charter !== "" && <div className="op-item-body">{program.charter}</div>}
			<KV k="cron" v={program.cron ?? "—"} mono />
			{program.cron !== null && (
				<KV
					k="max lateness"
					v={
						program.maxLatenessMinutes === null ? "unlimited" : `${program.maxLatenessMinutes} min`
					}
				/>
			)}
			{program.hasHook && <KV k="hook" v="attached" mono />}
			{program.mailFilter !== null && <KV k="mail filter" v={program.mailFilter} mono />}
			<KV k="last run" v={ts(program.lastRun)} />
			<KV k="next run" v={ts(program.nextRun)} />
			<KV k="pinned to" v={program.target} mono />
			<div className="approval-actions">
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
					onClick={() => {
						if (window.confirm(`Delete program "${program.name}"?`)) {
							void run(() => deleteProgram(token, program.id));
						}
					}}
				>
					Delete
				</button>
			</div>
			{editing && (
				<div className="program-editor">
					<label>
						Name
						<input value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label>
						Charter
						<textarea value={charter} onChange={(e) => setCharter(e.target.value)} rows={8} />
					</label>
					<label>
						Cron
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
		</div>
	);
}

export function DelegationsView({ token }: { token: string | null }) {
	const { data, err } = useLoad(() => listDelegations(token));
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
	return (
		<div className="ops">
			<h2 className="ops-h2">Delegations ({data.delegations.length})</h2>
			{data.delegations.length === 0 && <p className="empty">No delegations.</p>}
			{data.delegations.map((d: OperatorDelegationItem) => (
				<div className="card" key={d.id}>
					<div className="op-item-head">
						<span className="op-item-title">{d.name}</span>
						<span className={`pill st-${d.status}`}>{d.status}</span>
					</div>
					<div className="op-item-body">{d.task}</div>
					<KV k="harness" v={d.harness} mono />
					{d.target !== null && <KV k="target" v={d.target} mono />}
					<KV k="cwd" v={d.cwd} mono />
					{d.appConversation !== null && <KV k="app conversation" v={d.appConversation} mono />}
					<KV k="created" v={ts(d.createdAt)} />
					<KV k="prompted" v={ts(d.promptedAt)} />
					<KV k="finished" v={ts(d.finishedAt)} />
				</div>
			))}
		</div>
	);
}

export function StatusView({ token }: { token: string | null }) {
	const { data, err } = useLoad(() => getServiceStatus(token));
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
	const s: OperatorStatusResponse = data;
	return (
		<div className="ops">
			<h2 className="ops-h2">Service</h2>
			<div className="card">
				<KV k="version" v={s.version} mono />
				<KV k="started" v={ts(s.startedAt)} />
				<KV k="uptime" v={uptime(s.uptimeSec)} />
				{s.restartHints.length > 0 && (
					<div className="cap ops-cap">Restart applies: {s.restartHints.join(", ")}</div>
				)}
			</div>
			<h2 className="ops-h2">Memory</h2>
			<div className="card">
				<KV k="state" v={`${s.memory.state} — ${s.memory.detail}`} />
				<KV
					k="queue"
					v={`${s.memory.completed} completed · ${s.memory.queued} queued · ${s.memory.blocked} blocked · ${s.memory.dismissed} dismissed`}
				/>
				<KV k="last recall" v={ts(s.memory.lastRecallAt)} />
			</div>
			<h2 className="ops-h2">Work</h2>
			<div className="card">
				<KV
					k="programs"
					v={
						s.programs === null ? "—" : `${s.programs.total} total · ${s.programs.enabled} enabled`
					}
				/>
				<KV
					k="delegations"
					v={
						s.delegations === null
							? "—"
							: `${s.delegations.total} total · ${s.delegations.active} active`
					}
				/>
			</div>
		</div>
	);
}
