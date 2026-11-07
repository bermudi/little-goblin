import { type ReactNode, useCallback, useEffect, useState } from "react";
import { cronWords } from "../../src/cron-words.ts";
import type {
	AppApprovalDecisionResponse,
	AppApprovalsResponse,
	AppMailDraft,
	AppProgramChange,
	AppProgramProposal,
} from "../../src/http/app-wire.ts";
import { decideMailApproval, decideProgramApproval, listApprovals } from "./api.ts";
import { DiffView } from "./DiffView.tsx";

export interface ApprovalState {
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

/** The pending list on the Programs page: cards in the wide layout (reason
 *  left, evidence right). The page owns the load, so its summary strip and
 *  this list read one answer; `onChanged` lets it reload what a decision moved. */
export function ApprovalsPanel({
	token,
	approvals,
	onChanged,
}: {
	token: string | null;
	approvals: ApprovalState;
	onChanged?(): void;
}) {
	if (approvals.loading) return <p className="empty">Loading approvals…</p>;
	if (approvals.err !== null) return <p className="error">{approvals.err}</p>;
	const programs = approvals.data?.programs ?? [];
	const mail = approvals.data?.mail ?? [];
	if (programs.length === 0 && mail.length === 0) {
		return <p className="empty">No pending approvals.</p>;
	}
	const onDone = async () => {
		await approvals.refresh();
		onChanged?.();
	};
	return (
		<div className="approval-list ap-list">
			{programs.map((proposal) => (
				<ProgramApprovalCard
					key={`p${proposal.id}`}
					token={token}
					proposal={proposal}
					onDone={onDone}
					layout="page"
				/>
			))}
			{mail.map((draft) => (
				<MailApprovalCard
					key={`m${draft.id}`}
					token={token}
					draft={draft}
					onDone={onDone}
					layout="page"
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
	layout,
	children,
}: {
	token: string | null;
	proposal: AppProgramProposal;
	onDone(): Promise<void>;
	layout?: "page";
	children?: ReactNode;
}) {
	const decision = useDecision(onDone);
	const candidate = proposal.candidate;
	const head = (
		<div className="op-item-head">
			<span className="op-item-title">
				{candidate === null
					? `Program proposal #${proposal.id} — ${proposal.kind === "create" ? "new" : "update"}`
					: proposal.kind === "create"
						? `New program “${candidate.name}”`
						: `Program “${candidate.name}” — update`}
			</span>
			<span className="pill pending">pending</span>
		</div>
	);
	const actions = (
		<>
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
		</>
	);
	const page = layout === "page";
	// On the page the facts move to the reason column, so the evidence shows
	// the program text alone.
	const Program = page ? CandidateBody : ProgramCandidateView;
	const evidence =
		candidate === null ? (
			<p className="error">The target program is gone; approval will refuse.</p>
		) : (
			<>
				{proposal.changes !== null && <ProgramChanges changes={proposal.changes} />}
				{proposal.changes !== null ? (
					<details className="approval-full">
						<summary>Full program after approval</summary>
						<Program candidate={candidate} />
					</details>
				) : (
					<Program candidate={candidate} />
				)}
			</>
		);
	if (page) {
		// Reason on the left, evidence already open on the right; stacked on a
		// narrow pane with the evidence before the buttons.
		return (
			<div className="approval-card ap-page">
				<div className="ap-meta">
					{head}
					{candidate !== null && (
						<div className="approval-facts">
							<span>
								{proposal.kind === "create" ? "New program" : `Update to “${candidate.name}”`}
							</span>
							<span>pinned to {proposal.target}</span>
							<CandidateFacts candidate={candidate} />
						</div>
					)}
				</div>
				<div className="ap-evidence">{evidence}</div>
				<div className="ap-actions">
					{children}
					{actions}
				</div>
			</div>
		);
	}
	return (
		<div className="approval-card">
			{head}
			{evidence}
			{children}
			{actions}
		</div>
	);
}

type Candidate = NonNullable<AppProgramProposal["candidate"]>;

function CandidateBody({ candidate }: { candidate: Candidate }) {
	return (
		<div className="op-item-body">
			<strong>{candidate.name}</strong>
			<pre>{candidate.charter}</pre>
		</div>
	);
}

function CandidateFacts({ candidate }: { candidate: Candidate }) {
	return (
		<>
			{candidate.cron !== null && (
				<span>
					<Schedule cron={candidate.cron} />
				</span>
			)}
			{candidate.maxLatenessMinutes !== null && (
				<span>max {candidate.maxLatenessMinutes}m late</span>
			)}
			{candidate.hook && <span>webhook</span>}
			{candidate.mailFilter !== null && <span>mail {candidate.mailFilter}</span>}
		</>
	);
}

function ProgramCandidateView({ candidate }: { candidate: Candidate }) {
	return (
		<>
			<CandidateBody candidate={candidate} />
			<div className="approval-facts">
				<CandidateFacts candidate={candidate} />
			</div>
		</>
	);
}

function Schedule({ cron }: { cron: string }) {
	const words = cronWords(cron);
	return words === null ? (
		<>{cron}</>
	) : (
		<>
			{words} <span className="cron-raw">({cron})</span>
		</>
	);
}

/** Old → new for a single-line field; a schedule reads in words, cron beside it. */
function ChangeValues({ change }: { change: AppProgramChange }) {
	const show = (v: string) => (change.field === "cron" && v !== "none" ? <Schedule cron={v} /> : v);
	return (
		<div className="approval-change-values">
			<span className="old">{show(change.before)}</span>
			<span aria-hidden="true"> → </span>
			<span className="new">{show(change.after)}</span>
		</div>
	);
}

function ProgramChanges({ changes }: { changes: AppProgramChange[] }) {
	if (changes.length === 0) {
		return <p className="cap">No fields change — the update matches the running program.</p>;
	}
	return (
		<div className="approval-changes">
			<div className="cap">What changes</div>
			{changes.map((change) => (
				<div key={change.field} className="approval-change">
					<div className="approval-change-label">{change.label}</div>
					{change.lines === null ? (
						<ChangeValues change={change} />
					) : (
						<DiffView lines={change.lines} />
					)}
				</div>
			))}
		</div>
	);
}

export function MailApprovalCard({
	token,
	draft,
	onDone,
	layout,
	children,
}: {
	token: string | null;
	draft: AppMailDraft;
	onDone(): Promise<void>;
	layout?: "page";
	children?: ReactNode;
}) {
	const decision = useDecision(onDone);
	const sending = draft.status === "sending";
	const head = (
		<div className="op-item-head">
			<span className="op-item-title">Mail draft #{draft.id}</span>
			<span className="pill pending">
				{sending ? "send outcome unresolved" : `expires ${draft.expiresAt}`}
			</span>
		</div>
	);
	const facts = (
		<div className="approval-facts">
			<span>To: {draft.to.join(", ")}</span>
			{draft.cc.length > 0 && <span>Cc: {draft.cc.join(", ")}</span>}
			<span>Subject: {draft.subject || "(no subject)"}</span>
			{draft.replyToId !== null && <span>Reply to: {draft.replyToId}</span>}
		</div>
	);
	const body = <pre className="mail-body">{draft.body}</pre>;
	const actions = (
		<>
			{sending && (
				<p role="alert">
					This send may still be in progress or may have completed. Check Gmail Sent before
					cancelling or re-queueing; cancelling an abandoned send does not prove it was unsent.
				</p>
			)}
			<div className="approval-actions">
				<button
					type="button"
					disabled={sending || decision.busy || decision.result?.hookUrl !== undefined}
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
		</>
	);
	if (layout === "page") {
		return (
			<div className="approval-card ap-page">
				<div className="ap-meta">
					{head}
					{facts}
				</div>
				<div className="ap-evidence">{body}</div>
				<div className="ap-actions">
					{children}
					{actions}
				</div>
			</div>
		);
	}
	return (
		<div className="approval-card">
			{head}
			{facts}
			{body}
			{children}
			{actions}
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
