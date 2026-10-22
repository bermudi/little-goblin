// The composer's skill picker (ruling 2026-10-21, design/app.md →
// Skill picker & temp skills): the catalog — every valid entry,
// manual-only included — plus a from-link flow. A link previews
// server-side (fetch + System One score) and the card's yes/no decides:
// stage it, or drop it. Nothing is fetched into a send the card didn't
// approve.
import { useEffect, useState } from "react";
import type { SkillPreviewResponse, SkillsResponse } from "../../src/http/operator-wire.ts";
import { listSkills, previewSkill } from "./api.ts";
import { describe } from "./opsShared.tsx";

function bytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

const VERDICT_LABEL: Record<SkillPreviewResponse["verdict"]["status"], string> = {
	clean: "injection check: clean",
	suspicious: "⚠️ injection check: suspicious",
	malicious: "⚠️ injection check: malicious",
	unavailable: "injection check unavailable",
};

export interface PickedSkill {
	name: string;
	ref: { name: string } | { url: string; path: string };
}

export function SkillPickerSheet({
	token,
	onClose,
	onStage,
}: {
	token: string | null;
	onClose: () => void;
	onStage: (picked: PickedSkill) => void;
}) {
	const [catalog, setCatalog] = useState<SkillsResponse["catalog"] | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [link, setLink] = useState("");
	const [preview, setPreview] = useState<SkillPreviewResponse | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [previewErr, setPreviewErr] = useState<string | null>(null);
	const [reload, setReload] = useState(0);

	useEffect(() => {
		let live = true;
		listSkills(token).then(
			(r) => {
				if (live) setCatalog(r.catalog);
			},
			(e) => {
				if (live) setLoadErr(describe(e));
			},
		);
		return () => {
			live = false;
		};
	}, [token, reload]);

	const q = query.trim().toLowerCase();
	const rows = (catalog ?? []).filter(
		(c) => q === "" || c.name.includes(q) || c.description.toLowerCase().includes(q),
	);

	const runPreview = () => {
		if (previewing || link.trim() === "") return;
		setPreviewing(true);
		setPreviewErr(null);
		setPreview(null);
		previewSkill(token, link.trim()).then(
			(r) => {
				setPreviewing(false);
				setPreview(r);
			},
			(e) => {
				setPreviewing(false);
				setPreviewErr(describe(e));
			},
		);
	};

	const stage = (picked: PickedSkill) => {
		onStage(picked);
		onClose();
	};

	return (
		<div className="msheet" role="dialog" aria-label="Invoke a skill">
			<div className="msheet-head">
				<strong>Invoke a skill</strong>
				<button type="button" className="ghost" onClick={onClose}>
					Close
				</button>
			</div>
			<div className="msheet-body ops">
				<input
					type="search"
					value={query}
					placeholder="Filter skills"
					aria-label="Filter skills"
					onChange={(e) => setQuery(e.target.value)}
				/>
				{loadErr !== null && (
					<p className="error" role="alert">
						{loadErr}
					</p>
				)}
				{catalog !== null && rows.length === 0 && <p className="empty">No matching skills.</p>}
				{rows.map((c) => (
					<button
						key={c.name}
						type="button"
						className="skill-picker-row"
						title={`Invoke ${c.name} — its SKILL.md (${bytes(c.bodyBytes)}) rides the next turn`}
						onClick={() => stage({ name: c.name, ref: { name: c.name } })}
					>
						<span className="skill-picker-main">
							<strong>{c.name}</strong>
							{c.manualOnly && <span className="chip">manual-only</span>}
							<span className="skill-picker-sub">{c.description}</span>
						</span>
						<span className="skill-picker-side">{bytes(c.bodyBytes)}</span>
					</button>
				))}
				<div className="skill-from-link">
					<strong>From a GitHub URL — try without installing</strong>
					<div className="link-row">
						<input
							type="url"
							value={link}
							placeholder="https://github.com/…/tree/main/skills/…"
							aria-label="GitHub skill URL"
							onChange={(e) => setLink(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									runPreview();
								}
							}}
						/>
						<button type="button" disabled={previewing || link.trim() === ""} onClick={runPreview}>
							{previewing ? "Fetching…" : "Preview"}
						</button>
					</div>
					{previewErr !== null && (
						<p className="error" role="alert">
							{previewErr}
						</p>
					)}
					{preview !== null && (
						<div className="skill-preview-card">
							<strong>{preview.name}</strong>
							<span className="skill-picker-sub">{preview.description}</span>
							<span className="skill-picker-sub">
								{preview.sourceUrl} · SKILL.md {bytes(preview.bodyBytes)} · {preview.fileCount}{" "}
								files · {bytes(preview.dirBytes)}
								{preview.cached ? " · cached" : ""}
							</span>
							<span className={preview.verdict.status === "clean" ? "ops-row-sub" : "error"}>
								{VERDICT_LABEL[preview.verdict.status]}
							</span>
							<div className="link-row">
								<button
									type="button"
									className="ghost"
									onClick={() =>
										stage({
											name: preview.name,
											ref: { url: preview.sourceUrl, path: preview.path },
										})
									}
								>
									Stage it
								</button>
								<button type="button" onClick={() => setPreview(null)}>
									Discard
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
