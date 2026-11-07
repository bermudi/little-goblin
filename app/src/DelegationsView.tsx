// Delegations page (#169, design/app.md → Non-chat page layout): current
// work first with what it waits for and a direct action, finished work as
// a paged table, a long brief only in the opened detail.
import { type CSSProperties, useState } from "react";
import { listDelegations } from "./api.ts";
import { ts, useLoad } from "./opsShared.tsx";
import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";

const PAGE = 15;

const PAST_COLS = {
	"--dt-cols": "minmax(10rem, 3fr) 7rem 6.5rem 9rem 9rem",
} as CSSProperties;

type Status = OperatorDelegationItem["status"];

const isCurrent = (s: Status) => s === "starting" || s === "running" || s === "needs_input";

const STATUS_LABEL: Record<Status, string> = {
	starting: "starting",
	running: "running",
	needs_input: "needs input",
	done: "done",
	failed: "failed",
	stopped: "stopped",
};

// One line of the brief: the first non-empty line, so a long prompt never
// sizes a row.
function summary(task: string): string {
	const line = task.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.trim();
}

function waitsFor(d: OperatorDelegationItem): string {
	if (d.status === "needs_input") {
		return d.appConversation !== null
			? "Waiting for your answer in its conversation."
			: "Waiting for your answer in its Telegram chat.";
	}
	if (d.status === "starting") return "Starting the harness; nothing to do yet.";
	return "Working. It reports when it needs you or finishes.";
}

function Pill({ status }: { status: Status }) {
	return <span className={`pill st-${status}`}>{STATUS_LABEL[status]}</span>;
}

function Current({
	d,
	onOpen,
	onConversation,
}: {
	d: OperatorDelegationItem;
	onOpen: (id: number) => void;
	onConversation: ((id: string) => void) | null;
}) {
	const conv = d.appConversation;
	return (
		<li className={`deleg-now${d.status === "needs_input" ? " attn" : ""}`}>
			<div className="deleg-now-head">
				<span className="deleg-now-name">{d.name}</span>
				<Pill status={d.status} />
				<span className="deleg-now-meta">
					{d.harness} · started {ts(d.createdAt)}
				</span>
			</div>
			<p className="deleg-now-wait">{waitsFor(d)}</p>
			<p className="deleg-now-sum">{summary(d.task)}</p>
			<div className="deleg-now-actions">
				{conv !== null && onConversation !== null && (
					<button type="button" className="ghost" onClick={() => onConversation(conv)}>
						{d.status === "needs_input" ? "Answer in conversation" : "Open conversation"}
					</button>
				)}
				<button type="button" className="ghost" onClick={() => onOpen(d.id)}>
					Details
				</button>
			</div>
		</li>
	);
}

function Detail({
	d,
	onBack,
	onConversation,
}: {
	d: OperatorDelegationItem;
	onBack: () => void;
	onConversation: ((id: string) => void) | null;
}) {
	const conv = d.appConversation;
	return (
		<div className="ops deleg-detail">
			<div className="ops-back">
				<button type="button" className="ghost" onClick={onBack}>
					‹ Delegations
				</button>
			</div>
			<h2 className="ops-h2 deleg-title">
				{d.name} <Pill status={d.status} />
			</h2>
			{conv !== null && onConversation !== null && (
				<div className="deleg-now-actions">
					<button type="button" className="ghost" onClick={() => onConversation(conv)}>
						Open conversation
					</button>
				</div>
			)}
			<dl className="deleg-facts">
				<dt>Harness</dt>
				<dd>{d.harness}</dd>
				{d.target !== null && (
					<>
						<dt>Target</dt>
						<dd className="mono">{d.target}</dd>
					</>
				)}
				<dt>Directory</dt>
				<dd className="mono">{d.cwd}</dd>
				<dt>Started</dt>
				<dd>{ts(d.createdAt)}</dd>
				<dt>Last prompted</dt>
				<dd>{ts(d.promptedAt)}</dd>
				<dt>Ended</dt>
				<dd>{ts(d.finishedAt)}</dd>
			</dl>
			<h2 className="ops-h2">Brief</h2>
			<div className="prose deleg-brief">{d.task}</div>
		</div>
	);
}

export function DelegationsView({
	token,
	onOpenConversation,
}: {
	token: string | null;
	onOpenConversation?: ((id: string) => void) | undefined;
}) {
	const { data, err } = useLoad(() => listDelegations(token));
	const [openId, setOpenId] = useState<number | null>(null);
	const [shown, setShown] = useState(PAGE);
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
	const onConv = onOpenConversation ?? null;
	const opened = openId === null ? undefined : data.delegations.find((d) => d.id === openId);
	if (opened !== undefined) {
		return <Detail d={opened} onBack={() => setOpenId(null)} onConversation={onConv} />;
	}

	const newest = (a: OperatorDelegationItem, b: OperatorDelegationItem) =>
		Date.parse(b.createdAt) - Date.parse(a.createdAt);
	const current = data.delegations.filter((d) => isCurrent(d.status)).sort(newest);
	const past = data.delegations.filter((d) => !isCurrent(d.status)).sort(newest);
	const count = (s: Status) => data.delegations.filter((d) => d.status === s).length;
	const waiting = count("needs_input");
	const bad = count("failed") + count("stopped");

	return (
		<div className="ops">
			<h2 className="ops-h2">Delegations ({data.delegations.length})</h2>
			{data.delegations.length === 0 && <p className="empty">No delegations.</p>}
			{data.delegations.length > 0 && (
				<div className="sumstrip">
					<div className={`sumtile${waiting > 0 ? " warn" : ""}`}>
						<b>{waiting}</b>
						<span>need input</span>
					</div>
					<div className="sumtile">
						<b>{count("running") + count("starting")}</b>
						<span>running</span>
					</div>
					<div className="sumtile">
						<b>{count("done")}</b>
						<span>done</span>
					</div>
					<div className={`sumtile${bad > 0 ? " bad" : ""}`}>
						<b>{bad}</b>
						<span>failed or stopped</span>
					</div>
				</div>
			)}
			{data.delegations.length > 0 && (
				<>
					<h2 className="ops-h2">Current</h2>
					{current.length === 0 && <p className="empty">Nothing running now.</p>}
					{current.length > 0 && (
						<ul className="deleg-now-list">
							{current.map((d) => (
								<Current key={d.id} d={d} onOpen={setOpenId} onConversation={onConv} />
							))}
						</ul>
					)}
				</>
			)}
			{past.length > 0 && (
				<>
					<h2 className="ops-h2">Earlier ({past.length})</h2>
					<div className="dtable deleg-table" style={PAST_COLS}>
						<div className="dt-head" aria-hidden="true">
							<span>Name</span>
							<span>Harness</span>
							<span>Status</span>
							<span>Started</span>
							<span>Ended</span>
						</div>
						{past.slice(0, shown).map((d) => (
							<button type="button" className="dt-row" key={d.id} onClick={() => setOpenId(d.id)}>
								<span className="dt-cell dt-main">
									{d.name}
									<small>{summary(d.task)}</small>
								</span>
								<span className="dt-cell dt-hide-m">{d.harness}</span>
								<span className="dt-cell dt-status">
									<Pill status={d.status} />
								</span>
								<span className="dt-cell" data-label="Started">
									{ts(d.createdAt)}
								</span>
								<span className="dt-cell" data-label="Ended">
									{ts(d.finishedAt)}
								</span>
							</button>
						))}
					</div>
					{past.length > shown && (
						<button
							type="button"
							className="ghost deleg-more"
							onClick={() => setShown(shown + PAGE)}
						>
							Show {Math.min(PAGE, past.length - shown)} more ({past.length - shown} hidden)
						</button>
					)}
				</>
			)}
		</div>
	);
}
