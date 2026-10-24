import { useCallback, useEffect, useState } from "react";
import { decideMailApproval, decideProgramApproval, listApprovals } from "./api.ts";
import type {
	AppApprovalDecisionResponse,
	AppApprovalsResponse,
	AppMailDraft,
	AppProgramProposal,
} from "../../src/http/app-wire.ts";

interface ApprovalState {
	data: AppApprovalsResponse | null;
	err: string | null;
	loading: boolean;
	refresh(): Promise<void>;
}

export function useApprovals(token: string | null): ApprovalState {
	const [data, setData] = useState<AppApprovalsResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const refresh = useCallback(async () => {
		try {
			setData(await listApprovals(token));
			setErr(null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [token]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return { data, err, loading, refresh };
}

export function ApprovalCard({
	token,
	kind,
	id,
}: {
	token: string | null;
	kind: "program" | "mail";
	id: number;
}) {
	const approvals = useApprovals(token);
	if (approvals.loading) return <div className="approval-card empty">Loading approval…</div>;
	if (approvals.err !== null) return <div className="approval-card error">{approvals.err}</div>;
	const item =
		kind === "program"
			? approvals.data?.programs.find((p) => p.id === id)
			: approvals.data?.mail.find((m) => m.id === id);
	if (item === undefined) {
		return <div className="approval-card settled">Approval #{id} is no longer pending.</div>;
	}
	return kind === "program" ? (
		<ProgramApprovalCard
			token={token}
			proposal={item as AppProgramProposal}
			onDone={approvals.refresh}
		/>
	) : (
		<MailApprovalCard token={token} draft={item as AppMailDraft} onDone={approvals.refresh} />
	);
}

export function ApprovalsPanel({ token }: { token: string | null }) {
	const approvals = useApprovals(token);
	if (approvals.loading) return <p className="empty">Loading approvals…</p>;
	if (approvals.err !== null) return <p className="error">{approvals.err}</p>;
	const programs = approvals.data?.programs ?? [];
	const mail = approvals.data?.mail ?? [];
	if (programs.length === 0 && mail.length === 0) {
		return <p className="empty">No pending approvals.</p>;
	}
	return (
		<div className="approval-list">
			{programs.map((proposal) => (
				<ProgramApprovalCard
					key={`p${proposal.id}`}
					token={token}
					proposal={proposal}
					onDone={approvals.refresh}
				/>
			))}
			{mail.map((draft) => (
				<MailApprovalCard
					key={`m${draft.id}`}
					token={token}
					draft={draft}
					onDone={approvals.refresh}
				/>
			))}
		</div>
	);
}

function useDecision(onDone: () => Promise<void>): {
	busy: boolean;
	result: AppApprovalDecisionResponse | null;
	err: string | null;
	run(action: () => Promise<AppApprovalDecisionResponse>): Promise<void>;
	dismiss(): Promise<void>;
} {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<AppApprovalDecisionResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const run = useCallback(
		async (action: () => Promise<AppApprovalDecisionResponse>) => {
			setBusy(true);
			setErr(null);
			try {
				const res = await action();
				setResult(res);
				// A granted hook URL is revealed once and never refetchable,
				// so the refresh that drops this settled card waits for the
				// operator to dismiss the result.
				if (res.hookUrl === undefined) await onDone();
			} catch (e) {
				setErr(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[onDone],
	);
	const dismiss = useCallback(() => onDone(), [onDone]);
	return { busy, result, err, run, dismiss };
}

export function SecretReveal({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="secret-reveal">
			<div className="cap">Webhook URL — shown once; keep it secret.</div>
			<pre>{url}</pre>
			<button
				type="button"
				onClick={() => {
					void navigator.clipboard
						.writeText(url)
						.then(() => setCopied(true))
						.catch(() => setCopied(false));
				}}
			>
				{copied ? "copied" : "copy URL"}
			</button>
		</div>
	);
}

export function ProgramApprovalCard({
	token,
	proposal,
	onDone,
}: {
	token: string | null;
	proposal: AppProgramProposal;
	onDone(): Promise<void>;
}) {
	const decision = useDecision(onDone);
	const candidate = proposal.candidate;
	return (
		<div className="approval-card">
			<div className="op-item-head">
				<span className="op-item-title">
					Program proposal #{proposal.id} — {proposal.kind === "create" ? "new" : "update"}
				</span>
				<span className="pill pending">pending</span>
			</div>
			{candidate === null ? (
				<p className="error">The target program is gone; approval will refuse.</p>
			) : (
				<>
					<div className="op-item-body">
						<strong>{candidate.name}</strong>
						<pre>{candidate.charter}</pre>
					</div>
					<div className="approval-facts">
						{candidate.cron !== null && <span>cron {candidate.cron}</span>}
						{candidate.maxLatenessMinutes !== null && (
							<span>max {candidate.maxLatenessMinutes}m late</span>
						)}
						{candidate.hook && <span>webhook</span>}
						{candidate.mailFilter !== null && <span>mail {candidate.mailFilter}</span>}
					</div>
				</>
			)}
			<div className="approval-actions">
				<button
					type="button"
					disabled={decision.busy || candidate === null || decision.result?.hookUrl !== undefined}
					onClick={() =>
						void decision.run(() => decideProgramApproval(token, proposal.id, "approve"))
					}
				>
					Approve
				</button>
				<button
					type="button"
					className="danger"
					disabled={decision.busy || decision.result?.hookUrl !== undefined}
					onClick={() =>
						void decision.run(() => decideProgramApproval(token, proposal.id, "reject"))
					}
				>
					Reject
				</button>
			</div>
			<DecisionResult decision={decision} />
		</div>
	);
}

export function MailApprovalCard({
	token,
	draft,
	onDone,
}: {
	token: string | null;
	draft: AppMailDraft;
	onDone(): Promise<void>;
}) {
	const decision = useDecision(onDone);
	return (
		<div className="approval-card">
			<div className="op-item-head">
				<span className="op-item-title">Mail draft #{draft.id}</span>
				<span className="pill pending">expires {draft.expiresAt}</span>
			</div>
			<div className="approval-facts">
				<span>To: {draft.to.join(", ")}</span>
				{draft.cc.length > 0 && <span>Cc: {draft.cc.join(", ")}</span>}
				<span>Subject: {draft.subject || "(no subject)"}</span>
				{draft.replyToId !== null && <span>Reply to: {draft.replyToId}</span>}
			</div>
			<pre className="mail-body">{draft.body}</pre>
			<div className="approval-actions">
				<button
					type="button"
					disabled={decision.busy || decision.result?.hookUrl !== undefined}
					onClick={() => void decision.run(() => decideMailApproval(token, draft.id, "send"))}
				>
					Send
				</button>
				<button
					type="button"
					className="danger"
					disabled={decision.busy || decision.result?.hookUrl !== undefined}
					onClick={() => void decision.run(() => decideMailApproval(token, draft.id, "cancel"))}
				>
					Cancel
				</button>
			</div>
			<DecisionResult decision={decision} />
		</div>
	);
}

function DecisionResult({
	decision,
}: {
	decision: {
		busy: boolean;
		result: AppApprovalDecisionResponse | null;
		err: string | null;
		dismiss(): Promise<void>;
	};
}) {
	return (
		<>
			{decision.busy && <p className="cap">Working…</p>}
			{decision.err !== null && <p className="error">{decision.err}</p>}
			{decision.result !== null && (
				<div className={`approval-result st-${decision.result.status}`}>
					{decision.result.message}
					{decision.result.hookUrl !== undefined && (
						<>
							<SecretReveal url={decision.result.hookUrl} />
							<button type="button" onClick={() => void decision.dismiss()}>
								Done
							</button>
						</>
					)}
				</div>
			)}
		</>
	);
}
