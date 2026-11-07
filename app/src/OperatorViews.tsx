import type { OperatorStatusResponse } from "../../src/http/operator-wire.ts";
import { getServiceStatus } from "./api.ts";
import { KV, ts, uptime, useLoad } from "./opsShared.tsx";

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
