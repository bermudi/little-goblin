// The Attention page (design/app.md → Attention page, #150): a one-line
// summary, what is broken, the decisions that wait with their evidence
// open and their buttons on the card, then everything else. Work in
// progress and notifications sit below because they are not decisions.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
	AppAttentionItem,
	AppAttentionMemoryCause,
	AppAttentionPage,
	AppAttentionTarget,
	AppFeedItem,
} from "../../src/http/app-wire.ts";
import type { MemoryStatusResponse } from "../../src/http/operator-wire.ts";
import { MailApprovalCard, ProgramApprovalCard, useApprovals } from "./Approvals.tsx";
import { decideBlockedMemory, getAttention, getMemoryStatus, listSkills } from "./api.ts";
import { RetryCard } from "./MemoryView.tsx";
import { describe, useLoad } from "./opsShared.tsx";
import { PushControls } from "./PushControls.tsx";
import { ResponsibilityFeed } from "./ResponsibilityFeed.tsx";
import { ProposalCard } from "./SkillsView.tsx";

const KIND_LABEL = {
	"program-approval": "program",
	"mail-approval": "mail",
	"memory-blocked": "memory",
	"skill-proposal": "skill",
	"interrupted-run": "recovery",
	"delegation-input": "delegation",
	responsibility: "work",
} as const satisfies Record<AppAttentionItem["kind"], string>;

const DECISION_KINDS: ReadonlySet<AppAttentionItem["kind"]> = new Set([
	"program-approval",
	"mail-approval",
	"skill-proposal",
]);

// While a retry drains, the page follows it closely (the Memory page does too).
const RETRY_POLL_MS = 2_000;
const NAMES_SHOWN = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function age(iso: string | null): string | null {
	if (iso === null) return null;
	const ms = Date.now() - Date.parse(iso);
	if (Number.isNaN(ms)) return null;
	if (ms < 3_600_000) return "just now";
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours`;
	return plural(Math.floor(ms / 86_400_000), "day");
}

function summaryLine(broken: number, decisions: number, others: number): string {
	const parts: string[] = [];
	if (broken > 0) parts.push(`${plural(broken, "thing is", "things are")} broken.`);
	if (decisions > 0)
		parts.push(`${plural(decisions, "decision")} wait${decisions === 1 ? "s" : ""} for you.`);
	if (others > 0)
		parts.push(`${plural(others, "other item")} ${others === 1 ? "needs" : "need"} a look.`);
	return parts.length === 0 ? "Nothing needs you." : parts.join(" ");
}

function Age({ iso }: { iso: string | null }) {
	const text = age(iso);
	return text === null ? null : <span className="attn-age">{text}</span>;
}

function IfYouWait({ children }: { children: string }) {
	return (
		<div className="attn-wait">
			<b>If you wait:</b>
			<span>{children}</span>
		</div>
	);
}

function MemoryCauseCard({
	cause,
	since,
	token,
	onMemoryPage,
	onActed,
}: {
	cause: AppAttentionMemoryCause;
	since: string | null;
	token: string | null;
	onMemoryPage(): void;
	onActed(action: "retry" | "dismiss", affected: number): void;
}) {
	const [confirmDrop, setConfirmDrop] = useState(false);
	const [busy, setBusy] = useState<"retry" | "dismiss" | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const names = cause.conversations.slice(0, NAMES_SHOWN);
	const hidden = cause.conversations.length - names.length;
	const act = (action: "retry" | "dismiss") => {
		setBusy(action);
		setErr(null);
		decideBlockedMemory(token, action, cause.error).then(
			(res) => onActed(action, res.affected),
			(e: unknown) => {
				setBusy(null);
				setErr(describe(e));
			},
		);
	};
	return (
		<article className="attn-card attn-problem" aria-label="Blocked memory exchanges">
			<div className="attn-head">
				<h3>Memory can't save {plural(cause.count, "exchange")}</h3>
				<Age iso={since} />
			</div>
			<div className="prose attn-body">
				<p>
					Saving failed with{" "}
					<code className="attn-error">{cause.error ?? "no error recorded"}</code>. You can still
					chat, and Goblin can still recall what it already knows.
				</p>
				<p className="attn-fix">{cause.fix}</p>
				{names.length > 0 && (
					<p className="attn-from">
						From{" "}
						{names.map((c, i) => (
							<Fragment key={c.conversationId ?? "none"}>
								{i > 0 && ", "}
								<b>{c.name ?? "unknown conversation"}</b> ({c.count})
							</Fragment>
						))}
						{hidden > 0 ? ` and ${plural(hidden, "other conversation")}` : ""}.
					</p>
				)}
			</div>
			<IfYouWait>
				{`${plural(cause.count, "exchange")} stay${cause.count === 1 ? "s" : ""} out of memory. The chats themselves are kept.`}
			</IfYouWait>
			{confirmDrop ? (
				<div className="attn-actions">
					<span className="attn-confirm">
						Drop {plural(cause.count, "exchange")}? Memory will never save them.
					</span>
					<button
						type="button"
						className="danger"
						disabled={busy !== null}
						onClick={() => {
							setConfirmDrop(false);
							act("dismiss");
						}}
					>
						{busy === "dismiss" ? "Dropping…" : `Drop ${plural(cause.count, "exchange")}`}
					</button>
					<button type="button" className="ghost" onClick={() => setConfirmDrop(false)}>
						Keep them
					</button>
				</div>
			) : (
				<div className="attn-actions">
					<button
						type="button"
						className="attn-primary"
						disabled={busy !== null}
						onClick={() => act("retry")}
					>
						{busy === "retry" ? "Requeueing…" : "Try again"}
					</button>
					<button
						type="button"
						className="ghost"
						disabled={busy !== null}
						onClick={() => setConfirmDrop(true)}
					>
						Drop them
					</button>
					<button type="button" className="attn-link" onClick={onMemoryPage}>
						Open the Memory page
					</button>
				</div>
			)}
			{err !== null && <p className="error">{err}</p>}
		</article>
	);
}

function OtherCard({
	item,
	onOpen,
}: {
	item: AppAttentionItem;
	onOpen(target: AppAttentionTarget): void;
}) {
	return (
		<article className="attn-card">
			<div className="attn-head">
				<h3>{item.title}</h3>
				<span className="pill">{KIND_LABEL[item.kind]}</span>
				<Age iso={item.createdAt} />
			</div>
			<p className="attn-detail">{item.detail}</p>
			<div className="attn-actions">
				<button type="button" className="ghost" onClick={() => onOpen(item.target)}>
					{item.target.kind === "conversation" ? "Open conversation" : "Open"}
				</button>
			</div>
		</article>
	);
}

export function AttentionView({
	token,
	onPage,
	onConversation,
}: {
	token: string | null;
	onPage(page: AppAttentionPage): void;
	onConversation(conversationId: string): void;
}) {
	const attention = useLoad(() => getAttention(token));
	const skills = useLoad(() => listSkills(token));
	const approvals = useApprovals(token);
	const [watching, setWatching] = useState(false);
	const [memoryStatus, setMemoryStatus] = useState<MemoryStatusResponse | null>(null);
	const [dropped, setDropped] = useState<string[]>([]);
	// null = no feed snapshot yet (loading or failed); the "Work in
	// progress" section only disappears once the feed says it's empty.
	const [feedItems, setFeedItems] = useState<AppFeedItem[] | null>(null);
	const onFeedItems = useCallback((items: AppFeedItem[] | null) => setFeedItems(items), []);

	// After Try again the exchanges leave the blocked list; the page follows
	// them (saved / queued / failed again) until the batch has settled, and
	// re-reads the cards so a failure that came back shows as a card again.
	const settled =
		memoryStatus !== null && memoryStatus.retry !== null && memoryStatus.retry.queued === 0;
	const polling = watching && !settled;
	// useLoad's reload is a new function every render; the poll must not restart with it.
	const reloadAttention = useRef(attention.reload);
	reloadAttention.current = attention.reload;
	useEffect(() => {
		if (!polling) return;
		let live = true;
		const tick = () => {
			void getMemoryStatus(token).then(
				(s) => {
					if (!live) return;
					setMemoryStatus(s);
					reloadAttention.current();
				},
				() => undefined,
			);
		};
		tick();
		const t = setInterval(tick, RETRY_POLL_MS);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [polling, token]);

	if (attention.err !== null)
		return (
			<div className="ops">
				<p className="error">{attention.err}</p>
			</div>
		);
	if (attention.data === null)
		return (
			<div className="ops">
				<p className="empty">Loading…</p>
			</div>
		);
	const { items, unavailable } = attention.data;

	const open = (target: AppAttentionTarget) => {
		if (target.kind === "page") onPage(target.page);
		else onConversation(target.conversationId);
	};
	const reloadAll = async () => {
		await approvals.refresh();
		skills.reload();
		attention.reload();
	};

	const broken = items.filter((i) => i.kind === "memory-blocked" && i.memory !== undefined);
	const decisions = items.filter((i) => DECISION_KINDS.has(i.kind));
	const others = items.filter((i) => i.kind !== "memory-blocked" && !DECISION_KINDS.has(i.kind));
	const retry = watching ? (memoryStatus?.retry ?? null) : null;

	const decisionCard = (item: AppAttentionItem) => {
		const [, key = ""] = /^[^:]+:(.*)$/.exec(item.id) ?? [];
		if (item.kind === "program-approval") {
			const proposal = approvals.data?.programs.find((p) => String(p.id) === key);
			if (proposal === undefined)
				return approvals.loading ? <p className="empty">Loading…</p> : null;
			return (
				<ProgramApprovalCard token={token} proposal={proposal} onDone={reloadAll} layout="page">
					<IfYouWait>
						{proposal.kind === "create"
							? "the program does not exist yet, so nothing runs."
							: "it keeps running under its current rules."}
					</IfYouWait>
				</ProgramApprovalCard>
			);
		}
		if (item.kind === "mail-approval") {
			const draft = approvals.data?.mail.find((m) => String(m.id) === key);
			if (draft === undefined) return approvals.loading ? <p className="empty">Loading…</p> : null;
			return (
				<MailApprovalCard token={token} draft={draft} onDone={reloadAll} layout="page">
					<IfYouWait>it is not sent, and the draft expires.</IfYouWait>
				</MailApprovalCard>
			);
		}
		const proposal = skills.data?.proposed.find((p) => p.name === key);
		if (proposal === undefined)
			// data === null with err set means listSkills failed — fall
			// through to OtherCard's Open instead of Loading… forever.
			return skills.data === null && skills.err === null ? <p className="empty">Loading…</p> : null;
		return (
			<ProposalCard proposal={proposal} token={token} onDecided={reloadAll}>
				<IfYouWait>Goblin keeps working with the skills it has.</IfYouWait>
			</ProposalCard>
		);
	};

	return (
		<div className="ops attn-page">
			<h1 className="attn-title">Attention</h1>
			<p className="attn-summary" aria-live="polite">
				{summaryLine(broken.length, decisions.length, others.length)}
			</p>

			{(broken.length > 0 || retry !== null || dropped.length > 0) && (
				<section aria-label="Broken">
					<h2 className="ops-h2">Broken</h2>
					{broken.map((item) =>
						item.memory === undefined ? null : (
							<MemoryCauseCard
								key={item.id}
								cause={item.memory}
								since={item.createdAt}
								token={token}
								onMemoryPage={() => onPage("memory")}
								onActed={(action, affected) => {
									if (action === "retry") {
										// Drop the settled batch, or a second
										// retry never restarts the poll.
										setMemoryStatus(null);
										setWatching(true);
									} else
										setDropped((d) => [
											...d,
											`Dropped ${plural(affected, "exchange")}. They are not in memory.`,
										]);
									attention.reload();
								}}
							/>
						),
					)}
					{dropped.map((text) => (
						<p className="attn-done" key={text}>
							{text}
						</p>
					))}
					{retry !== null && <RetryCard retry={retry} />}
				</section>
			)}

			{decisions.length > 0 && (
				<section aria-label="Your decisions">
					<h2 className="ops-h2">Your decisions</h2>
					{decisions.map((item) => (
						<div className="attn-decision" key={item.id}>
							{decisionCard(item) ?? <OtherCard item={item} onOpen={open} />}
						</div>
					))}
				</section>
			)}

			{others.length > 0 && (
				<section aria-label="Needs you">
					<h2 className="ops-h2">Needs you</h2>
					{others.map((item) => (
						<OtherCard key={item.id} item={item} onOpen={open} />
					))}
				</section>
			)}

			{items.length === 0 && (
				<section className="attn-clear" aria-label="All clear">
					<h2>All clear</h2>
					<p>No work is waiting on you.</p>
				</section>
			)}

			{unavailable.length > 0 && (
				<p className="cap attn-unavailable">
					Not wired on this service, so not checked: {unavailable.join(", ")}.
				</p>
			)}

			{/* One place to watch: what needs the operator above, the work in
			    flight across projects below (design/app.md → Outcome posts). */}
			{/* The feed stays mounted when empty so its poll keeps running —
			    only the section is hidden. */}
			<section
				aria-label="Work in progress"
				hidden={feedItems !== null && feedItems.length === 0}
			>
				<h2 className="ops-h2">Work in progress</h2>
				<ResponsibilityFeed
					token={token}
					projectId={null}
					onConversation={onConversation}
					onItems={onFeedItems}
				/>
			</section>
			<PushControls token={token} />
		</div>
	);
}
