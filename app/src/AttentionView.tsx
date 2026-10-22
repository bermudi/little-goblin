import { getAttention } from "./api.ts";
import { KV, ts, useLoad } from "./opsShared.tsx";
import { PushControls } from "./PushControls.tsx";
import type { AppAttentionPage, AppAttentionTarget } from "../../src/http/app-wire.ts";

const KIND_LABEL = {
	"program-approval": "program",
	"mail-approval": "mail",
	"memory-blocked": "memory",
	"skill-proposal": "skill",
	"interrupted-run": "recovery",
	"delegation-input": "delegation",
} as const;

export function AttentionView({
	token,
	onPage,
	onConversation,
}: {
	token: string | null;
	onPage(page: AppAttentionPage): void;
	onConversation(conversationId: string): void;
}) {
	const { data, err } = useLoad(() => getAttention(token));
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

	const open = (target: AppAttentionTarget) => {
		if (target.kind === "page") onPage(target.page);
		else onConversation(target.conversationId);
	};

	return (
		<div className="ops">
			<PushControls token={token} />
			{data.unavailable.length > 0 && (
				<div className="card">
					<KV k="unavailable" v={data.unavailable.join(", ")} />
					<div className="cap ops-cap">
						Those owners are not wired on this service; the rest of the inbox still reads.
					</div>
				</div>
			)}
			{data.items.length === 0 ? (
				<p className="empty">Nothing needs you.</p>
			) : (
				data.items.map((item) => (
					<div className="card" key={item.id}>
						<div className="op-item-head">
							<span className="op-item-title">{item.title}</span>
							<span className="pill">{KIND_LABEL[item.kind]}</span>
						</div>
						<div className="op-item-body">{item.detail}</div>
						{item.createdAt !== null && <KV k="created" v={ts(item.createdAt)} />}
						<div className="approval-actions">
							<button type="button" onClick={() => open(item.target)}>
								{item.target.kind === "conversation" ? "Open conversation" : "Open"}
							</button>
						</div>
					</div>
				))
			)}
		</div>
	);
}
