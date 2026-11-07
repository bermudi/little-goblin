// The Skills page (design/app.md → Non-chat page layout, #176): proposals
// first, each with its evidence open; installed skills as a table that says
// what each one does. Opening a skill replaces the list with its detail.
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	OperatorSkillItem,
	ProposedSkillItem,
	SkillDiff,
	SkillsResponse,
} from "../../src/http/operator-wire.ts";
import { decideSkill, getSkillFile, listSkills } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { bytes, describe, KV, ts, useLoad } from "./opsShared.tsx";

function plural(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** The file the operator reads in a skill: SKILL.md, else the first file. */
function firstFile(skill: OperatorSkillItem): string | null {
	return skill.files[0] ?? null;
}

type Origin = "skills" | "proposed";

/** One readable file of a skill. Only the newest request may answer — a
 *  late reply for an earlier pick, another skill or another token is
 *  dropped. Cleanup only bumps the counter; the clears belong to the setup
 *  that runs when identity changes. */
function useSkillFile(
	token: string | null,
	origin: Origin,
	skill: OperatorSkillItem,
	autoOpen: boolean,
) {
	const [file, setFile] = useState<string | null>(null);
	const [content, setContent] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const requestId = useRef(0);

	const open = useCallback(
		(path: string) => {
			const id = ++requestId.current;
			setFile(path);
			setContent(null);
			setErr(null);
			getSkillFile(token, origin, skill.name, path).then(
				(d) => {
					if (requestId.current === id) setContent(d.content);
				},
				(e) => {
					if (requestId.current === id) setErr(describe(e));
				},
			);
		},
		[token, origin, skill.name],
	);

	// The first file opens by itself where there is nothing else to read: a
	// new proposal (no diff) and an installed skill's detail.
	const first = autoOpen ? firstFile(skill) : null;
	useEffect(() => {
		setFile(null);
		setContent(null);
		setErr(null);
		if (first !== null) open(first);
		return () => {
			requestId.current += 1;
		};
	}, [open, first]);

	return { file, content, err, open };
}

function FileList({
	files,
	current,
	onOpen,
}: {
	files: string[];
	current: string | null;
	onOpen(path: string): void;
}) {
	return (
		<div className="skill-files">
			{files.map((f) => (
				<button
					key={f}
					type="button"
					className={current === f ? "skill-file on" : "skill-file"}
					onClick={() => onOpen(f)}
				>
					{f}
				</button>
			))}
		</div>
	);
}

// SKILL.md's frontmatter is metadata the card and table already show —
// the source view skips it. An unterminated block strips nothing.
const FRONTMATTER = /^---[^\n]*\n[\s\S]*?\n---[ \t]*\n/;

function FileSource({
	file,
	content,
	err,
}: {
	file: string | null;
	content: string | null;
	err: string | null;
}) {
	const shown = file === "SKILL.md" && content !== null ? content.replace(FRONTMATTER, "") : content;
	return (
		<>
			{err !== null && <p className="error">{err}</p>}
			{shown !== null && (
				<div className="codeblock skill-source" data-file={file ?? undefined}>
					<pre>{shown}</pre>
				</div>
			)}
		</>
	);
}

// What the proposal changes against the installed copy — the evidence the
// install decision needs (#162), open without a click.
function SkillDiffPanel({ diff }: { diff: SkillDiff }) {
	if (diff.kind === "new") {
		return <p className="empty">New skill — no installed copy to compare. Its files are below.</p>;
	}
	if (diff.files.length === 0) {
		return <p className="empty">No file differs from the installed copy.</p>;
	}
	return (
		<div className="skill-diff">
			<p className="empty">
				Changes against the installed copy — {plural(diff.files.length, "file")}
				{diff.unchanged.length > 0 && `, ${diff.unchanged.length} unchanged`}
			</p>
			{diff.files.map((f) => (
				<details key={f.path} className="skill-diff-file" open>
					<summary>
						{f.path} — {f.status}
						{!f.binary && ` (+${f.added} −${f.removed})`}
					</summary>
					{f.binary ? (
						<p className="empty">binary file — no line diff</p>
					) : (
						<DiffView lines={f.lines} />
					)}
				</details>
			))}
		</div>
	);
}

function Description({ skill }: { skill: OperatorSkillItem }) {
	return skill.description === null ? (
		<span className="skill-nodesc">No description in SKILL.md</span>
	) : (
		<>{skill.description}</>
	);
}

export function ProposalCard({
	proposal,
	token,
	onDecided,
	children,
}: {
	proposal: ProposedSkillItem;
	token: string | null;
	onDecided(): void;
	children?: ReactNode;
}) {
	const isUpdate = proposal.diff.kind === "update";
	const reader = useSkillFile(token, "proposed", proposal, !isUpdate);
	const [deciding, setDeciding] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const decide = (action: "install" | "discard") => {
		if (deciding) return;
		setDeciding(true);
		setErr(null);
		decideSkill(token, proposal.name, action).then(
			() => onDecided(),
			(e) => {
				setDeciding(false);
				setErr(describe(e));
			},
		);
	};

	return (
		<div className="approval-card skill-proposal">
			<div className="op-item-head">
				<span className="op-item-title">{proposal.name}</span>
				<span className={isUpdate ? "pill warn" : "pill"}>{isUpdate ? "update" : "new"}</span>
			</div>
			<p className="skill-desc prose">
				<Description skill={proposal} />
			</p>
			{proposal.truncated && <p className="empty">file list truncated — the diff is incomplete</p>}
			<SkillDiffPanel diff={proposal.diff} />
			<FileList files={proposal.files} current={reader.file} onOpen={reader.open} />
			<FileSource file={reader.file} content={reader.content} err={reader.err} />
			{children}
			<div className="approval-actions skill-decide">
				<button type="button" disabled={deciding} onClick={() => decide("install")}>
					{isUpdate ? "Install update" : "Install"}
				</button>
				<button type="button" disabled={deciding} onClick={() => decide("discard")}>
					{isUpdate ? "Discard update" : "Discard"}
				</button>
			</div>
			{err !== null && <p className="error">{err}</p>}
		</div>
	);
}

const SKILL_COLS = {
	"--dt-cols": "minmax(9rem, 1.2fr) minmax(14rem, 4fr) 4.5rem minmax(8rem, 1fr)",
} as CSSProperties;

function SkillTable({
	skills,
	onOpen,
}: {
	skills: OperatorSkillItem[];
	onOpen(name: string): void;
}) {
	return (
		<div className="dtable skills-table" style={SKILL_COLS}>
			<div className="dt-head" aria-hidden="true">
				<span>Skill</span>
				<span>What it does</span>
				<span>Files</span>
				<span>Updated</span>
			</div>
			{skills.map((s) => (
				<button type="button" className="dt-row" key={s.name} onClick={() => onOpen(s.name)}>
					<span className="dt-cell dt-main">{s.name}</span>
					<span className="dt-cell skill-what" data-label="What it does">
						<Description skill={s} />
					</span>
					<span className="dt-cell dt-hide-m">
						{s.truncated ? `${s.files.length}+` : s.files.length}
					</span>
					<span className="dt-cell" data-label="Updated">
						{ts(s.updatedAt)}
					</span>
				</button>
			))}
		</div>
	);
}

function Tile({ n, label, warn }: { n: number | string; label: string; warn?: boolean }) {
	return (
		<div className={warn === true ? "sumtile warn" : "sumtile"}>
			<b>{n}</b>
			<span>{label}</span>
		</div>
	);
}

function SkillDetail({
	skill,
	token,
	onBack,
}: {
	skill: OperatorSkillItem;
	token: string | null;
	onBack(): void;
}) {
	const reader = useSkillFile(token, "skills", skill, true);
	return (
		<div className="ops skills-page">
			<div className="ops-back">
				<button type="button" className="ghost" onClick={onBack}>
					‹ Skills
				</button>
			</div>
			<div className="prog-title">
				<h2>{skill.name}</h2>
				<span className="pill on">installed</span>
			</div>
			<div className="prose skill-desc">
				<Description skill={skill} />
			</div>
			<div className="card">
				<KV k="updated" v={ts(skill.updatedAt)} />
				<KV k="size" v={bytes(skill.sizeBytes)} mono />
				<KV k="files" v={String(skill.files.length)} mono />
			</div>
			{skill.truncated && <p className="empty">file list truncated — size is a floor</p>}
			<h2 className="ops-h2">Files</h2>
			<FileList files={skill.files} current={reader.file} onOpen={reader.open} />
			<FileSource file={reader.file} content={reader.content} err={reader.err} />
		</div>
	);
}

export function SkillsView({ token }: { token: string | null }) {
	const { data, err, reload } = useLoad(() => listSkills(token));
	const [openName, setOpenName] = useState<string | null>(null);
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
	const d: SkillsResponse = data;
	const open = d.skills.find((s) => s.name === openName) ?? null;
	if (open !== null) {
		return (
			<SkillDetail key={open.name} skill={open} token={token} onBack={() => setOpenName(null)} />
		);
	}
	const updates = d.proposed.filter((p) => p.diff.kind === "update").length;
	return (
		<div className="ops skills-page">
			<div className="sumstrip">
				<Tile n={d.proposed.length} label="awaiting decision" warn={d.proposed.length > 0} />
				<Tile n={updates} label="updates" />
				<Tile n={d.skills.length} label="installed" />
			</div>
			<h2 className="ops-h2">Proposed ({d.proposed.length})</h2>
			{d.proposed.length === 0 ? (
				<p className="empty">Nothing waiting for a decision.</p>
			) : (
				<div className="skill-proposals">
					{d.proposed.map((p) => (
						<ProposalCard key={p.name} proposal={p} token={token} onDecided={reload} />
					))}
				</div>
			)}
			<h2 className="ops-h2">Installed ({d.skills.length})</h2>
			{d.skills.length === 0 ? (
				<p className="empty">No skills installed.</p>
			) : (
				<SkillTable skills={d.skills} onOpen={setOpenName} />
			)}
		</div>
	);
}
