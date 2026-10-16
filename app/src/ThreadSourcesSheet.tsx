// The chat header's thread-sources sheet (design/app.md → Thread
// sources): everything this conversation produced — its retained
// exchanges and the skills generated from it — on the thread itself,
// not in a global tab. Skills are read-only (approve/discard stays
// conversational); memories keep the shared forget affordance.
import { useEffect, useRef, useState } from "react";
import type { MemoryDocListItem, ThreadSkillItem } from "../../src/http/operator-wire.ts";
import { listMemoryDocuments, listThreadSkills } from "./api.ts";
import { MemoryDocDetail, MemoryDocRow, relTime, useMemoryDocSheet } from "./memoryShared.tsx";
import { describe } from "./opsShared.tsx";

const PAGE = 20;

function SkillRow({ skill }: { skill: ThreadSkillItem }) {
	return (
		<div className="doc-row skill-row">
			<span className="skill-name mono">{skill.skill}</span>
			<span className="doc-sub">
				<span className={`skill-state skill-${skill.state}`}>{skill.state}</span>
				{" · "}
				{skill.kind === "reviewer" ? "distilled" : "authored"} {relTime(skill.firstAt)}
			</span>
		</div>
	);
}

export function ThreadSourcesSheet({
	token,
	conversationId,
	title,
	onClose,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	onClose: () => void;
}) {
	const [skills, setSkills] = useState<ThreadSkillItem[] | null>(null);
	const [skillsErr, setSkillsErr] = useState<string | null>(null);
	const [items, setItems] = useState<MemoryDocListItem[]>([]);
	const [total, setTotal] = useState(0);
	const [listLoading, setListLoading] = useState(false);
	const [listErr, setListErr] = useState<string | null>(null);
	const listSeq = useRef(0);

	const loadDocs = (offset: number, append: boolean, seq = ++listSeq.current) => {
		if (seq !== listSeq.current) return;
		setListLoading(true);
		void listMemoryDocuments(token, { conversation: conversationId, limit: PAGE, offset }).then(
			(r) => {
				if (seq !== listSeq.current) return;
				setItems((prev) => (append ? [...prev, ...r.items] : r.items));
				setTotal(r.total);
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
		let live = true;
		void listThreadSkills(token, conversationId).then(
			(r) => live && (setSkills(r.items), setSkillsErr(null)),
			(err) => live && setSkillsErr(describe(err)),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);

	useEffect(() => {
		loadDocs(0, false);
		return () => {
			++listSeq.current;
		};
	}, [token, conversationId]);

	const sheet = useMemoryDocSheet(token, () => loadDocs(0, false));

	return (
		<div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
			<div className="msheet thread-sources" role="dialog" aria-label="From this conversation">
				<div className="msheet-head">
					<h3>From this thread{title !== null ? ` — ${title}` : ""}</h3>
					<button type="button" aria-label="Close" onClick={onClose}>
						×
					</button>
				</div>
				<div className="msheet-body ops">
					{sheet.detail !== null ? (
						<>
							<div className="ops-back">
								<button type="button" className="ghost" onClick={sheet.close}>
									‹ From this thread
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
							<h4 className="ops-h2">Skills generated here</h4>
							{skillsErr !== null && <p className="error">{skillsErr}</p>}
							{skills === null && skillsErr === null && <p className="empty">Loading…</p>}
							{skills !== null && skills.length === 0 && (
								<p className="empty">No skills generated from this conversation.</p>
							)}
							{skills !== null && skills.length > 0 && (
								<div className="card">
									{skills.map((s) => (
										<SkillRow key={s.skill} skill={s} />
									))}
								</div>
							)}
							<h4 className="ops-h2">Retained exchanges</h4>
							{sheet.detailErr !== null && <p className="error">{sheet.detailErr}</p>}
							{listErr !== null && <p className="error">{listErr}</p>}
							<div className="card">
								{items.length === 0 && !listLoading && <p className="empty">Nothing retained.</p>}
								{items.map((d) => (
									<MemoryDocRow key={d.id} doc={d} onOpen={sheet.open} />
								))}
							</div>
							{items.length < total && (
								<button
									type="button"
									className="ghost"
									disabled={listLoading}
									onClick={() => loadDocs(items.length, true)}
								>
									Load more
								</button>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
