// Transcript rendering: one message's parts → transcript elements.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	getToolName,
	isToolUIPart,
	type DynamicToolUIPart,
	type ReasoningUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import { ApprovalCard } from "../Approvals.tsx";
import { ArtifactCard } from "../docview.tsx";
import { Markdown } from "../markdown.tsx";
import { bytes } from "../opsShared.tsx";
import { ToolRun, partFailed, partRunning, partSummaryLine } from "../tools/mod.tsx";
import { UiPart } from "../ui/UiPart.tsx";
import type { AttachmentRef } from "../../../src/agent/attachments.ts";
import {
	type Artifact,
	artifactOf,
	presentationsOf,
} from "../../../src/agent/tools/artifact-schema.ts";

// Tool calls and thoughts collapse into one expandable fold per
// contiguous run — prose (or a ui part, which renders inline) ends a
// run. The fold opens while a call is live or failed; the collapsed
// summary carries the one-line outcomes.
type ActivityPart = ToolUIPart | DynamicToolUIPart | ReasoningUIPart;
// A part that folds into an Activity run: a tool call (ui parts render
// inline as the interface and never join) or thought text with
// something in it.
function isActivityPart(p: UIMessage["parts"][number]): boolean {
	return (
		(isToolUIPart(p) && getToolName(p) !== "ui") || (p.type === "reasoning" && p.text.trim() !== "")
	);
}
function Activity({
	parts,
	live,
	ended,
}: {
	parts: ActivityPart[];
	live?: boolean | undefined;
	// The owning message's turn is over (unlanded record) — a stuck
	// streaming state can never progress, so it draws ended, not running.
	ended?: boolean | undefined;
}) {
	const tools = parts.filter((p): p is ToolUIPart | DynamicToolUIPart => isToolUIPart(p));
	const running = !ended && tools.some(partRunning);
	const failures = tools.filter(partFailed).length;
	const active = running || failures > 0;
	const lines = tools.map(partSummaryLine);
	// The fold drives itself until the operator steers it: activity
	// opens it, the lull between calls holds whatever it had (folding
	// for the gap flashes on every new call), and sealing — a part
	// lands behind the run, or the message stops arriving — settles
	// it: clean closes, failures stay open. A summary click outranks auto
	// for the rest of this fold's life: preventDefault keeps the DOM
	// from flipping on its own so React's `open` stays the one writer.
	const [auto, setAuto] = useState(active);
	const [userOpen, setUserOpen] = useState<boolean | null>(null);
	const growing = live === true;
	const seen = useRef({ active, growing });
	if (seen.current.active !== active || seen.current.growing !== growing) {
		seen.current = { active, growing };
		setAuto((cur) => (active ? true : growing ? cur : failures > 0));
	}
	const open = userOpen ?? auto;
	// A thought-only run keeps the plain Thought fold — "Worked" over
	// zero calls would read as a bug.
	if (tools.length === 0) {
		const thoughts = parts.filter((p): p is ReasoningUIPart => p.type === "reasoning");
		return (
			<details className="reasoning-fold">
				<summary>Thought</summary>
				{thoughts.map((p, i) => (
					<div key={i} className="reasoning">
						{p.text}
					</div>
				))}
			</details>
		);
	}
	return (
		<details className="worked" open={open}>
			<summary
				onClick={(e) => {
					e.preventDefault();
					setUserOpen(!open);
				}}
			>
				{running ? "Working" : "Worked"} · <span className="worked-sum">{lines.join("; ")}</span>
				{failures > 0 && <span className="worked-fail">— {failures} failed</span>}
			</summary>
			<ul>
				{parts.map((p, i) =>
					isToolUIPart(p) ? (
						<ToolRun
							key={p.toolCallId === "" ? i : p.toolCallId}
							part={p}
							// exactOptionalPropertyTypes: absent, never explicit undefined.
							{...(ended === true ? { ended: true } : {})}
						/>
					) : (
						<li key={`t${i}`}>
							<details className="reasoning-fold">
								<summary>Thought</summary>
								<div className="reasoning">{p.text}</div>
							</details>
						</li>
					),
				)}
			</ul>
		</details>
	);
}

export function FileIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="12"
			height="12"
		>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	);
}

// Read-back for a stored attachment — bearer header, blob, object URL;
// the server confines reads to workspace/attachments/.
// Raster and audio formats keep their type for inline rendering (<img>,
// <audio>, and their top-level documents run no script). Everything else —
// SVG carries script, and blob: URLs execute in this origin — is re-wrapped
// as octet-stream so opening it downloads, never executes.
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;
const INLINE_AUDIO = /^audio\//;
async function fetchAttachmentUrl(token: string | null, path: string): Promise<string> {
	const name = path.split("/").pop() ?? "";
	const res = await fetch(`/api/app/attachments/${encodeURIComponent(name)}`, {
		headers: token === null ? {} : { authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	const bytes = await res.blob();
	if (INLINE_IMAGE.test(bytes.type) || INLINE_AUDIO.test(bytes.type)) {
		return URL.createObjectURL(bytes);
	}
	return URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
}

// Transcript bytes are wire data — the persisted blob gets its shape
// checked at this render boundary, never cast. The check is
// structural (the server's zod schema imports node modules the
// browser bundle cannot carry): the required fields with their types,
// optional ones only when well-typed. A malformed blob renders as no
// chip / is skipped from draft restore — it must not throw the
// transcript (the app has no error boundary).
export function parseAttachmentRef(data: unknown): AttachmentRef | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const o = data as Record<string, unknown>;
	if (
		typeof o.path !== "string" ||
		typeof o.mediaType !== "string" ||
		typeof o.filename !== "string" ||
		typeof o.size !== "number"
	) {
		return null;
	}
	return {
		path: o.path,
		mediaType: o.mediaType,
		filename: o.filename,
		size: o.size,
		...(typeof o.transcript === "string" ? { transcript: o.transcript } : {}),
		...(typeof o.transcriptionError === "string"
			? { transcriptionError: o.transcriptionError }
			: {}),
		...(o.speech === true ? { speech: true } : {}),
	};
}

function AttachmentChip({ data, token }: { data: unknown; token: string | null }) {
	const ref = parseAttachmentRef(data);
	if (ref === null) return null;
	const isImage = ref.mediaType.startsWith("image/");
	const isAudio = ref.mediaType.startsWith("audio/");
	const path = ref.path;
	const [inlineUrl, setInlineUrl] = useState<string | null>(null);
	// A failed download surfaces as a chip message — a missing
	// attachment or expired credential otherwise reads as a dead button.
	const [dlError, setDlError] = useState<string | null>(null);
	useEffect(() => {
		if ((!isImage && !isAudio) || path === "") return;
		let live = true;
		let url: string | null = null;
		void fetchAttachmentUrl(token, path)
			.then((u) => {
				if (live) {
					url = u;
					setInlineUrl(u);
				} else {
					// Unmounted mid-fetch — the cleanup already ran, so
					// revoke here or the blob pins until page unload.
					URL.revokeObjectURL(u);
				}
			})
			.catch((e: unknown) => {
				// A dead prefetch otherwise degrades to the download chip
				// with no reason — show it like a failed download.
				if (live) setDlError(e instanceof Error ? e.message : "download failed");
			});
		return () => {
			live = false;
			if (url !== null) URL.revokeObjectURL(url);
		};
	}, [isImage, isAudio, path, token]);
	if (isImage && inlineUrl !== null) {
		return (
			<a className="attachment image" href={inlineUrl} target="_blank" rel="noreferrer">
				<img src={inlineUrl} alt={ref.filename} />
				<span className="attachment-name">{ref.filename}</span>
				<span className="attachment-size">{bytes(ref.size)}</span>
			</a>
		);
	}
	if (isAudio && inlineUrl !== null) {
		return (
			<span className="attachment audio">
				<audio controls preload="metadata" src={inlineUrl} />
				<span className="attachment-name">{ref.filename}</span>
				<span className="attachment-size">{bytes(ref.size)}</span>
				{ref.speech === true && ref.transcript !== undefined && (
					<span className="attachment-transcript">“{ref.transcript}”</span>
				)}
			</span>
		);
	}
	return (
		<span className="attachment">
			<FileIcon />
			{path !== "" ? (
				// A download, not window.open: the bytes aren't render-safe
				// (fetchAttachmentUrl wraps them as octet-stream) and the
				// object URL can be revoked the moment it starts.
				<button
					type="button"
					className="attachment-name link"
					onClick={() => {
						setDlError(null);
						void fetchAttachmentUrl(token, path).then(
							(u) => {
								const a = document.createElement("a");
								a.href = u;
								a.download = ref.filename;
								a.click();
								URL.revokeObjectURL(u);
							},
							(err: unknown) => {
								setDlError(err instanceof Error ? err.message : "download failed");
							},
						);
					}}
				>
					{ref.filename}
				</button>
			) : (
				<span className="attachment-name">{ref.filename}</span>
			)}
			<span className="attachment-size">{bytes(ref.size)}</span>
			{dlError !== null && <span className="msg-err">Download failed: {dlError}</span>}
			{ref.speech === true && ref.transcript !== undefined && (
				<span className="attachment-transcript">“{ref.transcript}”</span>
			)}
		</span>
	);
}

// An explicit skill invocation — the part is the durable record; the
// body rode only the owning turn's model view.
function SkillChip({ data }: { data: unknown }) {
	const d = (typeof data === "object" && data !== null ? data : {}) as {
		name?: string;
		url?: string;
		path?: string;
	};
	const temp = typeof d.url === "string";
	// A temp part carries {url, path} only — the staged layout
	// <digest>/<name>/SKILL.md yields the name the descriptor gave it.
	const tempName =
		typeof d.path === "string"
			? (d.path.split("/").filter(Boolean).at(-2) ?? "unknown")
			: "unknown";
	let host = d.url ?? "";
	if (temp && d.url !== undefined) {
		try {
			host = new URL(d.url).host;
		} catch {
			// The wire validated it; an unparseable survivor keeps the full form.
		}
	}
	return (
		<span
			className="attachment note-chip"
			title={
				temp
					? `Temp skill from ${d.url} — its body rode the turn that invoked it`
					: `Skill ${d.name ?? ""} — its body rode the turn that invoked it`
			}
		>
			<span aria-hidden="true">⚡</span>
			<span className="attachment-name">
				{temp ? "Temp skill · " : "Skill · "}
				{temp ? tempName : (d.name ?? "unknown")}
				{temp ? ` (${host})` : ""}
			</span>
		</span>
	);
}

function NoteChip({
	data,
	onOpenNote,
}: {
	data: unknown;
	onOpenNote?: ((id: string) => void) | undefined;
}) {
	const d = (typeof data === "object" && data !== null ? data : {}) as {
		id?: string;
		title?: string;
		rev?: number;
	};
	if (typeof d.id !== "string") return null;
	// An optimistic part (or older history) may carry only the id — it
	// labels itself rather than dropping the chip. A rev only displays
	// when the server's expansion actually stamped one.
	const label = `Note · ${typeof d.title === "string" ? d.title : d.id}${
		typeof d.rev === "number" ? ` · rev ${d.rev}` : ""
	}`;
	if (onOpenNote === undefined) {
		return (
			<a className="attachment note-chip" href={`/app/n/${encodeURIComponent(d.id)}`}>
				<FileIcon />
				<span className="attachment-name">{label}</span>
			</a>
		);
	}
	return (
		<span className="attachment note-chip">
			<FileIcon />
			<button type="button" className="attachment-name link" onClick={() => onOpenNote(d.id!)}>
				{label}
			</button>
		</span>
	);
}

export function MessageParts({
	parts,
	token,
	noteProjectId,
	onAction,
	onOpenNote,
	onNotesChanged,
	clipFences,
	busy,
	streaming,
	ended,
	messages,
}: {
	parts: UIMessage["parts"];
	token?: string | null;
	// The conversation's project — a note-card "New note" binds to it.
	noteProjectId?: string | null | undefined;
	// ui block actions (choices, form submits) post through the
	// caller's sendMessage; busy disables them while a turn runs.
	onAction?: ((text: string) => void) | undefined;
	// Note chips and the fenced note card navigate in-app when wired.
	onOpenNote?: ((id: string) => void) | undefined;
	onNotesChanged?: (() => void) | undefined;
	// Operator messages: long pasted fences clip to a preview. Model
	// output renders whole — its fences are the answer, not clutter.
	clipFences?: boolean | undefined;
	busy?: boolean | undefined;
	// This message is still arriving; older cards stay actionable during later turns.
	streaming?: boolean | undefined;
	// The owning turn is over (unlanded record): stuck tool states draw
	// ended — "no result recorded" — never a running shimmer.
	ended?: boolean | undefined;
	// The full transcript, when the caller has it: ui surfaces re-derive
	// their picked choice row from persisted [ui] messages.
	messages?: readonly UIMessage[] | undefined;
}) {
	const out: ReactNode[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (isToolUIPart(p) && getToolName(p) === "ui") {
			// ui parts render inline as the interface itself — they never
			// join a Worked run.
			out.push(
				<UiPart
					key={p.toolCallId === "" ? i : p.toolCallId}
					part={p}
					onAction={onAction}
					busy={busy}
					token={token}
					noteProjectId={noteProjectId}
					onOpenNote={onOpenNote}
					messages={messages}
					streaming={streaming}
				/>,
			);
			continue;
		}
		if (p.type === "data-approval") {
			const data =
				typeof p.data === "object" && p.data !== null
					? (p.data as { kind?: unknown; id?: unknown })
					: null;
			if ((data?.kind === "program" || data?.kind === "mail") && typeof data.id === "number") {
				out.push(<ApprovalCard key={i} token={token ?? null} kind={data.kind} id={data.id} />);
			}
			continue;
		}
		if (isActivityPart(p)) {
			const run: ActivityPart[] = [];
			let j = i;
			while (j < parts.length) {
				const q = parts[j]!;
				if (isToolUIPart(q)) {
					if (getToolName(q) === "ui") break;
					run.push(q);
				} else if (q.type === "reasoning") {
					// Empty reasoning parts exist in history — providers that
					// seal chain-of-thought (encrypted, or an unmapped
					// dialect) still emit the part. They carry nothing and
					// break nothing.
					if (q.text.trim() !== "") run.push(q);
				} else if (q.type === "text") {
					if (q.text.trim() !== "") break;
				} else if (
					q.type === "data-attachment" ||
					q.type === "data-note" ||
					q.type === "data-approval" ||
					q.type === "data-skill" ||
					q.type === "file"
				) {
					break;
				}
				// step-start, sources, and any future plumbing render as
				// nothing — they never split a run.
				j++;
			}
			// A run can still grow only while it owns the tail of a
			// streaming message — a run-ender behind it seals it even
			// while the message streams on.
			out.push(
				<Activity
					key={`w${i}`}
					parts={run}
					live={streaming === true && j === parts.length}
					ended={ended}
				/>,
			);
			// Published artifacts hoist out of the fold into cards — the
			// fold records that the call ran; the card is the openable
			// thing. Direct artifact calls and a script's collected
			// presentations land the same way.
			for (const q of run) {
				if (!isToolUIPart(q) || q.state !== "output-available") continue;
				const name = getToolName(q);
				const artifacts: Artifact[] =
					name === "artifact"
						? ([artifactOf(q.output)].filter((a) => a !== null) as Artifact[])
						: name === "script"
							? presentationsOf(q.output).map((p2) => p2.artifact)
							: [];
				for (const a of artifacts) {
					out.push(<ArtifactCard key={`a:${a.path}`} artifact={a} />);
				}
			}
			i = j - 1;
			continue;
		}
		if (p.type === "text")
			out.push(
				<Markdown
					key={i}
					text={p.text}
					token={token}
					noteProjectId={noteProjectId}
					onOpenNote={onOpenNote}
					onNotesChanged={onNotesChanged}
					streaming={streaming}
					clipFences={clipFences}
				/>,
			);
		else if (p.type === "data-attachment")
			out.push(<AttachmentChip key={i} data={p.data} token={token ?? null} />);
		else if (p.type === "data-note")
			out.push(<NoteChip key={i} data={p.data} onOpenNote={onOpenNote} />);
		else if (p.type === "data-skill") out.push(<SkillChip key={i} data={p.data} />);
		else if (p.type === "file")
			out.push(
				<span key={i} className="attachment">
					<FileIcon />
					<span className="attachment-name">{p.filename ?? "attachment"}</span>
				</span>,
			);
		else if (p.type === "source-url") {
			// Hosted-search citations arrive as source-url parts — group
			// the run into one compact row of links.
			const row: { url: string; title?: string }[] = [];
			let j = i;
			while (j < parts.length && parts[j]!.type === "source-url") {
				const q = parts[j] as {
					type: "source-url";
					url: string;
					title?: string;
				};
				row.push({ url: q.url, ...(q.title !== undefined ? { title: q.title } : {}) });
				j++;
			}
			out.push(
				<div key={i} className="sources-row">
					{row.map((src) => (
						<a
							key={src.url}
							href={src.url}
							target="_blank"
							rel="noreferrer"
							className="source-link"
						>
							{src.title ?? hostnameOf(src.url)}
						</a>
					))}
				</div>,
			);
			i = j - 1;
		}
	}
	return <>{out}</>;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}
