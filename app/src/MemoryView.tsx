import { Fragment, type CSSProperties, useEffect, useRef, useState } from "react";
import {
	decideBlockedMemory,
	forgetMemoryDocument,
	getMemoryDocument,
	getMemoryStatus,
	listMemorySaves,
} from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { describe } from "./opsShared.tsx";
import { relTime } from "./memoryShared.tsx";
import type {
	MemoryDocDetailResponse,
	MemoryDocListItem,
	MemoryRetryProgress,
	MemorySavesResponse,
	MemoryStatusResponse,
} from "../../src/http/operator-wire.ts";

// The Memory page answers three questions in order: is memory working,
// what did it keep lately, and what did it skip (design/app.md → Memory
// page, #163). Counters live in the footer, not the lead.

const PAGE = 20;
const FACTS_SHOWN = 8;
const SLOW_POLL_MS = 10_000;
// While a retry drains, the page follows it closely.
const FAST_POLL_MS = 2_000;
// A finished retry stays on the page as a confirmation, then drops away.
const RETRY_SHOWN_MS = 60 * 60 * 1000;

type SavesFilter = { query: string; token: string | null };
type Nothing = MemorySavesResponse["nothingKept"];
type DocPanel =
	| { state: "loading" }
	| { state: "ready"; detail: MemoryDocDetailResponse }
	| { state: "error"; message: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const when = (iso: string | null) => {
	const t = relTime(iso);
	return t === "now" ? "just now" : t;
};

type Health = { tone: "ok" | "bad" | "warn" | "off"; title: string; summary: string };

function healthOf(status: MemoryStatusResponse): Health {
	if (status.state === "disabled") {
		return { tone: "off", title: "Memory is off", summary: status.detail };
	}
	const lastSave =
		status.lastSaveAt === null ? "No saves recorded yet." : `Last save ${when(status.lastSaveAt)}.`;
	if (status.blocked > 0) {
		return {
			tone: "bad",
			title: "Memory can't save",
			summary: `${lastSave} ${plural(status.blocked, "exchange")} blocked.`,
		};
	}
	if (status.lastRecallOk === false) {
		return {
			tone: "warn",
			title: "Memory can't recall",
			summary: `Last recall failed ${when(status.lastRecallAt)}. Chats continue without it. ${lastSave}`,
		};
	}
	const lastRecall =
		status.lastRecallAt === null ? "No recall yet." : `Last recall ${when(status.lastRecallAt)}.`;
	const queued = status.queued > 0 ? ` ${plural(status.queued, "exchange")} queued.` : "";
	return { tone: "ok", title: "Memory is working", summary: `${lastSave} ${lastRecall}${queued}` };
}

function HealthLine({ health }: { health: Health }) {
	return (
		<div className="mem-health">
			<span className={`mem-dot ${health.tone}`} aria-hidden="true" />
			<div>
				<h1>{health.title}</h1>
				<p className="mem-summary">{health.summary}</p>
			</div>
		</div>
	);
}

function ProblemCard({
	status,
	busy,
	onAct,
}: {
	status: MemoryStatusResponse;
	busy: "retry" | "dismiss" | null;
	onAct: (action: "retry" | "dismiss") => void;
}) {
	const [confirmDrop, setConfirmDrop] = useState(false);
	const causes = status.blockedCauses;
	const names = status.blockedConversations.slice(0, 6);
	const hidden = status.blockedConversations.length - names.length;
	return (
		<section className="card mem-problem" aria-label="Blocked exchanges">
			<div className="mem-problem-head">
				<h2>Memory can't save {plural(status.blocked, "exchange")}</h2>
			</div>
			<div className="prose mem-problem-body">
				<p>
					{causes.length === 0
						? "Saving failed."
						: `Saving failed: ${causes
								.map(
									(c) => `${c.error ?? "unknown error"}${causes.length > 1 ? ` (${c.count})` : ""}`,
								)
								.join("; ")}.`}{" "}
					You can still chat, and Goblin can still recall what it already knows.
				</p>
				{names.length > 0 && (
					<p className="mem-from">
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
			{confirmDrop ? (
				<div className="mem-actions">
					<span className="mem-confirm">
						Drop {plural(status.blocked, "exchange")}? Memory will never save them.
					</span>
					<button
						type="button"
						className="danger"
						disabled={busy !== null}
						onClick={() => {
							setConfirmDrop(false);
							onAct("dismiss");
						}}
					>
						{busy === "dismiss" ? "Dropping…" : "Yes, drop them"}
					</button>
					<button type="button" className="ghost" onClick={() => setConfirmDrop(false)}>
						Keep them
					</button>
				</div>
			) : (
				<div className="mem-actions">
					<button
						type="button"
						className="ghost"
						disabled={busy !== null}
						onClick={() => onAct("retry")}
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
				</div>
			)}
		</section>
	);
}

export function RetryCard({ retry }: { retry: MemoryRetryProgress }) {
	const total = retry.done + retry.queued + retry.failed;
	const title =
		retry.queued > 0
			? `Saving ${plural(total, "retried exchange")}`
			: retry.failed > 0
				? `${retry.failed} of ${plural(total, "retried exchange")} failed again`
				: `All ${plural(total, "retried exchange")} saved`;
	return (
		<section className="mem-retry" aria-label="Retry progress">
			<h2 className="ops-h2" aria-live="polite">
				{title}
			</h2>
			<progress
				className="mem-progress"
				aria-label="Retry progress"
				value={retry.done + retry.failed}
				max={total}
			/>
			<div className="sumstrip">
				<div className="sumtile">
					<b>{retry.done}</b>
					<span>saved</span>
				</div>
				<div className={`sumtile${retry.queued > 0 ? " warn" : ""}`}>
					<b>{retry.queued}</b>
					<span>still queued</span>
				</div>
				<div className={`sumtile${retry.failed > 0 ? " bad" : ""}`}>
					<b>{retry.failed}</b>
					<span>failed again</span>
				</div>
			</div>
			<div
				className="dtable mem-retry-table"
				style={{ "--dt-cols": "minmax(10rem, 3fr) 6rem 6rem 7rem" } as CSSProperties}
			>
				<div className="dt-head" aria-hidden="true">
					<span>Conversation</span>
					<span>Saved</span>
					<span>Queued</span>
					<span>Failed again</span>
				</div>
				{retry.conversations.map((c) => (
					<div className="dt-row dt-static" key={c.conversationId ?? "none"}>
						<span className="dt-cell dt-main">{c.name ?? "Unknown conversation"}</span>
						<span className="dt-cell" data-label="saved">
							{c.done}
						</span>
						<span className="dt-cell" data-label="queued">
							{c.queued}
						</span>
						<span className={`dt-cell${c.failed > 0 ? " mem-bad" : ""}`} data-label="failed again">
							{c.failed}
						</span>
					</div>
				))}
			</div>
		</section>
	);
}

export function MemoryView({
	token,
	onConversation,
}: {
	token: string | null;
	/** App door only: the Telegram mini app has no conversations to open. */
	onConversation?: (conversationId: string) => void;
}) {
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [statusErr, setStatusErr] = useState<string | null>(null);
	const [blockedBusy, setBlockedBusy] = useState<"retry" | "dismiss" | null>(null);
	const [blockedErr, setBlockedErr] = useState<string | null>(null);
	const [q, setQ] = useState("");
	const [items, setItems] = useState<MemoryDocListItem[]>([]);
	const [total, setTotal] = useState(0);
	const [nothing, setNothing] = useState<Nothing | null>(null);
	const [nothingOpen, setNothingOpen] = useState(false);
	const [loadedFilter, setLoadedFilter] = useState<SavesFilter | null>(null);
	const [listLoading, setListLoading] = useState(false);
	const [listErr, setListErr] = useState<string | null>(null);
	const [panels, setPanels] = useState<Record<string, DocPanel>>({});
	const [forgetting, setForgetting] = useState<string | null>(null);
	const [forgetErr, setForgetErr] = useState<string | null>(null);
	const listSeq = useRef(0);
	const latestFilter = useRef<SavesFilter>({ query: "", token });
	const seenCompleted = useRef<number | null>(null);
	const confirm = useConfirm();

	// Live view of the memory queue — polled while the tab is open, and
	// closely while a retry drains so its progress reads as it happens.
	const fast = blockedBusy !== null || (status?.retry?.queued ?? 0) > 0;
	useEffect(() => {
		let live = true;
		const tick = () => {
			void getMemoryStatus(token).then(
				(s) => live && (setStatus(s), setStatusErr(null)),
				(err) => live && setStatusErr(describe(err)),
			);
		};
		tick();
		const t = setInterval(tick, fast ? FAST_POLL_MS : SLOW_POLL_MS);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [token, fast]);

	const actOnBlocked = (action: "retry" | "dismiss") => {
		setBlockedBusy(action);
		setBlockedErr(null);
		void decideBlockedMemory(token, action)
			.then(() => getMemoryStatus(token))
			.then(
				(s) => setStatus(s),
				(err: unknown) => setBlockedErr(describe(err)),
			)
			.finally(() => setBlockedBusy(null));
	};

	// Debounced search; each result page appends under "Load more".
	const loadSaves = (
		offset: number,
		filter: SavesFilter,
		append: boolean,
		seq = ++listSeq.current,
	) => {
		if (seq !== listSeq.current) return;
		setListLoading(true);
		const { query, token } = filter;
		void listMemorySaves(
			token,
			query === "" ? { limit: PAGE, offset } : { q: query, limit: PAGE, offset },
		).then(
			(r) => {
				if (seq !== listSeq.current) return;
				setItems((prev) => (append ? [...prev, ...r.kept.items] : r.kept.items));
				setTotal(r.kept.total);
				setNothing(r.nothingKept);
				if (!append) setLoadedFilter(filter);
				setListLoading(false);
				setListErr(null);
			},
			(err) => {
				if (seq !== listSeq.current) return;
				setListLoading(false);
				setListErr(describe(err));
			},
		);
	};
	useEffect(() => {
		// Invalidate old pages before the debounce: a page arriving during
		// that window must not be appended to a different search.
		const seq = ++listSeq.current;
		const filter = { query: q.trim(), token };
		latestFilter.current = filter;
		setListLoading(true);
		const t = setTimeout(() => loadSaves(0, filter, false, seq), 250);
		return () => {
			clearTimeout(t);
			++listSeq.current;
		};
	}, [q, token]);
	const canAppend =
		!listLoading && loadedFilter?.query === q.trim() && loadedFilter.token === token;

	// A save finishing (a retry draining, a new exchange landing) adds rows.
	const completed = status?.completed ?? null;
	useEffect(() => {
		if (completed === null) return;
		const before = seenCompleted.current;
		seenCompleted.current = completed;
		if (before !== null && before !== completed) loadSaves(0, latestFilter.current, false);
	}, [completed]);

	const toggle = (id: string) => {
		if (panels[id] !== undefined) {
			setPanels((prev) => {
				const { [id]: _closed, ...rest } = prev;
				return rest;
			});
			return;
		}
		setPanels((prev) => ({ ...prev, [id]: { state: "loading" } }));
		void getMemoryDocument(token, id).then(
			(detail) =>
				setPanels((prev) => (id in prev ? { ...prev, [id]: { state: "ready", detail } } : prev)),
			(err: unknown) =>
				setPanels((prev) =>
					id in prev ? { ...prev, [id]: { state: "error", message: describe(err) } } : prev,
				),
		);
	};

	const forget = async (id: string) => {
		if (
			!(await confirm.ask({
				message:
					"Forget this exchange? It will be deleted from memory and redacted locally.",
				confirmLabel: "Forget",
				danger: true,
			}))
		)
			return;
		setForgetting(id);
		setForgetErr(null);
		void forgetMemoryDocument(token, id).then(
			() => {
				setForgetting(null);
				setPanels((prev) => {
					const { [id]: _gone, ...rest } = prev;
					return rest;
				});
				loadSaves(0, latestFilter.current, false);
				void getMemoryStatus(latestFilter.current.token).then(
					(s) => {
						setStatus(s);
						setStatusErr(null);
					},
					(err) => setStatusErr(describe(err)),
				);
			},
			(err: unknown) => {
				setForgetting(null);
				setForgetErr(describe(err));
			},
		);
	};

	const retry = status?.retry ?? null;
	const showRetry =
		retry !== null &&
		(retry.queued > 0 ||
			retry.failed > 0 ||
			Date.now() - Date.parse(retry.startedAt) < RETRY_SHOWN_MS);
	const ready = status !== null && status.state !== "disabled";
	const searching = q.trim() !== "";

	return (
		<div className="ops mem-page">
			{confirm.view}
			{statusErr !== null && <p className="error">{statusErr}</p>}
			{blockedErr !== null && <p className="error">{blockedErr}</p>}
			{status === null ? (
				<p className="empty">Loading…</p>
			) : (
				<HealthLine health={healthOf(status)} />
			)}
			{status !== null && status.blocked > 0 && (
				<ProblemCard status={status} busy={blockedBusy} onAct={actOnBlocked} />
			)}
			{status !== null && status.lastRecallOk === false && status.blocked === 0 && (
				<p className="mem-note">
					The last recall failed, so recent chats ran without memory. It tries again on the next
					message.
				</p>
			)}
			{status !== null && status.deleting > 0 && (
				<p className="mem-note">
					{plural(status.deleting, "forgotten exchange")} still waiting for memory to confirm the
					delete.
				</p>
			)}
			{showRetry && retry !== null && <RetryCard retry={retry} />}

			{ready && (
				<>
					<h2 className="ops-h2">Recent saves</h2>
					<input
						className="rail-search ops-search"
						type="search"
						placeholder="Search by conversation name or exchange id"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label="filter exchanges"
					/>
					{listErr !== null && <p className="error">{listErr}</p>}
					{forgetErr !== null && <p className="error">{forgetErr}</p>}
					{items.length === 0 ? (
						<p className="empty">
							{listLoading
								? "Loading…"
								: searching
									? "Nothing matches."
									: "Nothing has been kept yet."}
						</p>
					) : (
						<div
							className="dtable mem-saves"
							style={
								{ "--dt-cols": "minmax(10rem, 3fr) minmax(8rem, 1.2fr) 9rem" } as CSSProperties
							}
						>
							<div className="dt-head" aria-hidden="true">
								<span>Conversation</span>
								<span>Kept</span>
								<span>Saved</span>
							</div>
							{items.map((d) => {
								const panel = panels[d.id];
								return (
									<Fragment key={d.id}>
										<button
											type="button"
											className={`dt-row${panel === undefined ? "" : " open"}`}
											aria-expanded={panel !== undefined}
											onClick={() => toggle(d.id)}
										>
											<span className="dt-cell dt-main">{d.conversationName ?? d.id}</span>
											<span className="dt-cell dt-status mem-kept">
												Kept {plural(d.factCount, "fact")}
											</span>
											<span className="dt-cell" data-label="saved">
												{when(d.createdAt)}
											</span>
										</button>
										{panel !== undefined && (
											<DocPanelView
												doc={d}
												panel={panel}
												forgetting={forgetting === d.id}
												onForget={forget}
												onConversation={onConversation}
											/>
										)}
									</Fragment>
								);
							})}
						</div>
					)}
					{items.length < total && (
						<button
							type="button"
							className="ghost"
							disabled={!canAppend}
							onClick={() => {
								if (canAppend && loadedFilter !== null) loadSaves(items.length, loadedFilter, true);
							}}
						>
							Load more
						</button>
					)}
					{nothing !== null && nothing.total > 0 && (
						<NothingKept nothing={nothing} open={nothingOpen} onToggle={setNothingOpen} />
					)}
				</>
			)}

			{status !== null && status.state !== "disabled" && (
				<div className="mem-footer cap">
					<span>{plural(status.completed, "exchange")} processed so far.</span>
					{status.dismissed > 0 && (
						<span>
							{plural(status.dismissed, "exchange")} dropped and not in memory. Bringing them back
							is not built yet.
						</span>
					)}
				</div>
			)}
		</div>
	);
}

function DocPanelView({
	doc,
	panel,
	forgetting,
	onForget,
	onConversation,
}: {
	doc: MemoryDocListItem;
	panel: DocPanel;
	forgetting: boolean;
	onForget: (id: string) => void;
	onConversation: ((conversationId: string) => void) | undefined;
}) {
	if (panel.state === "loading") return <p className="mem-expand empty">Loading…</p>;
	if (panel.state === "error") return <p className="mem-expand error">{panel.message}</p>;
	const { detail } = panel;
	const shown = detail.facts.slice(0, FACTS_SHOWN);
	// Only app conversations open in the app; Telegram ones live there.
	const canOpen =
		onConversation !== undefined &&
		doc.conversationId !== null &&
		doc.conversationId.startsWith("app/");
	return (
		<div className="mem-expand">
			{detail.facts.length === 0 ? (
				<p className="cap">No facts were extracted from this exchange.</p>
			) : (
				<div className="mem-facts">
					{shown.map((f) => (
						<div
							key={f.id}
							className={f.state === "valid" || f.state === null ? "fact" : "fact stale"}
						>
							<div className="fact-text">{f.text}</div>
						</div>
					))}
					{detail.factsTotal > shown.length && (
						<div className="cap">and {detail.factsTotal - shown.length} more</div>
					)}
				</div>
			)}
			{detail.originalText !== null && (
				<details className="mem-source">
					<summary>Exchange text</summary>
					<pre className="doc-text">{detail.originalText}</pre>
				</details>
			)}
			<div className="mem-actions">
				{canOpen && doc.conversationId !== null && (
					<button
						type="button"
						className="ghost"
						onClick={() => onConversation(doc.conversationId!)}
					>
						Open conversation
					</button>
				)}
				<button
					type="button"
					className="danger"
					disabled={forgetting}
					onClick={() => onForget(doc.id)}
				>
					{forgetting ? "Forgetting…" : "Forget this"}
				</button>
			</div>
		</div>
	);
}

function NothingKept({
	nothing,
	open,
	onToggle,
}: {
	nothing: Nothing;
	open: boolean;
	onToggle: (open: boolean) => void;
}) {
	return (
		<section className="mem-nothing">
			<button
				type="button"
				className="mem-fold"
				aria-expanded={open}
				onClick={() => onToggle(!open)}
			>
				<span className="mem-chev" aria-hidden="true">
					{open ? "▾" : "▸"}
				</span>
				<span>Nothing kept</span>
				<span className="cap">{plural(nothing.total, "exchange")}</span>
			</button>
			{open && (
				<div
					className="dtable"
					style={{ "--dt-cols": "minmax(10rem, 3fr) 7rem 9rem" } as CSSProperties}
				>
					<div className="dt-head" aria-hidden="true">
						<span>Conversation</span>
						<span>Exchanges</span>
						<span>Latest</span>
					</div>
					{nothing.conversations.map((c) => (
						<div className="dt-row dt-static" key={c.conversationId ?? "none"}>
							<span className="dt-cell dt-main">{c.name ?? "Unknown conversation"}</span>
							<span className="dt-cell" data-label="exchanges">
								{c.count}
							</span>
							<span className="dt-cell" data-label="latest">
								{when(c.latestAt)}
							</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
