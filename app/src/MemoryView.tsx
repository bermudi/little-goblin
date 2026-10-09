import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	forgetMemoryDocument,
	getMemoryDocument,
	getMemoryStatus,
	listMemoryDocuments,
} from "./api.ts";
import type {
	MemoryDocDetailResponse,
	MemoryDocListItem,
	MemoryStatusResponse,
} from "../../src/http/operator-wire.ts";

const PAGE = 20;

function relTime(iso: string | null): string {
	if (iso === null) return "—";
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return iso;
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) return "now";
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
	return new Date(ts).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function describe(err: unknown): string {
	return err instanceof ApiError ? err.message : "Couldn't reach goblin — check the tailnet.";
}

function StatusCard({ status }: { status: MemoryStatusResponse }) {
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
		</div>
	);
}

export function MemoryView({ token }: { token: string | null }) {
	const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
	const [statusErr, setStatusErr] = useState<string | null>(null);
	const [q, setQ] = useState("");
	const [items, setItems] = useState<MemoryDocListItem[]>([]);
	const [total, setTotal] = useState(0);
	const [listErr, setListErr] = useState<string | null>(null);
	const [detail, setDetail] = useState<MemoryDocDetailResponse | null>(null);
	const [detailErr, setDetailErr] = useState<string | null>(null);
	const [forgetting, setForgetting] = useState(false);
	const listSeq = useRef(0);

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

	// Debounced search; each result page appends under "Load more".
	const loadDocs = (offset: number, query: string, append: boolean) => {
		const seq = ++listSeq.current;
		void listMemoryDocuments(
			token,
			query === "" ? { limit: PAGE, offset } : { q: query, limit: PAGE, offset },
		).then(
			(r) => {
				if (seq !== listSeq.current) return;
				setItems((prev) => (append ? [...prev, ...r.items] : r.items));
				setTotal(r.total);
				setListErr(null);
			},
			(err) => {
				if (seq === listSeq.current) setListErr(describe(err));
			},
		);
	};
	useEffect(() => {
		const t = setTimeout(() => loadDocs(0, q.trim(), false), 250);
		return () => clearTimeout(t);
		// loadDocs is stable — its sequencing rides the ref, not state.
	}, [q, token]);

	const openDoc = (id: string) => {
		setDetail(null);
		setDetailErr(null);
		void getMemoryDocument(token, id).then(
			(d) => setDetail(d),
			(err) => setDetailErr(describe(err)),
		);
	};

	// The forget protocol lives on the server (suppress → park →
	// delete remote → redact local); the client just asks.
	const forget = (id: string) => {
		if (
			!window.confirm("Forget this exchange? It will be deleted from memory and redacted locally.")
		)
			return;
		setForgetting(true);
		setDetailErr(null);
		void forgetMemoryDocument(token, id).then(
			() => {
				setForgetting(false);
				setDetail(null);
				loadDocs(0, q.trim(), false);
				void getMemoryStatus(token).then(setStatus, () => {});
			},
			(err) => {
				setForgetting(false);
				setDetailErr(describe(err));
			},
		);
	};

	return (
		<div className="ops">
			<h2 className="ops-h2">Status</h2>
			{statusErr !== null && <p className="error">{statusErr}</p>}
			{status === null ? <p className="empty">Loading…</p> : <StatusCard status={status} />}

			{detail !== null ? (
				<>
					<div className="ops-back">
						<button type="button" className="ghost" onClick={() => setDetail(null)}>
							‹ Retained exchanges
						</button>
					</div>
					<h2 className="ops-h2">
						Exchange <span className="mono">{detail.document.id}</span>
					</h2>
					<div className="card">
						<div className="doc-meta">
							<span>retained {relTime(detail.document.createdAt)}</span>
							<span>updated {relTime(detail.document.updatedAt)}</span>
							{detail.document.conversationId !== null && (
								<span className="mono">{detail.document.conversationId}</span>
							)}
						</div>
						{detail.originalText !== null && <pre className="doc-text">{detail.originalText}</pre>}
						<button
							type="button"
							className="danger"
							disabled={forgetting}
							onClick={() => forget(detail.document.id)}
						>
							{forgetting ? "Forgetting…" : "Forget this exchange"}
						</button>
						{detailErr !== null && <p className="error">{detailErr}</p>}
					</div>
					<h2 className="ops-h2">Facts ({detail.factsTotal})</h2>
					<div className="card">
						{detail.facts.length === 0 && <p className="empty">No facts extracted.</p>}
						{detail.facts.map((f) => (
							<div
								key={f.id}
								className={f.state === "valid" || f.state === null ? "fact" : "fact stale"}
							>
								<div className="fact-text">{f.text}</div>
								<div className="cap">
									{[f.factType, f.state, f.entities]
										.filter((x): x is string => x !== null && x !== "")
										.join(" · ")}
								</div>
							</div>
						))}
					</div>
				</>
			) : (
				<>
					<h2 className="ops-h2">Retained exchanges</h2>
					{detailErr !== null && <p className="error">{detailErr}</p>}
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
							<button key={d.id} type="button" className="doc-row" onClick={() => openDoc(d.id)}>
								<span className="doc-id mono">{d.id}</span>
								<span className="doc-sub">
									{relTime(d.createdAt)} · {d.textLength} chars · {d.factCount} facts
								</span>
								<span className="chev">›</span>
							</button>
						))}
					</div>
					{items.length < total && (
						<button
							type="button"
							className="ghost"
							onClick={() => loadDocs(items.length, q.trim(), true)}
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
