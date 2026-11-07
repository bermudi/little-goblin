// State viewer: views over prod state — skills
// (installed + proposed) and workspace files (identity + attachments).
// Everything here renders what the server already validated; the
// containment wall lives in src/stateview.ts. Proposed skills are the
// one mutable row: install/discard ride the same skills/decide
// mechanics as the Telegram ✅/🚫 row.
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type {
	AttachmentsResponse,
	IdentityResponse,
	OperatorAttachmentItem,
	OperatorSkillItem,
	ProposedSkillItem,
	SkillDiff,
	SkillsResponse,
} from "../../src/http/operator-wire.ts";
import {
	decideSkill,
	fetchAttachment,
	getIdentity,
	getSkillFile,
	listAttachments,
	listSkills,
} from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { bytes, describe, KV, ts, useLoad } from "./opsShared.tsx";

function OpsError({ err }: { err: string }) {
	return (
		<div className="ops">
			<p className="error">{err}</p>
		</div>
	);
}

function OpsLoading() {
	return (
		<div className="ops">
			<p className="empty">Loading…</p>
		</div>
	);
}

function plural(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? "" : "s"}`;
}

// What the proposal changes against the installed copy — the evidence
// the install decision needs (#162). A new skill has nothing to compare;
// its files open below.
function SkillDiffPanel({ diff }: { diff: SkillDiff }) {
	if (diff.kind === "new") {
		return (
			<p className="empty">New skill — no installed copy to compare. Open a file to read it.</p>
		);
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

function SkillCard({
	skill,
	origin,
	diff,
	update,
	token,
	onDecided,
}: {
	skill: OperatorSkillItem;
	origin: "skills" | "proposed";
	/** Proposals only: what the proposal changes against the installed copy. */
	diff?: SkillDiff | undefined;
	/** This proposal is an update to a live skill — the decide labels
	    say so, since bare "discard" could read as removing the
	    installed copy. */
	update?: boolean | undefined;
	token: string | null;
	/** Called after a successful install/discard so the list refetches. */
	onDecided?: (() => void) | undefined;
}) {
	const [file, setFile] = useState<string | null>(null);
	const [content, setContent] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [deciding, setDeciding] = useState(false);
	// Only the newest request may answer — an out-of-order response for
	// a previous selection must not overwrite it. The counter also
	// invalidates on unmount and on identity change (deps below), so a
	// reply addressed to a different card can never land here. Cleanup
	// only bumps the id — unmount must not write state; the clears
	// belong to the setup that runs when identity changes.
	const requestId = useRef(0);

	useEffect(() => {
		setFile(null);
		setContent(null);
		setErr(null);
		return () => {
			requestId.current += 1;
		};
	}, [token, origin, skill.name]);

	const open = (path: string) => {
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
	};

	const decide = (action: "install" | "discard") => {
		if (deciding) return;
		setDeciding(true);
		setErr(null);
		decideSkill(token, skill.name, action).then(
			() => onDecided?.(),
			(e) => {
				setDeciding(false);
				setErr(describe(e));
			},
		);
	};

	return (
		<div className="card">
			<div className="op-item-head">
				<span className="op-item-title">{skill.name}</span>
				<span className={origin === "skills" ? "pill on" : "pill"}>
					{origin === "skills" ? "installed" : diff?.kind === "update" ? "update" : "new"}
				</span>
			</div>
			{origin === "skills" && (
				<>
					<KV k="updated" v={ts(skill.updatedAt)} />
					<KV k="size" v={bytes(skill.sizeBytes)} mono />
				</>
			)}
			{skill.truncated && (
				<p className="empty">
					file list truncated —{" "}
					{origin === "proposed" ? "the diff is incomplete" : "size is a floor"}
				</p>
			)}
			{diff !== undefined && <SkillDiffPanel diff={diff} />}
			<div className="skill-files">
				{skill.files.map((f) => (
					<button
						key={f}
						type="button"
						className={file === f ? "skill-file on" : "skill-file"}
						onClick={() => open(f)}
					>
						{f}
					</button>
				))}
			</div>
			{origin === "proposed" && (
				<div className="skill-decide">
					<button
						type="button"
						className="pill"
						disabled={deciding}
						onClick={() => decide("install")}
					>
						{update === true ? "Install update" : "install"}
					</button>
					<button
						type="button"
						className="pill"
						disabled={deciding}
						onClick={() => decide("discard")}
					>
						{update === true ? "Discard update" : "discard"}
					</button>
				</div>
			)}
			{err !== null && <p className="error">{err}</p>}
			{content !== null && (
				<div className="codeblock skill-source">
					<pre>{content}</pre>
				</div>
			)}
		</div>
	);
}

function SkillSection({
	title,
	items,
	origin,
	token,
	onDecided,
}: {
	title: string;
	items: (OperatorSkillItem | ProposedSkillItem)[];
	origin: "skills" | "proposed";
	token: string | null;
	onDecided?: (() => void) | undefined;
}) {
	return (
		<>
			<h2 className="ops-h2">
				{title} ({items.length})
			</h2>
			{items.length === 0 && <p className="empty">None.</p>}
			{items.map((s) => (
				<SkillCard
					key={`${origin}:${s.name}`}
					skill={s}
					origin={origin}
					diff={"diff" in s ? s.diff : undefined}
					update={"diff" in s ? s.diff.kind === "update" : undefined}
					token={token}
					onDecided={onDecided}
				/>
			))}
		</>
	);
}

export function SkillsView({ token }: { token: string | null }) {
	const { data, err, reload } = useLoad(() => listSkills(token));
	if (err !== null) return <OpsError err={err} />;
	if (data === null) return <OpsLoading />;
	const d: SkillsResponse = data;
	return (
		<div className="ops">
			<SkillSection title="Skills" items={d.skills} origin="skills" token={token} />
			<SkillSection
				title="Proposed"
				items={d.proposed}
				origin="proposed"
				token={token}
				onDecided={reload}
			/>
		</div>
	);
}

function attachmentKind(name: string): "image" | "audio" | "video" | "other" {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
	if (["ogg", "oga", "opus", "mp3", "wav"].includes(ext)) return "audio";
	if (["mp4", "webm"].includes(ext)) return "video";
	return "other";
}

type FileKind = ReturnType<typeof attachmentKind>;

const KIND_LABEL: Record<FileKind, string> = {
	image: "image",
	audio: "audio",
	video: "video",
	other: "file",
};

// The detail view for one attachment. Media previews fetch when the view
// opens (opening is the click); anything else waits for "fetch file".
function AttachmentDetail({ file, token }: { file: OperatorAttachmentItem; token: string | null }) {
	const [url, setUrl] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The blob URL is owned by refs, not by render state: a response
	// landing after unmount must never mint one, and unmount revokes
	// whatever was minted whether or not it ever rendered. seq gates
	// late answers; fetching blocks a second click synchronously —
	// url state lags a frame and would orphan the older fetch's URL.
	const urlRef = useRef<string | null>(null);
	const live = useRef(false);
	const seq = useRef(0);
	const fetching = useRef(false);
	const kind = attachmentKind(file.name);

	const open = useCallback(() => {
		if (fetching.current || urlRef.current !== null) return;
		fetching.current = true;
		setBusy(true);
		setErr(null);
		const id = ++seq.current;
		fetchAttachment(token, file.name).then(
			(b) => {
				fetching.current = false;
				if (!live.current || seq.current !== id) return;
				const u = URL.createObjectURL(b);
				urlRef.current = u;
				setBusy(false);
				setUrl(u);
			},
			(e) => {
				fetching.current = false;
				if (!live.current || seq.current !== id) return;
				setBusy(false);
				setErr(describe(e));
			},
		);
	}, [token, file.name]);

	useEffect(() => {
		live.current = true;
		if (kind !== "other") open();
		return () => {
			live.current = false;
			seq.current += 1;
			fetching.current = false;
			if (urlRef.current !== null) {
				URL.revokeObjectURL(urlRef.current);
				urlRef.current = null;
			}
		};
	}, [kind, open]);

	return (
		<div className="file-detail">
			<h2 className="ops-h2 mono">{file.name}</h2>
			<div className="file-meta">
				<KV k="size" v={bytes(file.sizeBytes)} mono />
				<KV k="saved" v={ts(file.updatedAt)} />
			</div>
			{url === null && kind === "other" && (
				<button type="button" className="pill" onClick={open} disabled={busy}>
					fetch file
				</button>
			)}
			{busy && <p className="empty">Loading…</p>}
			{err !== null && (
				<>
					<p className="error">{err}</p>
					<button type="button" className="pill" onClick={open}>
						retry
					</button>
				</>
			)}
			{url !== null && kind === "image" && (
				<img className="attach-preview" src={url} alt={file.name} />
			)}
			{url !== null && kind === "audio" && <audio className="attach-preview" src={url} controls />}
			{url !== null && kind === "video" && <video className="attach-preview" src={url} controls />}
			{url !== null && (
				<a className="attach-download" href={url} download={file.name}>
					{kind === "other" ? "download" : "open raw"}
				</a>
			)}
		</div>
	);
}

// An identity file reads as one page of wrapped text: no inner scroller,
// the page scrolls (design/app.md → Non-chat page layout).
function IdentityDetail({ file }: { file: IdentityResponse["files"][number] }) {
	return (
		<div className="file-detail">
			<h2 className="ops-h2 mono">{file.name}</h2>
			{file.content === null ? (
				<p className="empty">Not created yet.</p>
			) : (
				<>
					<div className="file-meta">
						<KV k="size" v={bytes(new TextEncoder().encode(file.content).length)} mono />
					</div>
					<pre className="file-text">{file.content}</pre>
				</>
			)}
		</div>
	);
}

const IDENTITY_COLS = { "--dt-cols": "minmax(10rem, 2fr) 7rem 7rem" } as CSSProperties;
const ATTACH_COLS = { "--dt-cols": "minmax(12rem, 3fr) 6rem 10rem 5.5rem" } as CSSProperties;
// Past this many attachments the list is worth filtering.
const FILTER_FROM = 8;

type Opened = { kind: "identity" | "attachment"; name: string } | null;

export function FilesView({ token }: { token: string | null }) {
	const identity = useLoad(() => getIdentity(token));
	const attachments = useLoad(() => listAttachments(token));
	const [opened, setOpened] = useState<Opened>(null);
	const [q, setQ] = useState("");
	const page = useRef<HTMLDivElement>(null);
	// Opening replaces the list in the same pane; start at the top of it.
	useEffect(() => {
		if (page.current !== null) page.current.scrollTop = 0;
	}, [opened]);
	if (identity.err !== null) return <OpsError err={identity.err} />;
	if (attachments.err !== null) return <OpsError err={attachments.err} />;
	if (identity.data === null || attachments.data === null) return <OpsLoading />;
	const id: IdentityResponse = identity.data;
	const att: AttachmentsResponse = attachments.data;

	const idFile = opened?.kind === "identity" ? id.files.find((f) => f.name === opened.name) : null;
	const attFile =
		opened?.kind === "attachment" ? att.files.find((f) => f.name === opened.name) : null;
	if (idFile != null || attFile != null) {
		return (
			<div className="ops" ref={page}>
				<div className="ops-back">
					<button type="button" className="ghost" onClick={() => setOpened(null)}>
						‹ Files
					</button>
				</div>
				{idFile != null && <IdentityDetail file={idFile} />}
				{attFile != null && <AttachmentDetail file={attFile} token={token} />}
			</div>
		);
	}

	const needle = q.trim().toLowerCase();
	const shown = att.files
		.filter((f) => needle === "" || f.name.toLowerCase().includes(needle))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	return (
		<div className="ops" ref={page}>
			<h2 className="ops-h2">Identity</h2>
			<div className="dtable files-table" style={IDENTITY_COLS}>
				<div className="dt-head" aria-hidden="true">
					<span>File</span>
					<span>Size</span>
					<span>Status</span>
				</div>
				{id.files.map((f) => (
					<button
						type="button"
						className="dt-row"
						key={f.name}
						onClick={() => setOpened({ kind: "identity", name: f.name })}
					>
						<span className="dt-cell dt-main dt-mono">{f.name}</span>
						<span className="dt-cell" data-label="Size">
							{f.content === null ? "—" : bytes(new TextEncoder().encode(f.content).length)}
						</span>
						<span className="dt-cell dt-status">
							<span className="pill">{f.content === null ? "not created" : "created"}</span>
						</span>
					</button>
				))}
			</div>
			<h2 className="ops-h2">Attachments ({att.files.length})</h2>
			{att.files.length === 0 ? (
				<p className="empty">None saved.</p>
			) : (
				<>
					{att.files.length > FILTER_FROM && (
						<input
							className="rail-search ops-search file-filter"
							type="search"
							placeholder="filter by file name"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							autoCapitalize="off"
							aria-label="filter attachments"
						/>
					)}
					{shown.length === 0 ? (
						<p className="empty">No attachment matches.</p>
					) : (
						<div className="dtable files-table" style={ATTACH_COLS}>
							<div className="dt-head" aria-hidden="true">
								<span>Name</span>
								<span>Size</span>
								<span>Saved</span>
								<span>Type</span>
							</div>
							{shown.map((f) => (
								<button
									type="button"
									className="dt-row"
									key={f.name}
									onClick={() => setOpened({ kind: "attachment", name: f.name })}
								>
									<span className="dt-cell dt-main dt-mono">{f.name}</span>
									<span className="dt-cell" data-label="Size">
										{bytes(f.sizeBytes)}
									</span>
									<span className="dt-cell" data-label="Saved">
										{ts(f.updatedAt)}
									</span>
									<span className="dt-cell dt-status">
										<span className="pill">{KIND_LABEL[attachmentKind(f.name)]}</span>
									</span>
								</button>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
