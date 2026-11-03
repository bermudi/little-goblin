// The responsibility feed — one row per project-owned responsibility:
// a pill summary (status, attached agents + observed health, freshness,
// next check-in) that expands into the correctable understanding,
// attachment identity, prompt-operation delivery state, and the event
// history with wake dispositions. Controls are the same verbs the
// coordination tool owns; every mutation refetches the durable truth.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	attachmentAction,
	correctResponsibility,
	listProjectResponsibilities,
	listResponsibilities,
	responsibilityAction,
} from "./api.ts";
import type {
	AppFeedItem,
	AppFeedPost,
	AppResponsibilityAttachment,
} from "../../src/http/app-wire.ts";

const POLL_MS = 15_000;

function fmt(at: string | null): string {
	if (at === null) return "—";
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

function age(at: string | null): string {
	if (at === null) return "no activity";
	const ms = Date.now() - Date.parse(at);
	if (Number.isNaN(ms)) return at;
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

const WAITS: Record<AppFeedItem["stage"]["waitsFor"], string> = {
	operator: "Waiting on you",
	goblin: "Goblin's move",
	worker: "Worker's move",
	nobody: "Nobody's move",
};

// Whose word a post is — a worker's claim must never read as goblin's
// assessment (design/programs.md → Worker reports).
const REVIEW: Record<AppFeedPost["review"], string> = {
	assessed: "goblin",
	unreviewed: "worker claim · unreviewed",
	reviewed: "worker claim · reviewed",
	migrated: "migrated status",
};

function PostCard({ post }: { post: AppFeedPost }) {
	const p = post.report;
	return (
		<div
			className={`resp-post resp-post-${p.state} resp-review-${post.review}${post.current ? "" : " resp-post-stale"}`}
		>
			<p className="resp-post-head">
				<span className="resp-post-state">{p.state}</span>
				<span className="resp-post-review">{REVIEW[post.review]}</span>
				<span className="resp-rev">
					{age(p.createdAt)} · rev {p.revision}
					{post.current ? "" : " · before a correction"}
				</span>
			</p>
			<p className="resp-post-reason">{p.reason}</p>
			{p.question !== null && (
				<p className="resp-post-question">
					<strong>Question:</strong> {p.question}
				</p>
			)}
			{p.resumeWhen !== null && (
				<p>
					<strong>Resumes when:</strong> {p.resumeWhen}
				</p>
			)}
			{p.evidence.length > 0 && (
				<ul className="resp-evidence">
					{p.evidence.map((e) => (
						<li key={e.item}>
							<strong>{e.item}</strong> — {e.checked} <span className="resp-rev">({e.ref})</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

const HEALTH: Record<string, string> = {
	attached: "attached",
	missing: "missing",
	identity_changed: "replaced",
	detached: "detached",
};

function AttachmentRow({
	att,
	respId,
	onAct,
	busy,
}: {
	att: AppResponsibilityAttachment;
	respId: string;
	onAct: (attachmentId: number, action: "detach" | "reattach") => void;
	busy: boolean;
}) {
	const t = att.target;
	return (
		<div className="resp-att">
			<span className="resp-att-name">{t.agentName}</span>
			<span className="resp-att-health">{HEALTH[att.health] ?? att.health}</span>
			<span className="resp-att-meta">
				{t.kind ?? "?"} · gen {att.generation}
				{t.terminalId !== null ? ` · ${t.terminalId}` : ""}
				{t.agentSession !== null ? ` · ${t.agentSession}` : " · no session id"}
			</span>
			{att.health === "detached" ? (
				<button
					type="button"
					className="ghost"
					disabled={busy}
					onClick={() => onAct(att.attachmentId, "reattach")}
				>
					Reattach
				</button>
			) : (
				<button
					type="button"
					className="ghost"
					disabled={busy}
					onClick={() => onAct(att.attachmentId, "detach")}
				>
					Detach
				</button>
			)}
		</div>
	);
}

function FeedRow({
	item,
	token,
	onChanged,
	busy,
	setBusy,
	onConversation,
}: {
	item: AppFeedItem;
	token: string | null;
	onChanged: () => void;
	busy: boolean;
	setBusy: (b: boolean) => void;
	onConversation?: ((conversationId: string) => void) | undefined;
}) {
	const r = item.responsibility;
	const [expanded, setExpanded] = useState(false);
	const [correcting, setCorrecting] = useState(false);
	const [comment, setComment] = useState("");
	const [mutationError, setMutationError] = useState<string | null>(null);
	// Translate a rejected HTTP mutation into visible operator feedback;
	// keep the draft and controls intact, and never retry automatically.
	const failed = (action: string, err: unknown) => {
		setBusy(false);
		setMutationError(
			`Couldn't ${action}: ${err instanceof Error ? err.message : String(err)}. Check the current state before retrying.`,
		);
	};
	const open = r.status === "active" || r.status === "paused";
	const newest = item.posts[0];
	const openConv =
		onConversation === undefined ? null : (
			<button
				type="button"
				className="ghost resp-open-conv"
				onClick={() => onConversation(r.coordinationConversationId)}
			>
				Open conversation
			</button>
		);

	const act = (action: "pause" | "resume" | "cancel") => {
		setMutationError(null);
		setBusy(true);
		void responsibilityAction(token, r.responsibilityId, action).then(
			() => {
				setBusy(false);
				onChanged();
			},
			(err: unknown) => failed(action, err),
		);
	};
	const sendCorrection = () => {
		const text = comment.trim();
		if (text === "") return;
		setMutationError(null);
		setBusy(true);
		void correctResponsibility(token, r.responsibilityId, { text }).then(
			() => {
				setComment("");
				setCorrecting(false);
				setBusy(false);
				onChanged();
			},
			(err: unknown) => failed("send correction", err),
		);
	};
	const onAttachment = (attachmentId: number, action: "detach" | "reattach") => {
		setMutationError(null);
		setBusy(true);
		void attachmentAction(token, r.responsibilityId, attachmentId, action).then(
			() => {
				setBusy(false);
				onChanged();
			},
			(err: unknown) => failed(`${action} attachment ${attachmentId}`, err),
		);
	};

	return (
		<div className="resp-row">
			<details className="resp-item" onToggle={(e) => setExpanded(e.currentTarget.open)}>
				<summary className="resp-pill">
					<span
						className={`resp-status resp-waits-${item.stage.waitsFor} resp-stage-${item.stage.stage}`}
						title={item.stage.reason}
					>
						{item.stage.stage}
					</span>
					<span className="resp-outcome">{r.outcome}</span>
					<span className="resp-agents">
						{item.attachments
							.filter((a) => a.health !== "detached")
							.map((a) => `${a.target.agentName} (${HEALTH[a.health] ?? a.health})`)
							.join(", ")}
					</span>
					<span className="resp-fresh">{age(item.lastActivityAt)}</span>
					{item.nextCheckinAt !== null && (
						<span className="resp-next">check-in {fmt(item.nextCheckinAt)}</span>
					)}
				</summary>
				<div className="resp-detail">
					{mutationError !== null && (
						<p className="error" role="alert">
							{mutationError}
						</p>
					)}
					{r.notArmedReason !== null && <p className="resp-warn">not armed — {r.notArmedReason}</p>}
					<p className="resp-stage-line">
						<strong>{WAITS[item.stage.waitsFor]}:</strong> {item.stage.reason}
					</p>
					{item.posts.length > 0 && (
						<div className="resp-section">
							<h4>Posts</h4>
							{item.posts.map((p) => (
								<PostCard key={p.report.reportId} post={p} />
							))}
							{item.postsTruncated > 0 && (
								<p className="resp-events-older">
									{item.postsTruncated} older post{item.postsTruncated === 1 ? "" : "s"} on the
									record
								</p>
							)}
						</div>
					)}
					<p className="resp-next">
						<strong>Next Review:</strong>{" "}
						{item.nextCheckinAt === null
							? "not scheduled"
							: item.nextCheckinReason === null
								? fmt(item.nextCheckinAt)
								: `${fmt(item.nextCheckinAt)} - ${item.nextCheckinReason}`}
					</p>
					<div className="resp-understanding">
						<p>
							<strong>Outcome:</strong> {r.understanding.outcome}
						</p>
						<p>
							<strong>Situation:</strong> {r.understanding.situation}
						</p>
						<p>
							<strong>Next:</strong> {r.understanding.nextAction}
						</p>
						{r.understanding.checkpoints.length > 0 && (
							<p>
								<strong>Checkpoints:</strong> {r.understanding.checkpoints.join("; ")}
							</p>
						)}
						{r.understanding.completionEvidence.length > 0 && (
							<p>
								<strong>Evidence:</strong> {r.understanding.completionEvidence.join("; ")}
							</p>
						)}
						<p className="resp-rev">rev {r.revision}</p>
					</div>

					{item.attachments.length > 0 && (
						<div className="resp-section">
							<h4>Attachments</h4>
							{item.attachments.map((a) => (
								<AttachmentRow
									key={a.attachmentId}
									att={a}
									respId={r.responsibilityId}
									onAct={onAttachment}
									busy={busy}
								/>
							))}
						</div>
					)}

					{item.operations.length > 0 && (
						<div className="resp-section">
							<h4>Prompt operations</h4>
							{item.operations.map((op) => (
								<div key={op.operationId} className="resp-op">
									<span className="resp-op-state">{op.state}</span>
									<span className="resp-op-brief">{op.brief}</span>
									<span className="resp-op-meta">
										{op.refusal !== null ? `refused: ${op.refusal}` : ""}
										{op.sentAt !== null ? ` · sent ${fmt(op.sentAt)}` : ""}
									</span>
								</div>
							))}
						</div>
					)}

					{item.events.length > 0 && (
						<div className="resp-section">
							<h4>History</h4>
							{item.eventsTruncated > 0 && (
								<p className="resp-events-older">
									{item.eventsTruncated} older event{item.eventsTruncated === 1 ? "" : "s"} on the
									record — showing the newest {item.events.length}
								</p>
							)}
							{item.events.map((e) => (
								<div key={e.eventId} className="resp-event">
									<span className="resp-event-kind">{e.kind}</span>
									<span className="resp-event-origin">{e.origin}</span>
									<span className="resp-event-text">{e.text}</span>
									<span className="resp-event-meta">
										{fmt(e.createdAt)}
										{e.wake !== null &&
											` · wake ${e.wake.state}${e.wake.lastError !== null ? ` — ${e.wake.lastError}` : ""}`}
									</span>
								</div>
							))}
						</div>
					)}

					<div className="resp-controls">
						{openConv}
						{open && (
							<>
								<button
									type="button"
									className="ghost"
									disabled={busy}
									onClick={() => setCorrecting(!correcting)}
								>
									Correct
								</button>
								{r.status === "paused" ? (
									<button
										type="button"
										className="ghost"
										disabled={busy}
										onClick={() => act("resume")}
									>
										Resume
									</button>
								) : (
									<button
										type="button"
										className="ghost"
										disabled={busy}
										onClick={() => act("pause")}
									>
										Pause
									</button>
								)}
								<button
									type="button"
									className="ghost"
									disabled={busy}
									onClick={() => act("cancel")}
								>
									Cancel
								</button>
							</>
						)}
					</div>
					{correcting && (
						<div className="resp-correct">
							<textarea
								disabled={busy}
								value={comment}
								onChange={(e) => setComment(e.target.value)}
								placeholder="A correction or note — it lands in the work's conversation as durable context"
								rows={2}
							/>
							<button
								type="button"
								disabled={busy || comment.trim() === ""}
								onClick={sendCorrection}
							>
								Send correction
							</button>
						</div>
					)}
				</div>
			</details>
			{!expanded && (newest !== undefined || openConv !== null) && (
				<div className="resp-glance">
					{newest !== undefined && <PostCard post={newest} />}
					{openConv}
				</div>
			)}
		</div>
	);
}

export function ResponsibilityFeed({
	token,
	projectId,
	pollMs = POLL_MS,
	onConversation,
}: {
	token: string | null;
	/** null = the home aggregation across projects. */
	projectId: string | null;
	/** Poll cadence; the default is production's. */
	pollMs?: number;
	/** Opens the work's coordination conversation — where comments and
	 *  corrections keep the item's context. */
	onConversation?: ((conversationId: string) => void) | undefined;
}) {
	const [items, setItems] = useState<AppFeedItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Monotonic response ordering: a poll that resolves after a newer
	// refresh (the one a mutation triggered, or a later interval tick)
	// must not overwrite post-mutation state with its stale snapshot.
	const seqRef = useRef(0);
	// Ordinary polls never stack: with sustained latency above the
	// interval, a new request every tick would make every completed
	// response stale by seq — the feed would never render at all. The
	// counter (not a boolean) stays honest when a mutation's refresh
	// overlaps an in-flight poll.
	const inflightRef = useRef(0);

	const refresh = useCallback(() => {
		const seq = ++seqRef.current;
		inflightRef.current += 1;
		const settle = () => {
			inflightRef.current -= 1;
		};
		const fetcher =
			projectId === null
				? listResponsibilities(token)
				: listProjectResponsibilities(token, projectId);
		void fetcher.then(
			(res) => {
				settle();
				if (seq !== seqRef.current) return;
				setItems(res?.items ?? []);
				setError(null);
			},
			(err) => {
				settle();
				if (seq !== seqRef.current) return;
				setError(err instanceof Error ? err.message : String(err));
			},
		);
	}, [token, projectId]);

	useEffect(() => {
		refresh();
		const t = setInterval(() => {
			if (inflightRef.current === 0) refresh();
		}, pollMs);
		return () => clearInterval(t);
	}, [refresh, pollMs]);

	if (items === null && error === null) return null;
	if (items === null || items.length === 0) {
		if (error !== null) return <p className="empty">Couldn't load the work feed: {error}</p>;
		return null;
	}
	return (
		<div className="resp-feed">
			<h3 className="resp-feed-h">Handed-over work</h3>
			{error !== null && (
				<p className="error" role="alert">
					Refresh failed — the rows below are the last loaded state: {error}
				</p>
			)}
			{(items ?? []).map((item) => (
				<FeedRow
					key={item.responsibility.responsibilityId}
					item={item}
					token={token}
					onChanged={refresh}
					busy={busy}
					setBusy={setBusy}
					onConversation={onConversation}
				/>
			))}
		</div>
	);
}
