// State viewer (ruling 2026-10-11): read-only views over prod state —
// skills (installed + proposed) and workspace files (identity +
// attachments). Everything here renders what the server already
// validated; the containment wall lives in src/stateview.ts.
import { useEffect, useState } from "react";
import { fetchAttachment, getIdentity, getSkillFile, listAttachments, listSkills } from "./api.ts";
import { describe, KV, ts, useLoad } from "./opsShared.tsx";
import type {
	AttachmentsResponse,
	IdentityResponse,
	OperatorAttachmentItem,
	OperatorSkillItem,
	SkillsResponse,
} from "../../src/http/operator-wire.ts";

function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
	token,
}: {
	skill: OperatorSkillItem;
	origin: "skills" | "proposed";
	token: string | null;
}) {
	const [file, setFile] = useState<string | null>(null);
	const [content, setContent] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const open = (path: string) => {
		setFile(path);
		setContent(null);
		setErr(null);
		getSkillFile(token, origin, skill.name, path).then(
			(d) => setContent(d.content),
			(e) => setErr(describe(e)),
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
			<div className="skill-files">
				{skill.files.map((f) => (
					<button
						key={f}
						type="button"
						className={file === f ? "skill-file on" : "skill-file"}
						onClick={() => open(f)}
					>
						{f.slice(skill.name.length + 1)}
					</button>
				))}
			</div>
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
}: {
	title: string;
	items: OperatorSkillItem[];
	origin: "skills" | "proposed";
	token: string | null;
}) {
	return (
		<>
			<h2 className="ops-h2">
				{title} ({items.length})
			</h2>
			{items.length === 0 && <p className="empty">None.</p>}
			{items.map((s) => (
				<SkillCard key={`${origin}:${s.name}`} skill={s} origin={origin} token={token} />
			))}
		</>
	);
}

export function SkillsView({ token }: { token: string | null }) {
	const { data, err } = useLoad(() => listSkills(token));
	if (err !== null) return <OpsError err={err} />;
	if (data === null) return <OpsLoading />;
	const d: SkillsResponse = data;
	return (
		<div className="ops">
			<SkillSection title="Skills" items={d.skills} origin="skills" token={token} />
			<SkillSection title="Proposed" items={d.proposed} origin="proposed" token={token} />
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

	useEffect(() => {
		if (url === null) return;
		return () => {
			URL.revokeObjectURL(url);
		};
	}, [url]);

	const open = () => {
		if (url !== null) return;
		fetchAttachment(token, file.name).then(
			(b) => setUrl(URL.createObjectURL(b)),
			(e) => setErr(describe(e)),
		);
	};

	const kind = attachmentKind(file.name);
	return (
		<div className="card">
			<div className="op-item-head">
				<span className="op-item-title mono">{file.name}</span>
				{url === null && kind !== "other" && (
					<button type="button" className="pill" onClick={open}>
						preview
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
					open raw
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
