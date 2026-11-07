import type {
	OperatorDelegationItem,
	OperatorStatusResponse,
} from "../../src/http/operator-wire.ts";
import { getServiceStatus, listDelegations } from "./api.ts";
import { KV, ts, uptime, useLoad } from "./opsShared.tsx";

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
