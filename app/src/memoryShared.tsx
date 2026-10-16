// Shared memory-browser pieces: the Memories tab and the chat header's
// thread-sources sheet render the same rows, the same detail sheet,
// and the same forget affordance — one implementation, two surfaces
// (design/app.md → Thread sources). The forget protocol itself is
// server-owned; both surfaces only ask.
import { useRef, useState } from "react";
import type { MemoryDocDetailResponse, MemoryDocListItem } from "../../src/http/operator-wire.ts";
import { forgetMemoryDocument, getMemoryDocument } from "./api.ts";
import { describe } from "./opsShared.tsx";

export function relTime(iso: string | null): string {
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

export function MemoryDocRow({
	doc,
	onOpen,
}: {
	doc: MemoryDocListItem;
	onOpen: (id: string) => void;
}) {
	return (
		<button type="button" className="doc-row" onClick={() => onOpen(doc.id)}>
			<span className="doc-id mono">{doc.id}</span>
			<span className="doc-sub">
				{relTime(doc.createdAt)} · {doc.textLength} chars · {doc.factCount} facts
			</span>
			<span className="chev">›</span>
		</button>
	);
}

// The detail sheet's state machine: open/close/forget with the
// supersede discipline the Memories tab established — a slow detail
// fetch must not reopen a sheet the operator left, and a forget landing
// in the gap between open and fetch still closes the pending sheet.
export function useMemoryDocSheet(
	token: string | null,
	onForgotten: (id: string) => void,
): {
	detail: MemoryDocDetailResponse | null;
	detailErr: string | null;
	forgetting: boolean;
	open: (id: string) => void;
	close: () => void;
	forget: (id: string) => void;
} {
	const [detail, setDetail] = useState<MemoryDocDetailResponse | null>(null);
	const [detailErr, setDetailErr] = useState<string | null>(null);
	const [forgetting, setForgetting] = useState(false);
	const detailSeq = useRef(0);
	// The open sheet's document id, separate from `detail`: while the
	// sheet's GET is still in flight detail is null, and a forget that
	// lands in that gap must still fence the pending fetch.
	const openDocId = useRef<string | null>(null);

	const open = (id: string) => {
		const seq = ++detailSeq.current;
		openDocId.current = id;
		setDetail(null);
		setDetailErr(null);
		void getMemoryDocument(token, id).then(
			(d) => {
				if (seq !== detailSeq.current) return;
				setDetail(d);
			},
			(err) => {
				if (seq !== detailSeq.current) return;
				setDetailErr(describe(err));
			},
		);
	};

	const close = () => {
		++detailSeq.current;
		openDocId.current = null;
		setDetail(null);
	};

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
				// A forget that resolves late must not dump a document the
				// operator opened in the meantime — and must not skip
				// invalidation just because the forgotten doc's own sheet is
				// mid-fetch (detail reads null then). The open id is the live
				// identity either way.
				if (openDocId.current === id) {
					++detailSeq.current;
					openDocId.current = null;
					setDetail(null);
				}
				onForgotten(id);
			},
			(err) => {
				setForgetting(false);
				setDetailErr(describe(err));
			},
		);
	};

	return { detail, detailErr, forgetting, open, close, forget };
}

// The detail view: exchange card + facts + forget. The parent owns the
// back row and the sheet's placement.
export function MemoryDocDetail({
	detail,
	forgetting,
	detailErr,
	onForget,
}: {
	detail: MemoryDocDetailResponse;
	forgetting: boolean;
	detailErr: string | null;
	onForget: (id: string) => void;
}) {
	return (
		<>
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
					onClick={() => onForget(detail.document.id)}
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
	);
}
