import { useEffect, useRef, useState } from "react";
import { decideBlockedMemory, getMemoryStatus, listMemoryDocuments } from "./api.ts";
import { describe } from "./opsShared.tsx";
import { MemoryDocDetail, MemoryDocRow, relTime, useMemoryDocSheet } from "./memoryShared.tsx";
import type { MemoryDocListItem, MemoryStatusResponse } from "../../src/http/operator-wire.ts";

const PAGE = 20;
type MemoryFilter = { query: string; token: string | null };

function StatusCard({
	status,
	busy,
	onBlocked,
}: {
	status: MemoryStatusResponse;
	busy: "retry" | "dismiss" | null;
	onBlocked: (action: "retry" | "dismiss") => void;
}) {
	return (
		<div className="card">
			<div className="stat-grid">
				<div className="stat">
					<span className="stat-label">state</span>
					<span className={`stat-val mono mem-${status.state}`}>{status.state}</span>
				</div>
				<div className="stat">
					<span className="stat-label">completed</span>
					<span className="stat-val mono">{status.completed}</span>
				</div>
				<div className="stat">
					<span className="stat-label">queued</span>
					<span className="stat-val mono">{status.queued}</span>
				</div>
				<div className="stat">
					<span className="stat-label">awaiting forget</span>
					<span className="stat-val mono">{status.deleting}</span>
				</div>
				<div className="stat">
					<span className="stat-label">blocked</span>
					<span className="stat-val mono">{status.blocked}</span>
				</div>
				<div className="stat">
					<span className="stat-label">dismissed</span>
					<span className="stat-val mono">{status.dismissed}</span>
				</div>
				<div className="stat">
					<span className="stat-label">last recall</span>
					<span className="stat-val mono">
						{status.lastRecallAt === null
							? "—"
							: `${relTime(status.lastRecallAt)}${status.lastRecallOk === false ? " (failed)" : ""}`}
					</span>
				</div>
			</div>
			{status.detail !== "" && <div className="cap ops-cap">{status.detail}</div>}
			{status.blockedDetail.length > 0 && (
				<div className="blocked-list">
					{status.blockedDetail.map((b) => (
						<div className="blocked-row" key={b.document}>
							<span className="mono">{b.document}</span>
							<span className="cap">
								{b.error ?? "unknown error"} · {b.attempts} attempt{b.attempts === 1 ? "" : "s"}
							</span>
						</div>
					))}
				</div>
			)}
			{status.blocked > 0 && (
				<div className="blocked-actions">
					<button
						type="button"
						className="ghost"
						disabled={busy !== null}
						onClick={() => onBlocked("retry")}
					>
						{busy === "retry" ? "Requeueing…" : "Retry blocked"}
					</button>
					<button
						type="button"
						className="ghost"
						disabled={busy !== null}
						onClick={() => onBlocked("dismiss")}
					>
						{busy === "dismiss" ? "Dismissing…" : "Dismiss blocked"}
					</button>
				</div>
			)}
		</div>
	);
}

export function MemoryView({ token }: { token: string | null }) {
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [statusErr, setStatusErr] = useState<string | null>(null);
	const [blockedBusy, setBlockedBusy] = useState<"retry" | "dismiss" | null>(null);
	const [blockedErr, setBlockedErr] = useState<string | null>(null);
	const [q, setQ] = useState("");
	const [items, setItems] = useState<MemoryDocListItem[]>([]);
	const [total, setTotal] = useState(0);
	const [loadedFilter, setLoadedFilter] = useState<MemoryFilter | null>(null);
	const [listLoading, setListLoading] = useState(false);
	const [listErr, setListErr] = useState<string | null>(null);
	const listSeq = useRef(0);
	const latestFilter = useRef<MemoryFilter>({ query: "", token });

	// Live view of the memory queue — polled while the tab is open,
	// same as the mini app's Memories panel.
	useEffect(() => {
		let live = true;
		const tick = () => {
			void getMemoryStatus(token).then(
				(s) => live && (setStatus(s), setStatusErr(null)),
				(err) => live && setStatusErr(describe(err)),
			);
		};
		tick();
		const t = setInterval(tick, 10_000);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [token]);

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
	const loadDocs = (
		offset: number,
		filter: MemoryFilter,
		append: boolean,
		seq = ++listSeq.current,
	) => {
		if (seq !== listSeq.current) return;
		setListLoading(true);
		const { query, token } = filter;
		void listMemoryDocuments(
			token,
			query === "" ? { limit: PAGE, offset } : { q: query, limit: PAGE, offset },
		).then(
			(r) => {
				if (seq !== listSeq.current) return;
				setItems((prev) => (append ? [...prev, ...r.items] : r.items));
				setTotal(r.total);
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
		const t = setTimeout(() => loadDocs(0, filter, false, seq), 250);
		return () => {
			clearTimeout(t);
			++listSeq.current;
		};
	}, [q, token]);
	const canAppend =
		!listLoading && loadedFilter?.query === q.trim() && loadedFilter.token === token;

	// A forget invalidates the loaded list (the row is gone) and the
	// status card (queue + completed counts moved).
	const sheet = useMemoryDocSheet(token, () => {
		loadDocs(0, latestFilter.current, false);
		void getMemoryStatus(latestFilter.current.token).then(
			(s) => {
				setStatus(s);
				setStatusErr(null);
			},
			(err) => setStatusErr(describe(err)),
		);
	});

	return (
		<div className="ops">
			<h2 className="ops-h2">Status</h2>
			{statusErr !== null && <p className="error">{statusErr}</p>}
			{blockedErr !== null && <p className="error">{blockedErr}</p>}
			{status === null ? (
				<p className="empty">Loading…</p>
			) : (
				<StatusCard status={status} busy={blockedBusy} onBlocked={actOnBlocked} />
			)}

			{sheet.detail !== null ? (
				<>
					<div className="ops-back">
						<button type="button" className="ghost" onClick={sheet.close}>
							‹ Retained exchanges
						</button>
					</div>
					<MemoryDocDetail
						detail={sheet.detail}
						forgetting={sheet.forgetting}
						detailErr={sheet.detailErr}
						onForget={sheet.forget}
					/>
				</>
			) : (
				<>
					<h2 className="ops-h2">Retained exchanges</h2>
					{sheet.detailErr !== null && <p className="error">{sheet.detailErr}</p>}
					<input
						className="rail-search ops-search"
						type="search"
						placeholder="filter by topic or exchange id"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label="filter exchanges"
					/>
					{listErr !== null && <p className="error">{listErr}</p>}
					<div className="card">
						{items.length === 0 && <p className="empty">No retained exchanges.</p>}
						{items.map((d) => (
							<MemoryDocRow key={d.id} doc={d} onOpen={sheet.open} withConversation />
						))}
					</div>
					{items.length < total && (
						<button
							type="button"
							className="ghost"
							disabled={!canAppend}
							onClick={() => {
								if (canAppend && loadedFilter !== null) loadDocs(items.length, loadedFilter, true);
							}}
						>
							Load more
						</button>
					)}
					<div className="cap ops-cap">
						{items.length} of {total}
					</div>
				</>
			)}
		</div>
	);
}
