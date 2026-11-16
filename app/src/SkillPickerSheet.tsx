// The composer's skill picker (ruling 2026-10-21, design/app.md →
// Skill picker & temp skills): the catalog — every valid entry,
// manual-only included — plus a from-link flow. A link previews
// server-side (fetch + System One score) and the card's yes/no decides:
// stage it, or drop it. Nothing is fetched into a send the card didn't
// approve. The catalog list rides @ui-sdk/react's `command` primitive
// (arrow-key highlight, Enter-to-run, listbox ARIA) with `filter={false}`
// because the rows are pre-filtered here; the from-link form below it
// stays plain.
import { useEffect, useState } from "react";
import type { SkillPreviewResponse, SkillsResponse } from "../../src/http/operator-wire.ts";
import { Command, CommandInput, CommandItem, CommandList } from "@ui-sdk/react/command";
import { listSkills, previewSkill } from "./api.ts";
import { bytes, describe } from "./opsShared.tsx";

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
	}, [token]);

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
	const stageByName = (name: string) => {
		const c = (catalog ?? []).find((x) => x.name === name);
		if (c !== undefined) stage({ name: c.name, ref: { name: c.name } });
	};

	// A layer over the whole app, not an in-flow expansion of the
	// composer form: this sheet is big and multi-step, so it takes the
	// model sheet's veil + bottom-sheet pattern (ruling 2026-11-16,
	// design/app.md → Skill picker & temp skills). The veil's click is
	// the tap-outside dismiss; the sheet stops propagation.
	return (
		<div className="veil on" onClick={onClose}>
			<div
				className="msheet"
				role="dialog"
				aria-label="Invoke a skill"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="msheet-head">
					<strong>Invoke a skill</strong>
					<button type="button" className="ghost" onClick={onClose}>
						Close
					</button>
				</div>
				<div className="msheet-body ops">
					{/* The sheet mounts inside the composer's <form> — a bare
						Enter here is an implicit submission and would send the
						draft out from under the picker. The picker owns the
						key before the command sees it: Enter stages the
						highlighted skill (never the form), and the filter
						input is the only input in play — the from-link input
						below keeps its own Enter. tagName, not instanceof:
						happy-dom realms have their own element classes. */}
					<Command
						className="skill-picker-command"
						query={query}
						onQueryChange={setQuery}
						filter={false}
						onAction={(name) => stageByName(name)}
						onKeyDownCapture={(e) => {
							if (e.key !== "Enter" || (e.target as HTMLElement | null)?.tagName !== "INPUT")
								return;
							e.preventDefault();
							e.stopPropagation();
							// The highlighted row is read from the DOM: the
							// command places auto-highlights silently, so
							// onValueChange alone misses them.
							if (query.trim() === "") return;
							const name =
								(e.currentTarget as HTMLElement).querySelector("[data-highlighted]")
									?.getAttribute("data-value") ?? null;
							if (name !== null) stageByName(name);
						}}
					>
						<CommandInput placeholder="Filter skills" aria-label="Filter skills" />
						{loadErr !== null && (
							<p className="error" role="alert">
								{loadErr}
							</p>
						)}
						{catalog !== null && rows.length === 0 && <p className="empty">No matching skills.</p>}
						<CommandList>
							{rows.map((c) => (
								<CommandItem
									key={c.name}
									value={c.name}
									data-value={c.name}
									className="skill-picker-row"
									title={`Invoke ${c.name} — its SKILL.md (${bytes(c.bodyBytes)}) rides the next turn`}
								>
									<span className="skill-picker-main">
										<strong>{c.name}</strong>
										{c.manualOnly && <span className="chip">manual-only</span>}
										<span className="skill-picker-sub">{c.description}</span>
									</span>
									<span className="skill-picker-side">{bytes(c.bodyBytes)}</span>
								</CommandItem>
							))}
						</CommandList>
					</Command>
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
		</div>
	);
}
