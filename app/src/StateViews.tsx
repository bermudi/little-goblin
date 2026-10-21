// State viewer: views over prod state — skills
// (installed + proposed) and workspace files (identity + attachments).
// Everything here renders what the server already validated; the
// containment wall lives in src/stateview.ts. Proposed skills are the
// one mutable row: install/discard ride the same skills/decide
// mechanics as the Telegram ✅/🚫 row.
import { useEffect, useRef, useState } from "react";
import {
	decideSkill,
	fetchAttachment,
	getIdentity,
	getSkillFile,
	listAttachments,
	listSkills,
} from "./api.ts";
import { bytes, describe, KV, ts, useLoad } from "./opsShared.tsx";
import type {
	AttachmentsResponse,
	IdentityResponse,
	OperatorAttachmentItem,
	OperatorSkillItem,
	SkillsResponse,
} from "../../src/http/operator-wire.ts";

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

function SkillCard({
	skill,
	origin,
	update,
	token,
	onDecided,
}: {
	skill: OperatorSkillItem;
	origin: "skills" | "proposed";
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
					{origin === "skills" ? "installed" : "proposed"}
				</span>
			</div>
			<KV k="updated" v={ts(skill.updatedAt)} />
			<KV k="size" v={bytes(skill.sizeBytes)} mono />
			{skill.truncated && <p className="empty">file list truncated — size is a floor</p>}
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
	installedNames,
	token,
	onDecided,
}: {
	title: string;
	items: OperatorSkillItem[];
	origin: "skills" | "proposed";
	/** Names of installed skills — a proposed card matching one is an
	    update, not a new skill. */
	installedNames?: ReadonlySet<string>;
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
					update={installedNames?.has(s.name)}
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
	const installedNames = new Set(d.skills.map((s) => s.name));
	return (
		<div className="ops">
			<SkillSection title="Skills" items={d.skills} origin="skills" token={token} />
			<SkillSection
				title="Proposed"
				items={d.proposed}
				origin="proposed"
				installedNames={installedNames}
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

function AttachmentRow({ file, token }: { file: OperatorAttachmentItem; token: string | null }) {
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
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			seq.current += 1;
			fetching.current = false;
			if (urlRef.current !== null) {
				URL.revokeObjectURL(urlRef.current);
				urlRef.current = null;
			}
		};
	}, []);

	const open = () => {
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
	};

	const kind = attachmentKind(file.name);
	return (
		<div className="card">
			<div className="op-item-head">
				<span className="op-item-title mono">{file.name}</span>
				{url === null && (
					<button type="button" className="pill" onClick={open} disabled={busy}>
						{kind === "other" ? "fetch file" : "preview"}
					</button>
				)}
			</div>
			<KV k="size" v={bytes(file.sizeBytes)} mono />
			<KV k="saved" v={ts(file.updatedAt)} />
			{err !== null && <p className="error">{err}</p>}
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

export function FilesView({ token }: { token: string | null }) {
	const identity = useLoad(() => getIdentity(token));
	const attachments = useLoad(() => listAttachments(token));
	if (identity.err !== null) return <OpsError err={identity.err} />;
	if (attachments.err !== null) return <OpsError err={attachments.err} />;
	if (identity.data === null || attachments.data === null) return <OpsLoading />;
	const id: IdentityResponse = identity.data;
	const att: AttachmentsResponse = attachments.data;
	return (
		<div className="ops">
			<h2 className="ops-h2">Identity</h2>
			{id.files.map((f) => (
				<div className="card" key={f.name}>
					<div className="op-item-head">
						<span className="op-item-title mono">{f.name}</span>
					</div>
					{f.content === null ? (
						<p className="empty">Not created yet.</p>
					) : (
						<div className="codeblock skill-source">
							<pre>{f.content}</pre>
						</div>
					)}
				</div>
			))}
			<h2 className="ops-h2">Attachments ({att.files.length})</h2>
			{att.files.length === 0 && <p className="empty">None saved.</p>}
			{att.files.map((f) => (
				<AttachmentRow key={f.name} file={f} token={token} />
			))}
		</div>
	);
}
