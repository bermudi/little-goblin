import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";
import { listDelegations } from "./api.ts";
import { KV, ts, useLoad } from "./opsShared.tsx";

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
