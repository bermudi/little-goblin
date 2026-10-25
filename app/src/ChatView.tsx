import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type ReactNode,
	type RefObject,
	type SetStateAction,
} from "react";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	getToolName,
	isToolUIPart,
	type ChatTransport,
	type DynamicToolUIPart,
	type ReasoningUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import {
	branchConversation,
	compactConversation,
	getConfig,
	getContext,
	getConversationConfig,
	getConversationMemory,
	getMessages,
	listNotes,
	patchConfig,
	patchConversationConfig,
	patchConversationMemory,
	rateReply,
	stopConversation,
	toggleFavorite,
	uploadAttachment,
} from "./api.ts";
import { loadComposerDraft, saveComposerDraft } from "./composerDraft.ts";
import { Outline } from "./Outline.tsx";
import { usePhoneWidth } from "./usePhoneWidth.ts";
import { ApprovalCard } from "./Approvals.tsx";
import { ArtifactCard, DocViewerProvider } from "./docview.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SkillPickerSheet } from "./SkillPickerSheet.tsx";
import { InterruptedTurns } from "./InterruptedTurns.tsx";
import { Markdown } from "./markdown.tsx";
import { bytes } from "./opsShared.tsx";
import { SpeechPlayer, useSpeech } from "./speech.tsx";
import { useCopy } from "./useCopy.ts";
import { ToolRun, partFailed, partRunning, partSummaryLine } from "./tools/mod.tsx";
import { UiPart } from "./ui/UiPart.tsx";
import type { AttachmentRef } from "../../src/agent/attachments.ts";
import {
	type Artifact,
	artifactOf,
	presentationsOf,
} from "../../src/agent/tools/artifact-schema.ts";
import type {
	AppConfigView,
	AppContextView,
	AppConversationMemoryView,
	AppLiveContext,
	AppNoteSummary,
	AppRatedReply,
	AppReplyRating,
	TurnMetadata,
} from "../../src/http/app-wire.ts";

// ---------- transcript rendering ----------

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
function Activity({ parts, live }: { parts: ActivityPart[]; live?: boolean | undefined }) {
	const tools = parts.filter((p): p is ToolUIPart | DynamicToolUIPart => isToolUIPart(p));
	const running = tools.some(partRunning);
	const failures = tools.filter(partFailed).length;
	const active = running || failures > 0;
	const lines = tools.map(partSummaryLine);
	// The fold drives itself until the operator steers it: activity
	// opens it, the lull between calls holds whatever it had (folding
	// for the gap flashes on every new call), and sealing — the
	// message done arriving, the run unable to grow — settles it:
	// clean closes, failures stay open. A summary click outranks auto
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
						<ToolRun key={p.toolCallId === "" ? i : p.toolCallId} part={p} />
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

function FileIcon() {
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

function AttachmentChip({ data, token }: { data: unknown; token: string | null }) {
	const ref = (typeof data === "object" && data !== null ? data : {}) as AttachmentRef;
	const isImage = typeof ref.mediaType === "string" && ref.mediaType.startsWith("image/");
	const isAudio = typeof ref.mediaType === "string" && ref.mediaType.startsWith("audio/");
	const path = typeof ref.path === "string" ? ref.path : "";
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
	if (typeof ref.filename !== "string") return null;
	if (isImage && inlineUrl !== null) {
		return (
			<a className="attachment image" href={inlineUrl} target="_blank" rel="noreferrer">
				<img src={inlineUrl} alt={ref.filename} />
				<span className="attachment-name">{ref.filename}</span>
				{typeof ref.size === "number" && <span className="attachment-size">{bytes(ref.size)}</span>}
			</a>
		);
	}
	if (isAudio && inlineUrl !== null) {
		return (
			<span className="attachment audio">
				<audio controls preload="metadata" src={inlineUrl} />
				<span className="attachment-name">{ref.filename}</span>
				{typeof ref.size === "number" && <span className="attachment-size">{bytes(ref.size)}</span>}
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
			{typeof ref.size === "number" && <span className="attachment-size">{bytes(ref.size)}</span>}
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
	clipFences,
	busy,
	streaming,
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
	// Operator messages: long pasted fences clip to a preview. Model
	// output renders whole — its fences are the answer, not clutter.
	clipFences?: boolean | undefined;
	busy?: boolean | undefined;
	// This message is still arriving; older cards stay actionable during later turns.
	streaming?: boolean | undefined;
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
			out.push(<Activity key={`w${i}`} parts={run} live={streaming} />);
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
	}
	return <>{out}</>;
}

// ---------- per-message actions + turn stats ----------

// The runtime stamps finish metadata on the assistant message (model,
// duration, token counts) — it rides the live stream and persists into
// history. Narrow the unknown blob rather than trusting the shape.
function turnMeta(m: UIMessage): TurnMetadata | null {
	const md = (m as { metadata?: unknown }).metadata;
	if (typeof md !== "object" || md === null) return null;
	const o = md as Record<string, unknown>;
	if (typeof o.model !== "string" || typeof o.durationMs !== "number") return null;
	const usage = (o.usage ?? {}) as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	// Fall back as a pair only for legacy metadata; explicit null or
	// a missing companion final-step field means unavailable.
	const hasFinalUsage = "lastInput" in usage || "lastCacheRead" in usage;
	return {
		model: o.model,
		finishReason: typeof o.finishReason === "string" ? o.finishReason : "",
		durationMs: o.durationMs,
		forcedCompletion:
			o.forcedCompletion === "repeat" ||
			o.forcedCompletion === "watchdog" ||
			o.forcedCompletion === "context"
				? o.forcedCompletion
				: null,
		usage: {
			input: num(usage.input),
			output: num(usage.output),
			cacheRead: num(usage.cacheRead),
			cacheWrite: num(usage.cacheWrite),
			lastInput: num(hasFinalUsage ? usage.lastInput : usage.input),
			lastCacheRead: num(hasFinalUsage ? usage.lastCacheRead : usage.cacheRead),
		},
	};
}

function messageText(m: UIMessage): string {
	return m.parts
		.map((p) => (p.type === "text" ? p.text : ""))
		.join("\n")
		.trim();
}

// Compact stat formatting — "1.2k", "340", "4.2s".
const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function MetaLine({ meta }: { meta: TurnMetadata }) {
	const bits: string[] = [meta.model];
	if (meta.finishReason !== "" && meta.finishReason !== "stop") bits.push(meta.finishReason);
	// A forced answer is degraded goods — stamped, never passed off as
	// natural. repeat: the deterministic detector; watchdog: system1
	// judged the loop stuck twice; context: the window filled mid-turn.
	if (meta.forcedCompletion === "repeat") bits.push("loop detector — answer forced");
	if (meta.forcedCompletion === "watchdog") bits.push("loop watchdog — answer forced");
	if (meta.forcedCompletion === "context") bits.push("context nearly full — answer forced");
	bits.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
	// The window number is the final step's prompt — not the billed sum
	// across the tool loop's re-sent prompts; the gauge and this line agree.
	const input = meta.usage.lastInput;
	const cacheRead = meta.usage.lastCacheRead;
	const { output } = meta.usage;
	if (input !== null || output !== null) {
		let tok = `${input === null ? "?" : kfmt(input)}→${output === null ? "?" : kfmt(output)} tok`;
		if (cacheRead !== null && cacheRead > 0) tok += ` (${kfmt(cacheRead)} cached)`;
		bits.push(tok);
	}
	return <div className="msg-meta">{bits.join(" · ")}</div>;
}

export function ActionBar({
	message,
	isLastAssistant,
	busy,
	onRetry,
	token,
	rateable,
	rating,
	ratingPending,
	ratingError,
	onRate,
	onBranch = null,
	branchPending = false,
	branchError = null,
}: {
	message: UIMessage;
	isLastAssistant: boolean;
	busy: boolean;
	onRetry: () => void;
	token: string | null;
	rateable: boolean;
	rating: AppReplyRating | null;
	ratingPending: boolean;
	ratingError: string | null;
	onRate: (rating: AppReplyRating) => void;
	// A branch copies this conversation through the reply and opens the
	// new chat. Null = the surface has nowhere to navigate (tests, a
	// read-only view), so the affordance is absent rather than inert.
	onBranch?: (() => void) | null;
	branchPending?: boolean;
	branchError?: string | null;
}) {
	const text = messageText(message);
	const { copied, failed, copy } = useCopy();
	const speech = useSpeech(token);
	const open = speech.phase !== "closed";
	return (
		<>
			<div className="msg-actions">
				<button
					type="button"
					onClick={() => copy(text)}
					aria-label={failed ? "Copy failed" : copied ? "Copied" : "Copy"}
					aria-live="polite"
				>
					{copied ? "✓ copied" : failed ? "✗ copy failed" : "copy"}
				</button>
				{text !== "" && (
					<button
						type="button"
						onClick={() => (open ? speech.stop() : void speech.start(text))}
						aria-label={speech.phase === "open" ? "Stop reading aloud" : "Read aloud"}
						disabled={speech.phase === "loading"}
					>
						{speech.phase === "open" ? "■ stop" : speech.phase === "loading" ? "…" : "▶ read"}
					</button>
				)}
				{rateable && (
					<>
						<button
							type="button"
							className={rating === "up" ? "on" : undefined}
							onClick={() => onRate("up")}
							aria-label="Rate reply helpful"
							aria-pressed={rating === "up"}
							disabled={ratingPending}
						>
							helpful
						</button>
						<button
							type="button"
							className={rating === "down" ? "on" : undefined}
							onClick={() => onRate("down")}
							aria-label="Rate reply bad"
							aria-pressed={rating === "down"}
							disabled={ratingPending}
						>
							bad
						</button>
					</>
				)}
				{speech.err !== null && <span className="msg-err">{speech.err}</span>}
				{ratingError !== null && <span className="msg-err">{ratingError}</span>}
				{isLastAssistant && !busy && (
					<button type="button" onClick={onRetry} aria-label="Retry">
						↻ retry
					</button>
				)}
				{onBranch !== null && (
					<button
						type="button"
						onClick={onBranch}
						aria-label="Branch conversation"
						disabled={busy || branchPending}
					>
						{branchPending ? "branching…" : "⑂ branch"}
					</button>
				)}
				{branchError !== null && <span className="msg-err">{branchError}</span>}
			</div>
			{speech.phase === "open" && (
				<SpeechPlayer
					playing={speech.playing}
					rate={speech.rate}
					position={speech.position}
					duration={speech.duration}
					onToggle={speech.toggle}
					onSeekBy={speech.seekBy}
					onSeekTo={speech.seekTo}
					onRate={speech.cycleRate}
					onStop={speech.stop}
				/>
			)}
		</>
	);
}

// The operator's own messages carry the two actions that make sense on a
// prompt: copy it, or rewrite it. A rewrite is a rewind — the view warns
// when a tail will be dropped, and branch is the non-destructive path.
function UserActions({
	message,
	disabled,
	onEdit,
}: {
	message: UIMessage;
	disabled: boolean;
	onEdit: () => void;
}) {
	const text = messageText(message);
	const { copied, failed, copy } = useCopy();
	return (
		<div className="msg-actions user-actions">
			<button
				type="button"
				onClick={() => copy(text)}
				aria-label={failed ? "Copy failed" : copied ? "Copied" : "Copy message"}
				aria-live="polite"
				disabled={text === ""}
			>
				{copied ? "✓ copied" : failed ? "✗ copy failed" : "copy"}
			</button>
			<button type="button" onClick={onEdit} aria-label="Edit message" disabled={disabled}>
				edit
			</button>
		</div>
	);
}

// Rewriting a prompt keeps everything that is not text (attachments,
// note and skill chips): the first text part carries the new words and
// any additional text parts collapse into it.
export function editedParts(message: UIMessage, text: string): UIMessage["parts"] {
	const parts: UIMessage["parts"] = [];
	let placed = false;
	for (const part of message.parts) {
		if (part.type !== "text") {
			parts.push(part);
			continue;
		}
		if (placed) continue;
		parts.push({ type: "text", text });
		placed = true;
	}
	if (!placed) parts.unshift({ type: "text", text });
	return parts;
}

// ---------- the composer ----------

// A quote goes into the draft as a markdown blockquote — appended, never
// replaced, so one reply can collect quotes from several sections of a
// message. Trailing blank line lands the cursor under the block, ready
// to type the answer.
export function appendQuote(draft: string, text: string): string {
	const block = text
		.trim()
		.split("\n")
		.map((l) => (l.trim() === "" ? ">" : `> ${l}`))
		.join("\n");
	const head = draft.trimEnd();
	return head === "" ? `${block}\n\n` : `${head}\n\n${block}\n\n`;
}

// Selection → quote: a pill parked at the selection's rect while a
// non-collapsed selection lives inside the transcript. The browser owns
// the selection (native callout included) — we only read it; the
// pointerdown preventDefault keeps the click from collapsing it first.
function QuoteFab({
	root,
	onQuote,
}: {
	root: RefObject<HTMLElement | null>;
	onQuote: (text: string) => void;
}) {
	const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
	useEffect(() => {
		const update = () => {
			const sel = document.getSelection();
			const el = root.current;
			if (
				sel === null ||
				el === null ||
				sel.isCollapsed ||
				sel.rangeCount === 0 ||
				sel.toString().trim() === ""
			) {
				setPos(null);
				return;
			}
			const range = sel.getRangeAt(0);
			const node = range.commonAncestorContainer;
			const container = node instanceof Element ? node : node.parentElement;
			if (container === null || !el.contains(container)) {
				setPos(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > window.innerHeight) {
				setPos(null);
				return;
			}
			const x = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
			setPos(
				rect.top > 44
					? { x, y: rect.top - 8, above: true }
					: { x, y: rect.bottom + 8, above: false },
			);
		};
		document.addEventListener("selectionchange", update);
		window.addEventListener("resize", update);
		const el = root.current;
		el?.addEventListener("scroll", update);
		return () => {
			document.removeEventListener("selectionchange", update);
			window.removeEventListener("resize", update);
			el?.removeEventListener("scroll", update);
		};
	}, [root]);
	if (pos === null) return null;
	return (
		<button
			type="button"
			className="quote-fab"
			style={{
				left: pos.x,
				top: pos.y,
				transform: pos.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
			}}
			onPointerDown={(e) => e.preventDefault()}
			onClick={() => {
				const sel = document.getSelection();
				const text = sel === null ? "" : sel.toString();
				sel?.removeAllRanges();
				setPos(null);
				if (text.trim() !== "") onQuote(text);
			}}
		>
			Quote
		</button>
	);
}

// One staged attachment. The list is owned above the composer (App),
// not inside it: the empty state's composer unmounts when its first
// send creates the conversation, and an upload resolving after that
// unmount must write into the lifted list, not the discarded
// component.
// Entries carry a client key — pasted images all arrive named
// "image.png", so filename can't pick which staging row an upload
// resolves. `speech` marks a voice note staged while a turn was
// running — send() re-applies the flag so intake still transcribes.
export interface StagedUpload {
	key: string;
	ref: AttachmentRef;
	uploading?: boolean;
	failed?: boolean;
	speech?: boolean;
	// Object URL for a local image preview — created at stage time,
	// revoked when the entry leaves the staged list.
	thumb?: string;
}

// A note picked for the next send — id only; the server expands it at
// intake. Lifted beside `staged` for the same reason: chips must
// outlive the empty-state composer.
export interface StagedNote {
	key: string;
	id: string;
	title: string;
}

// An explicit skill invocation (ruling 2026-10-21) — staged from the
// picker, sent as a data-skill part. Catalog refs resolve at
// admission; temp refs pin a fetched, verdict-stamped copy.
export interface StagedSkill {
	key: string;
	name: string;
	ref: { name: string } | { url: string; path: string };
}

// Staging dedups by reference, never display name — a catalog skill
// and a fetched copy that named itself the same are distinct skills,
// and two temp refs pin different sources. Catalog refs equal by
// name; temp refs by url and path together.
const skillRefEquals = (a: StagedSkill["ref"], b: StagedSkill["ref"]): boolean =>
	"name" in a
		? "name" in b && a.name === b.name
		: "url" in b && a.url === b.url && a.path === b.path;

// The composer's note picker — a search over the whole notes pool
// (project "all"), debounced like the rail's.
function NotePicker({
	token,
	onPick,
	onClose,
	pickRef,
}: {
	token: string | null;
	onPick: (n: AppNoteSummary) => void;
	onClose: () => void;
	pickRef: RefObject<HTMLDivElement | null>;
}) {
	const [query, setQuery] = useState("");
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	// The wire's hit-the-bound bit — a capped list must say so, not
	// read as complete (same contract as the notes index).
	const [truncated, setTruncated] = useState(false);
	const [failed, setFailed] = useState(false);
	const seq = useRef(0);
	useEffect(() => {
		const n = ++seq.current;
		const t = setTimeout(() => {
			void listNotes(token, { project: "all", q: query }).then(
				(r) => {
					if (n === seq.current) {
						setNotes(r.notes);
						setTruncated(r.truncated);
						setFailed(false);
					}
				},
				() => {
					if (n === seq.current) setFailed(true);
				},
			);
		}, 200);
		return () => clearTimeout(t);
	}, [query, token]);
	return (
		<div className="note-pick composer-pick" ref={pickRef}>
			<input
				type="search"
				placeholder="Search notes"
				aria-label="Search notes"
				value={query}
				autoFocus
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					// The input lives inside the composer form — an
					// unguarded Enter would implicitly submit the draft.
					// Both keys stay picker-local.
					if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						onClose();
					}
				}}
			/>
			{failed && <p className="error">Couldn't list notes.</p>}
			<ul>
				{(notes ?? []).map((n) => (
					<li key={n.id}>
						<button
							type="button"
							onClick={() => {
								onPick(n);
								onClose();
							}}
						>
							{n.title}
							{n.projectId !== null && <span className="note-proj"> · project</span>}
						</button>
					</li>
				))}
				{notes !== null && notes.length === 0 && (
					<li className="empty">{query === "" ? "No notes yet." : "No matches."}</li>
				)}
			</ul>
			{truncated && notes !== null && notes.length > 0 && (
				<p className="empty" role="status">
					Showing the first {notes.length} matching notes — narrow the search to find the rest.
				</p>
			)}
		</div>
	);
}

// ---------- the context gauge ----------

// Compact token counts — "340", "1.5k", "104.3k", "1M". One decimal
// only past the thousand mark and only when it carries information —
// whole thousands read as "200k", not "200.0k".
export function contextCount(n: number): string {
	const fmt = (v: number) => {
		const r = Math.round(v * 10) / 10;
		return Number.isInteger(r) ? `${r}` : r.toFixed(1);
	};
	if (n >= 999_950) return `${fmt(n / 1_000_000)}M`;
	if (n >= 1000) return `${fmt(n / 1000)}k`;
	return `${n}`;
}

const contextRate = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

// Itemization row labels — keys are the server's itemize.ts segments.
const SEGMENT_LABELS: Record<string, string> = {
	identity: "Identity (SOUL.md)",
	environment: "Environment",
	project: "Project",
	agentsMd: "AGENTS.md",
	userMd: "USER.md",
	skills: "Skills",
	toolDefs: "Tool definitions",
	history: "History",
	toolResults: "· tool calls & results",
};

// The gauge's one-line label for a context view. Null input reads as
// "no turns yet" on a fresh conversation, "ctx ?" when turns exist but
// the provider reported no usable counts.
export function contextLabel(ctx: AppContextView | null): string {
	if (ctx === null) return "…";
	if (ctx.input === null) return ctx.turns === 0 ? "no turns yet" : "ctx ?";
	if (ctx.limit === null) return `${contextCount(ctx.input)} tok`;
	return `${contextCount(ctx.input)}/${contextCount(ctx.limit)} · ${ctx.pct === null ? "?" : `${ctx.pct}%`}`;
}

// The composer's context gauge — the last turn's window utilization
// against the conversation model's catalog limit, with cache-hit rates
// in the popover. Reads stay cheap: one GET on mount and one per
// settled turn (busy → idle), never mid-stream.
export function ContextGauge({
	token,
	conversationId,
	busy,
	live,
	model,
}: {
	token: string | null;
	conversationId: string | undefined;
	busy: boolean;
	// The in-flight turn's window occupancy, streamed over the chat
	// wire — the gauge's numbers while a turn runs. The settled view
	// is one turn behind then.
	live?: AppLiveContext | null | undefined;
	// The conversation's configured model — what the next turn runs.
	// A read carries the model it was made for; when this one differs,
	// the read's limit says nothing about the live window and only the
	// bare token count shows until the re-read lands.
	model?: string | undefined;
}) {
	const [ctx, setCtx] = useState<AppContextView | null>(null);
	const [failed, setFailed] = useState(false);
	// Why the last read failed — the tooltip's debugging hook; empty on
	// success. Never rendered as UI text.
	const [lastError, setLastError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [compacting, setCompacting] = useState(false);
	// The manual lever's own readout — the gauge numbers are the last
	// turn's usage, so a fold doesn't move them until the next turn;
	// the outcome line is the feedback that it happened.
	const [compactNote, setCompactNote] = useState<string | null>(null);
	const seq = useRef(0);
	// seq also ticks per read — identity moves only on a credential or
	// conversation switch, which is what actually orphans a pending
	// compact POST.
	const identity = useRef(0);
	const gaugeRef = useRef<HTMLSpanElement | null>(null);
	const btnRef = useRef<HTMLButtonElement | null>(null);
	// A read belongs to the conversation that produced it — an id (or
	// credential) switch makes it stale, and a still-in-flight read for
	// the old identity must never land: bump seq here, since the fetch
	// effect's early returns skip the bump. Identity bumps here too,
	// orphaning any compact POST the switch leaves pending. Kept out of
	// that effect so its post-turn re-runs hold the last read until the
	// new one lands.
	// The popover belongs to the conversation too — a switch closes it,
	// so the next conversation's read can't pop open over the composer.
	useEffect(() => {
		seq.current++;
		identity.current++;
		setCtx(null);
		setFailed(false);
		setLastError(null);
		setOpen(false);
		setCompacting(false);
		setCompactNote(null);
	}, [token, conversationId]);
	const read = () => {
		if (conversationId === undefined || busy) return;
		const n = ++seq.current;
		setFailed(false);
		setLastError(null);
		void getContext(token, conversationId).then(
			(c) => {
				if (n === seq.current) setCtx(c);
			},
			(err: unknown) => {
				if (n === seq.current) {
					setFailed(true);
					setLastError(err instanceof Error ? err.message : "request failed");
				}
			},
		);
	};
	useEffect(() => {
		read();
		// The model knob rides along: a model change between turns must
		// re-read, or the gauge would keep utilizing against the previous
		// model's limit. cfg resolving after mount re-fires this once —
		// a duplicate GET the seq retires.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, conversationId, busy, model]);
	// Dismiss on any outside press or Escape — the gauge button's own
	// toggle stays the open path. Escape hands focus back to the control
	// that opened it.
	useEffect(() => {
		if (!open) return;
		const onPointer = (e: Event) => {
			if (gaugeRef.current?.contains(e.target as Node | null) === true) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			btnRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	if (conversationId === undefined) return null;
	// The limit the gauge's arithmetic may use — the read's figure only
	// when the read belongs to the conversation's live model. A model
	// change between turns outdates it (the token count survives, the
	// window doesn't), and until the fresh read lands only the count is
	// known. Without the live model the caller can't know better, so
	// the read stands.
	const limit =
		ctx !== null &&
		ctx.limit !== null &&
		ctx.limit > 0 &&
		(model === undefined || ctx.model === model)
			? ctx.limit
			: null;
	// The figures every face shows — the streaming turn's metered step
	// while it reports one, the settled read's until it does. Label,
	// ring, and popover all derive from these, so they cannot disagree.
	// A stale number beats a placeholder (ruling 2026-10-24): while a
	// turn runs without a metered step — before the first report, or a
	// step the provider didn't meter — the last settled read stands in.
	const viewInput = (busy ? live?.input : null) ?? ctx?.input ?? null;
	const viewPct =
		viewInput !== null && limit !== null ? Math.round((viewInput / limit) * 1000) / 10 : null;
	const barPct = viewPct === null ? 0 : Math.min(100, Math.max(0, viewPct));
	// The read wearing the figures above — the settled label and the
	// popover render this, so a streamed step moves them with the ring.
	const shown: AppContextView | null =
		ctx === null
			? null
			: {
					...ctx,
					limit,
					input: viewInput,
					pct: viewPct,
				};
	// While a turn streams: a metered step's figures when they land,
	// the settled read standing in until then, and only when no read
	// exists at all — a fresh conversation, a mid-turn switch — the
	// turn itself by name. Never "no turns yet" over a live stream.
	const busyLabel =
		live?.input != null
			? limit !== null
				? `${contextCount(live.input)}/${contextCount(limit)} · ${viewPct}%`
				: `${contextCount(live.input)} tok`
			: shown !== null && shown.input !== null
				? contextLabel(shown)
				: "turn in flight";
	// The wire's cacheRead/input pair is the same numerator and
	// denominator the server reports for a settled turn — while one
	// runs, the freshest metered step's rate wins; a step whose split
	// the provider didn't report falls back to the settled figure.
	const liveHitRate =
		live != null && live.input !== null && live.input > 0 && live.cacheRead !== null
			? live.cacheRead / live.input
			: null;
	const hitRate = busy && liveHitRate !== null ? liveHitRate : (ctx?.cacheHitRate ?? null);
	// 85% is the ring's red line — the button and the popover's bar wear
	// the same state so every face of the gauge agrees.
	const hot = viewPct !== null && viewPct >= 85;
	// A failed read has no numbers to show and the popover won't open —
	// the label carries it on wide screens, the reddened ring on narrow.
	// The click becomes the retry, with the reason on the tooltip.
	const failedRead = failed && ctx === null;
	// The window itemization — a stacked strip plus receipt rows. The
	// tool-share row is a subset of history, so it stays out of the
	// strip's widths.
	const segs = ctx?.segments ?? null;
	const segBars = segs?.filter((s) => s.key !== "toolResults") ?? [];
	const segTotal = segBars.reduce((n, s) => n + s.tokens, 0);
	return (
		<span className="ctx-gauge" ref={gaugeRef}>
			<button
				type="button"
				ref={btnRef}
				className={failedRead ? "ctx-btn failed" : hot ? "ctx-btn hot" : "ctx-btn"}
				aria-label={
					failedRead
						? "Context window usage — read failed, activate to retry"
						: busy
							? `Context window: ${busyLabel}`
							: ctx === null
								? "Context window usage"
								: `Context window: ${contextLabel(shown)} — ${ctx.model}`
				}
				aria-expanded={open && ctx !== null}
				title={
					failedRead
						? `Context window usage — read failed: ${lastError ?? "unknown error"}`
						: busy
							? `Context window: ${busyLabel} — turn in flight`
							: ctx === null
								? "Context window usage"
								: `Context window: ${contextLabel(shown)} — ${ctx.model}`
				}
				onClick={() => {
					if (failedRead) {
						read();
						return;
					}
					setOpen((v) => !v);
				}}
			>
				<svg className="ctx-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<circle className="ctx-ring-track" cx="8" cy="8" r="6.5" />
					{viewPct !== null && viewPct > 0 && (
						<circle
							className={hot ? "ctx-ring-fill hot" : "ctx-ring-fill"}
							cx="8"
							cy="8"
							r="6.5"
							strokeDasharray={`${(barPct / 100) * 40.84} 40.84`}
							transform="rotate(-90 8 8)"
						/>
					)}
				</svg>
				<span className="ctx-label">
					{failedRead ? "ctx failed" : busy ? busyLabel : contextLabel(shown)}
				</span>
			</button>
			{open && shown !== null && (
				<div className="note-pick composer-pick ctx-pop">
					<div className="ctx-head">
						<span>Context window</span>
						<span className="mono">
							{shown.input === null || shown.limit === null
								? "—"
								: `${contextCount(shown.input)}/${contextCount(shown.limit)}`}
						</span>
					</div>
					<div className="ctx-hero">
						{shown.limit === null
							? shown.input === null
								? "—"
								: `${contextCount(shown.input)} tok`
							: shown.pct === null
								? "?"
								: `${shown.pct}%`}
					</div>
					<div
						className={shown.pct === null ? "ctx-bar bare" : hot ? "ctx-bar hot" : "ctx-bar"}
						aria-hidden="true"
					>
						<span style={{ width: `${barPct}%` }} />
					</div>
					{segs !== null && segBars.length > 0 && (
						<div className="ctx-segs">
							<div className="ctx-segbar" aria-hidden="true">
								{segBars.map((s) => (
									<span
										key={s.key}
										className={`seg-${s.key}`}
										style={{
											width: `${segTotal > 0 ? (s.tokens / segTotal) * 100 : 0}%`,
										}}
									/>
								))}
							</div>
							<dl className="ctx-rows ctx-seg-rows">
								{segs.map((s) => (
									<div key={s.key} className={s.key === "toolResults" ? "sub" : undefined}>
										<dt>{SEGMENT_LABELS[s.key] ?? s.key}</dt>
										<dd className="mono">
											{contextCount(s.tokens)} tok
											{s.key !== "toolResults" && segTotal > 0
												? ` · ${Math.round((s.tokens / segTotal) * 100)}%`
												: ""}
										</dd>
									</div>
								))}
							</dl>
							<p className="empty">estimated from serialized characters</p>
						</div>
					)}
					<dl className="ctx-rows">
						<div>
							<dt>Input</dt>
							<dd className="mono">
								{shown.input === null ? "—" : `${contextCount(shown.input)} tok`}
							</dd>
						</div>
						<div>
							<dt>Cache hit</dt>
							<dd className="mono">{contextRate(hitRate)}</dd>
						</div>
						<div>
							<dt>Avg cache hit</dt>
							<dd className="mono">{contextRate(shown.avgCacheHitRate)}</dd>
						</div>
					</dl>
					<p className="empty">
						{shown.model} · {shown.turns} {shown.turns === 1 ? "turn" : "turns"}
						{busy ? " · turn in flight" : ""}
						{shown.limit === null ? " · limit unknown" : ""}
					</p>
					<button
						type="button"
						className="ctx-act"
						disabled={compacting}
						onClick={() => {
							if (conversationId === undefined) return;
							const id = conversationId;
							const n = identity.current;
							setCompacting(true);
							setCompactNote(null);
							void compactConversation(token, id)
								.then((outcome) => {
									if (n !== identity.current) return;
									setCompactNote(
										outcome.compacted
											? `folded ${outcome.eventsCompacted} messages (~${Math.round(outcome.tokensBefore / 1000)}k tok) — kept the last ${outcome.tailEvents}`
											: `nothing to compact — ${outcome.reason}`,
									);
								})
								.catch((err: unknown) => {
									if (n === identity.current)
										setCompactNote(
											`compact failed: ${err instanceof Error ? err.message : String(err)}`,
										);
								})
								.finally(() => {
									if (n === identity.current) setCompacting(false);
								});
						}}
					>
						{compacting ? "Compacting…" : "Compact now"}
					</button>
					{compactNote !== null && (
						<p className="ctx-outcome" role="status">
							{compactNote}
						</p>
					)}
				</div>
			)}
		</span>
	);
}

// Always present — on an empty conversation too. The draft is local;
// staged attachments arrive from above so they outlive this instance.
// onSend's result says whether the send was accepted — `false` keeps
// everything the operator composed so a failed lazy create leaves a
// resendable draft.
export function Composer({
	token,
	conversationId,
	draftScope,
	busy,
	liveCtx,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	onSend,
	onStop,
	quote,
	focusSignal,
	draftRestore,
	onDraftRestored,
}: {
	token: string | null;
	conversationId?: string;
	// Durable-draft key — one per composer home: the conversation id,
	// the project id, "new" for the empty start state.
	draftScope: string;
	busy: boolean;
	// The in-flight turn's window occupancy, streamed over the chat
	// wire — the gauge's numbers while a turn runs.
	liveCtx?: AppLiveContext | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	onSend: (parts: UIMessage["parts"]) => void | boolean | Promise<boolean>;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
	// A select-to-quote request — `n` bumps per click, so even repeated
	// text appends again.
	quote?: { text: string; n: number } | null;
	// Bumped by the caller when the composer should grab focus (the
	// "New conversation" click) — covers the already-mounted case that
	// an autoFocus attribute can't.
	focusSignal?: number;
	draftRestore?: { parts: UIMessage["parts"] } | null;
	onDraftRestored?: () => void;
}) {
	// The draft is durable per scope: restored at mount, stored on every
	// change. No debounce and no close guard — a tab close at any
	// instant (the Ctrl+W habit this exists for) finds the last
	// keystroke already persisted, so closing costs nothing and needs no
	// confirm dialog. A record that can't be read surfaces as an error
	// line and the composer starts empty; the first write replaces it —
	// prose that fails the record shape has no reader, and freezing it
	// would brick crash recovery over bytes nothing can parse.
	let draftLoadFailure: string | null = null;
	const [draft, setDraft] = useState(() => {
		try {
			return loadComposerDraft(draftScope) ?? "";
		} catch (e) {
			draftLoadFailure = `A saved draft couldn't be read (${e instanceof Error ? e.message : String(e)}) — typing here replaces it.`;
			return "";
		}
	});
	const [draftError, setDraftError] = useState<string | null>(draftLoadFailure);
	// The mount run writes nothing: on restore it would rewrite the
	// value it just loaded, and after a corrupt load it would delete
	// the unreadable record before the operator ever sees why.
	const draftPersisted = useRef(false);
	useEffect(() => {
		if (!draftPersisted.current) {
			draftPersisted.current = true;
			return;
		}
		try {
			saveComposerDraft(draftScope, draft);
			setDraftError(null);
		} catch (e) {
			setDraftError(
				`Couldn't save the draft locally (${e instanceof Error ? e.message : String(e)}) — closing the tab loses it.`,
			);
		}
	}, [draft, draftScope]);
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const editedAfterSend = useRef(false);
	const [notePickerOpen, setNotePickerOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	// Outside-press dismissal — the popover and its opener are both
	// exempt, or pointerdown on the opener would close it before its
	// own click could toggle.
	const notePickRef = useRef<HTMLDivElement | null>(null);
	const noteBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!notePickerOpen) return;
		const onPointer = (e: Event) => {
			const t = e.target as Node | null;
			if (notePickRef.current?.contains(t) === true || noteBtnRef.current?.contains(t) === true)
				return;
			setNotePickerOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setNotePickerOpen(false);
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [notePickerOpen]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if ((focusSignal ?? 0) > 0) textareaRef.current?.focus();
	}, [focusSignal]);
	useEffect(() => {
		if (quote == null || quote.n === 0) return;
		editedAfterSend.current = true;
		setDraft((d) => appendQuote(d, quote.text));
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			// The new draft isn't in the DOM yet — park the cursor at its
			// end on the next frame.
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [quote]);
	// The parent scopes this payload to its originating composer. Never
	// replace text the operator wrote after the cancelled send.
	useEffect(() => {
		if (draftRestore == null) return;
		const text = draftRestore.parts
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n\n");
		if (!editedAfterSend.current) setDraft(text);
		const uploads: StagedUpload[] = [];
		const notes: StagedNote[] = [];
		const skills: StagedSkill[] = [];
		for (const p of draftRestore.parts) {
			if (p.type === "data-attachment") {
				const data = p.data as AttachmentRef & { speech?: boolean };
				uploads.push({
					key: crypto.randomUUID(),
					ref: data,
					...(data.speech === true ? { speech: true } : {}),
				});
			} else if (p.type === "data-note") {
				const data = p.data as { id: string; title: string };
				notes.push({ key: crypto.randomUUID(), id: data.id, title: data.title });
			} else if (p.type === "data-skill") {
				// The ref rides verbatim for the resend — the chip's display
				// name derives like SkillChip's: the catalog name, or the
				// staged <digest>/<name>/SKILL.md layout's parent directory.
				const data = p.data as StagedSkill["ref"];
				skills.push({
					key: crypto.randomUUID(),
					name:
						"name" in data ? data.name : (data.path.split("/").filter(Boolean).at(-2) ?? "unknown"),
					ref: data,
				});
			}
		}
		if (uploads.length > 0)
			setStaged((prev) => [
				...prev,
				...uploads.filter((u) => !prev.some((e) => e.ref.path === u.ref.path)),
			]);
		if (notes.length > 0)
			setStagedNotes((prev) => [...prev, ...notes.filter((n) => !prev.some((e) => e.id === n.id))]);
		if (skills.length > 0)
			// Dedup against the growing merged list, not just prev — a
			// repeat inside the payload is the same duplicate as a staged
			// one.
			setStagedSkills((prev) => {
				const merged = [...prev];
				for (const s of skills)
					if (!merged.some((e) => skillRefEquals(e.ref, s.ref))) merged.push(s);
				return merged;
			});
		onDraftRestored?.();
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [draftRestore]);
	// An entry leaves the staged list (sent or removed) — its preview
	// URL goes with it. A composer unmount revokes nothing: staged
	// entries outlive any one composer, and an undropped thumb dies
	// with the document itself.
	const dropEntry = (e: StagedUpload) => {
		if (e.thumb !== undefined) URL.revokeObjectURL(e.thumb);
	};
	const fileInput = useRef<HTMLInputElement>(null);
	// The mic's failure mode is silent by browser default (a denied
	// permission throws) — surface it like every other composer failure.
	const [micError, setMicError] = useState<"denied" | "unavailable" | null>(null);

	// Existing chats own their settings. The empty start screen edits only
	// the app's new-chat defaults; neither path changes Telegram.
	const [cfg, setCfg] = useState<AppConfigView | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configSaving, setConfigSaving] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const modelKnobRef = useRef<HTMLSpanElement | null>(null);
	const modelBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		let live = true;
		setCfg(null);
		setConfigError(null);
		setModelMenuOpen(false);
		setModelSheetOpen(false);
		const load =
			conversationId === undefined
				? getConfig(token)
				: getConversationConfig(token, conversationId);
		load.then(
			(c) => live && setCfg(c),
			(err: unknown) => live && setConfigError(String(err)),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);
	const setKnob = (patch: { model?: string; thinking?: string }) => {
		setConfigSaving(true);
		setConfigError(null);
		const save =
			conversationId === undefined
				? patchConfig(token, patch)
				: patchConversationConfig(token, conversationId, patch);
		void save
			.then(
				(c) => setCfg(c),
				(err: unknown) => setConfigError(String(err)),
			)
			.finally(() => setConfigSaving(false));
	};

	// Dismiss the model menu on any outside press or Escape — mirrors
	// the context gauge's popover; Escape hands focus back to the knob.
	useEffect(() => {
		if (!modelMenuOpen) return;
		const onPointer = (e: Event) => {
			if (modelKnobRef.current?.contains(e.target as Node | null) === true) return;
			setModelMenuOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setModelMenuOpen(false);
			modelBtnRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [modelMenuOpen]);

	// ref → catalog display name; the fallbacks are the ref's last path
	// segment, then the ref itself for single-segment ids.
	const modelNames = useMemo(() => {
		const names = new Map<string, string>();
		for (const group of cfg?.catalog ?? [])
			for (const m of group.models)
				if (m.name != null) names.set(`${group.provider}/${m.id}`, m.name);
		return names;
	}, [cfg?.catalog]);
	const friendly = (ref: string) => modelNames.get(ref) ?? ref.split("/").pop() ?? ref;

	// The star writes immediately — one POST, the response's list is
	// truth. A failure surfaces like every other knob error.
	const starModel = (ref: string, on: boolean) => {
		void toggleFavorite(token, ref, on).then(
			(res) => setCfg((c) => (c === null ? c : { ...c, favorites: res.favorites })),
			(err: unknown) => setConfigError(String(err)),
		);
	};

	const [memory, setMemory] = useState<AppConversationMemoryView | null>(null);
	const [memorySaving, setMemorySaving] = useState(false);
	const [memoryError, setMemoryError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setMemory(null);
		setMemoryError(null);
		if (conversationId === undefined) return;
		void getConversationMemory(token, conversationId).then(
			(view) => live && setMemory(view),
			(err: unknown) => live && setMemoryError(String(err)),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);
	const toggleMemory = () => {
		if (conversationId === undefined || memory === null) return;
		setMemorySaving(true);
		setMemoryError(null);
		void patchConversationMemory(token, conversationId, !memory.memoryExcluded)
			.then(
				(view) => setMemory(view),
				(err: unknown) => setMemoryError(String(err)),
			)
			.finally(() => setMemorySaving(false));
	};

	// Voice notes: hold-to-record is MediaRecorder + upload; the server
	// transcribes speech:true attachments at intake. Release sends —
	// the same shape Telegram voice notes take in this channel.
	const [recording, setRecording] = useState(false);
	const [recSec, setRecSec] = useState(0);
	const recorder = useRef<MediaRecorder | null>(null);
	const recCancel = useRef(false);
	useEffect(() => {
		if (!recording) return;
		const t = setInterval(() => setRecSec(Math.floor((Date.now() - recStart.current) / 1000)), 250);
		return () => clearInterval(t);
	}, [recording]);
	const recStart = useRef(0);
	// Leaving the view mid-recording must tear the capture down: the
	// composer's stop affordances unmount with it, so the unmount itself
	// stops the recorder — its onstop then releases the tracks and, with
	// recCancel set, skips the send. recDead covers the getUserMedia
	// window: a permission grant landing after unmount releases the
	// fresh tracks immediately instead of opening a mic nobody owns.
	const recDead = useRef(false);
	useEffect(() => {
		recDead.current = false;
		return () => {
			recDead.current = true;
			recCancel.current = true;
			const r = recorder.current;
			recorder.current = null;
			if (r !== null && r.state !== "inactive") r.stop();
		};
	}, []);
	// The recorder's onstop runs after render — read the live busy flag
	// through a ref, not the prop captured when recording started.
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const micSupported =
		typeof navigator !== "undefined" &&
		navigator.mediaDevices !== undefined &&
		typeof MediaRecorder !== "undefined";
	const startRecording = async () => {
		if (recording || !micSupported) return;
		setMicError(null);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (recDead.current) {
				// Unmounted while the permission prompt was up — release the
				// device we just received; nobody is recording into it.
				for (const t of stream.getTracks()) t.stop();
				return;
			}
			const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((m) =>
				MediaRecorder.isTypeSupported(m),
			);
			const r = new MediaRecorder(stream, mime === undefined ? undefined : { mimeType: mime });
			const chunks: Blob[] = [];
			r.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			r.onstop = () => {
				for (const t of stream.getTracks()) t.stop();
				recorder.current = null;
				setRecording(false);
				if (recCancel.current || chunks.length === 0) return;
				const type = r.mimeType || "audio/webm";
				const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
				const file = new File(chunks, `voice-note.${ext}`, { type });
				void (async () => {
					try {
						const { ref } = await uploadAttachment(token, file);
						// Release-sends, but not mid-turn — a second send while a
						// turn streams is the fork send()'s busy gate exists to
						// prevent. Stage the ref instead: the chip shows it, the
						// next send carries it with speech intact.
						if (busyRef.current) {
							setStaged((p) => [...p, { key: crypto.randomUUID(), ref, speech: true }]);
						} else {
							// A declined send (failed lazy create) re-stages the
							// note — the upload already landed server-side.
							void Promise.resolve(
								onSend([{ type: "data-attachment", data: { ...ref, speech: true } }]),
							).then((accepted) => {
								if (accepted === false)
									// Cancellation can restore this ref before onSend settles.
									setStaged((p) =>
										p.some((e) => e.ref.path === ref.path)
											? p
											: [...p, { key: crypto.randomUUID(), ref, speech: true }],
									);
							});
						}
					} catch {
						setStaged((p) => [
							...p,
							{
								key: crypto.randomUUID(),
								ref: { path: "", mediaType: file.type, filename: file.name, size: file.size },
								failed: true,
							},
						]);
					}
				})();
			};
			recCancel.current = false;
			recStart.current = Date.now();
			setRecSec(0);
			r.start(250);
			recorder.current = r;
			setRecording(true);
		} catch (err) {
			// Permission denied or no device — say so; every other composer
			// failure surfaces, and a button that silently does nothing
			// reads as broken.
			setMicError(
				err instanceof Error && err.name === "NotAllowedError" ? "denied" : "unavailable",
			);
		}
	};
	const stopRecording = (cancel: boolean) => {
		recCancel.current = cancel;
		recorder.current?.stop();
	};

	const pickFile = useCallback(
		async (file: File) => {
			const key = crypto.randomUUID();
			const thumb = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
			setStaged((p) => [
				...p,
				{
					key,
					ref: { path: "", mediaType: file.type, filename: file.name, size: file.size },
					uploading: true,
					...(thumb !== undefined ? { thumb } : {}),
				},
			]);
			try {
				const { ref } = await uploadAttachment(token, file);
				setStaged((p) =>
					p.map((e) =>
						e.key === key ? { key, ref, ...(e.thumb === undefined ? {} : { thumb: e.thumb }) } : e,
					),
				);
			} catch {
				setStaged((p) =>
					p.map((e) => (e.key === key ? { ...e, uploading: false, failed: true } : e)),
				);
			}
		},
		[token, setStaged],
	);

	// Drop target: the whole window. Unhandled file drops trigger the
	// browser default — navigating the PWA to the file and losing the
	// page — so preventDefault runs even when nothing gets staged.
	// Non-file drags keep their native handling.
	useEffect(() => {
		const isFile = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true;
		const over = (e: DragEvent) => {
			if (isFile(e)) e.preventDefault();
		};
		const drop = (e: DragEvent) => {
			if (!isFile(e)) return;
			e.preventDefault();
			for (const f of Array.from(e.dataTransfer?.files ?? [])) void pickFile(f);
		};
		window.addEventListener("dragover", over);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragover", over);
			window.removeEventListener("drop", drop);
		};
	}, [pickFile]);

	const send = () => {
		// A send while a turn runs steers it (onSend drops the stale
		// reader first) — but without a stop path there is no steer
		// lane, so a lazy create still refuses mid-flight: a second
		// send must not fork a second conversation.
		if ((busy && onStop === undefined) || configSaving || sendingRef.current) return;
		const text = draft.trim();
		const ready = staged.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0 && stagedNotes.length === 0 && stagedSkills.length === 0)
			return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready)
			parts.push({
				type: "data-attachment",
				data: e.speech === true ? { ...e.ref, speech: true } : e.ref,
			} as UIMessage["parts"][number]);
		// Intake expands the id into the authoritative snapshot; the
		// title rides along only so the just-sent chip isn't bare.
		for (const n of stagedNotes)
			parts.push({
				type: "data-note",
				data: { id: n.id, title: n.title },
			} as UIMessage["parts"][number]);
		// Explicit invocations ride their own part; the server injects
		// the body into the owning turn.
		for (const s of stagedSkills)
			parts.push({ type: "data-skill", data: s.ref } as UIMessage["parts"][number]);
		// Clear only once the send is accepted — a compose wiped before
		// a lazy-create failure leaves nothing to resend (blob URLs are
		// unrecoverable). Typing that lands mid-flight survives: only
		// the sent prefix comes off.
		sendingRef.current = true;
		setSendError(null);
		void Promise.resolve()
			.then(() => onSend(parts) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				// The accept continuation can outlive this composer — a lazy
				// create swaps the view before it runs, and an unmounted
				// composer's persist effect never fires. Write the post-send
				// remainder to storage directly, against the stored text.
				try {
					const stored = loadComposerDraft(draftScope) ?? "";
					saveComposerDraft(
						draftScope,
						stored === draft ? "" : stored.startsWith(draft) ? stored.slice(draft.length) : stored,
					);
				} catch {
					// Unreadable records stay put, and a mounted composer's
					// effect still reports its own save failures.
				}
				setDraft((d) => (d === draft ? "" : d.startsWith(draft) ? d.slice(draft.length) : d));
				// Entries that weren't sent — uploads still in flight, failed
				// chips — stay staged. Clearing them would drop files the
				// operator still sees in the composer.
				for (const e of ready) dropEntry(e);
				setStaged((p) => p.filter((e) => !ready.includes(e)));
				setStagedNotes((p) => p.filter((n) => !stagedNotes.includes(n)));
				setStagedSkills((p) => p.filter((s) => !stagedSkills.includes(s)));
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	return (
		<form
			className={recording ? "composer recording" : "composer"}
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
			// A paste carrying files stages them like the picker did; a
			// text-only clipboard falls through to the textarea's own paste.
			// Read items, not files — WebKit leaves files empty on image
			// paste and only populates items.
			onPaste={(e) => {
				const files = Array.from(e.clipboardData?.items ?? []).flatMap((i) =>
					i.kind === "file" ? (i.getAsFile() ?? []) : [],
				);
				if (files.length === 0) return;
				e.preventDefault();
				for (const f of files) void pickFile(f);
			}}
		>
			<input
				ref={fileInput}
				type="file"
				hidden
				multiple
				onChange={(e) => {
					for (const f of Array.from(e.target.files ?? [])) void pickFile(f);
					e.target.value = "";
				}}
			/>
			{configError !== null && (
				<div className="error" role="alert">
					Model settings failed: {configError}
				</div>
			)}
			{memoryError !== null && (
				<div className="error" role="alert">
					Memory setting failed: {memoryError}
				</div>
			)}
			{micError !== null && (
				<div className="error" role="alert">
					Microphone {micError} — check the browser's permission for this page.
				</div>
			)}
			{(staged.length > 0 || stagedNotes.length > 0 || stagedSkills.length > 0) && (
				<div className="composer-attachments">
					{staged.map((e, i) => (
						<span key={e.key} className={e.failed === true ? "attachment failed" : "attachment"}>
							{e.thumb !== undefined ? (
								<img className="attachment-thumb" src={e.thumb} alt="" />
							) : (
								<FileIcon />
							)}
							<span className="attachment-name">
								{e.uploading === true ? "↑ " : e.failed === true ? "✗ " : ""}
								{e.ref.filename}
							</span>
							<span className="attachment-size">{bytes(e.ref.size)}</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => {
									dropEntry(e);
									setStaged((p) => p.filter((_, j) => j !== i));
								}}
							>
								×
							</button>
						</span>
					))}
					{stagedNotes.map((n) => (
						<span key={n.key} className="attachment note-chip">
							<FileIcon />
							<span className="attachment-name">Note · {n.title}</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => setStagedNotes((p) => p.filter((e) => e.key !== n.key))}
							>
								×
							</button>
						</span>
					))}
					{stagedSkills.map((s) => (
						<span
							key={s.key}
							className="attachment note-chip"
							title={
								"url" in s.ref
									? `Temp skill from ${s.ref.url} — the fetched copy rides the next turn`
									: `Skill ${s.name} — its SKILL.md rides the next turn`
							}
						>
							<span aria-hidden="true">⚡</span>
							<span className="attachment-name">
								{"url" in s.ref ? "Temp skill · " : "Skill · "}
								{s.name}
							</span>
							<button
								type="button"
								aria-label="Remove"
								title="Remove"
								onClick={() => setStagedSkills((p) => p.filter((e) => e.key !== s.key))}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			{recording ? (
				<div className="rec-row">
					<span className="rec-dot" />
					<span className="rec-time">
						{Math.floor(recSec / 60)}:{String(recSec % 60).padStart(2, "0")}
					</span>
					<span className="rec-hint">recording — release sends</span>
					<button type="button" className="rec-cancel" onClick={() => stopRecording(true)}>
						cancel
					</button>
				</div>
			) : (
				<textarea
					ref={textareaRef}
					value={draft}
					rows={1}
					placeholder="Message goblin"
					aria-label="Message draft"
					onChange={(e) => {
						editedAfterSend.current = true;
						setDraft(e.target.value);
					}}
					onKeyDown={(e) => {
						// isComposing: Enter that confirms an IME candidate is
						// not a send.
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							send();
						}
					}}
				/>
			)}
			<div className="composer-bar">
				<button
					type="button"
					className="icon-btn"
					aria-label="Attach"
					title="Attach"
					onClick={() => fileInput.current?.click()}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						width="16"
						height="16"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
				<button
					type="button"
					ref={noteBtnRef}
					className="icon-btn"
					aria-label="Attach a note"
					aria-expanded={notePickerOpen}
					title="Attach a note"
					onClick={() => setNotePickerOpen((v) => !v)}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						width="16"
						height="16"
					>
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
						<polyline points="14 2 14 8 20 8" />
						<line x1="9" y1="13" x2="15" y2="13" />
						<line x1="9" y1="17" x2="13" y2="17" />
					</svg>
				</button>
				<button
					type="button"
					className="icon-btn"
					aria-label="Invoke a skill"
					title="Invoke a skill"
					onClick={() => setSkillPickerOpen(true)}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.75"
						strokeLinecap="round"
						strokeLinejoin="round"
						width="16"
						height="16"
					>
						<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
					</svg>
				</button>
				{micSupported && (
					<button
						type="button"
						className={recording ? "icon-btn rec-active" : "icon-btn"}
						aria-label={recording ? "Stop and send" : "Record a voice note"}
						title={recording ? "Stop and send" : "Record a voice note"}
						onClick={() => (recording ? stopRecording(false) : void startRecording())}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
							width="16"
							height="16"
						>
							<rect x="9" y="2" width="6" height="12" rx="3" />
							<path d="M5 10a7 7 0 0 0 14 0" />
							<line x1="12" y1="17" x2="12" y2="22" />
						</svg>
					</button>
				)}
				{memory !== null && (
					<button
						type="button"
						className="ctx-btn"
						aria-label={
							memory.memoryExcluded
								? "Enable memory for this conversation"
								: "Exclude this conversation from memory"
						}
						title={
							memory.projectMemory === "off"
								? "This project's memory is off"
								: memory.memoryExcluded
									? "Memory is excluded — click to include this conversation"
									: "Memory is included — click to exclude this conversation"
						}
						disabled={
							busy || memorySaving || (memory.projectMemory === "off" && memory.memoryExcluded)
						}
						onClick={toggleMemory}
					>
						memory {memory.memoryExcluded ? "off" : "on"}
					</button>
				)}
				{cfg !== null && (
					<>
						<span className="knob model-knob" ref={modelKnobRef}>
							<button
								ref={modelBtnRef}
								type="button"
								className="knob-btn"
								aria-label={
									conversationId === undefined ? "New app chat model" : "Conversation model"
								}
								title={cfg.model}
								aria-haspopup="menu"
								aria-expanded={modelMenuOpen}
								disabled={busy || configSaving}
								onClick={() => setModelMenuOpen((v) => !v)}
							>
								{friendly(cfg.model)}
							</button>
							{modelMenuOpen && (
								<div className="note-pick composer-pick model-pop" role="menu">
									<ul>
										{[...new Set([cfg.model, ...cfg.favorites])].map((ref) => (
											<li key={ref}>
												<button
													type="button"
													role="menuitemradio"
													aria-checked={ref === cfg.model}
													title={ref}
													onClick={() => {
														setModelMenuOpen(false);
														if (ref !== cfg.model) setKnob({ model: ref });
													}}
												>
													<span className="mi">
														<span>{friendly(ref)}</span>
														{friendly(ref) !== ref && <span className="mi-ref">{ref}</span>}
													</span>
													{ref === cfg.model && <span className="check">✓</span>}
												</button>
											</li>
										))}
										<li className="menu-div" aria-hidden="true" />
										<li>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setModelMenuOpen(false);
													setModelSheetOpen(true);
												}}
											>
												All models…
											</button>
										</li>
									</ul>
								</div>
							)}
						</span>
						<label
							className="knob"
							title={
								conversationId === undefined
									? "Default thinking level for new app chats"
									: "Thinking level for this conversation"
							}
						>
							<select
								aria-label={
									conversationId === undefined ? "New app chat thinking" : "Conversation thinking"
								}
								value={cfg.thinking}
								onChange={(e) => setKnob({ thinking: e.target.value })}
								disabled={busy || configSaving}
							>
								{[...new Set([cfg.thinking, ...cfg.thinkingLevels])].map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</select>
						</label>
						{modelSheetOpen && (
							<ModelPicker
								title={
									conversationId === undefined
										? "Default model for new app chats"
										: "Model for this conversation"
								}
								current={cfg.model}
								allowOff={false}
								favorites={cfg.favorites}
								catalog={cfg.catalog}
								provNames={cfg.catalog.map((g) => g.provider)}
								onPick={(ref) => {
									setModelSheetOpen(false);
									if (ref !== cfg.model) setKnob({ model: ref });
								}}
								onToggleFavorite={starModel}
								onClose={() => setModelSheetOpen(false)}
							/>
						)}
					</>
				)}
				<ContextGauge
					token={token}
					conversationId={conversationId}
					busy={busy}
					live={liveCtx}
					model={cfg?.model}
				/>
				{busy && onStop !== undefined && (
					// Stop means stop: ask the runtime to abort the turn, then
					// let go of this client's stream. History keeps what was written.
					<button type="button" className="stop-btn" aria-label="Stop" onClick={onStop}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
							<rect x="7" y="7" width="10" height="10" rx="2" />
						</svg>
					</button>
				)}
				<button
					type="submit"
					className="send-btn"
					aria-label="Send"
					title={busy && onStop !== undefined ? "Send — steers the running turn" : "Send"}
					disabled={
						(busy && onStop === undefined) ||
						configSaving ||
						recording ||
						(draft.trim() === "" &&
							staged.every((e) => e.failed === true || e.uploading === true) &&
							stagedNotes.length === 0 &&
							stagedSkills.length === 0)
					}
				>
					<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
						<path
							fillRule="evenodd"
							d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"
							clipRule="evenodd"
						/>
					</svg>
				</button>
			</div>
			{sendError !== null && (
				<p className="error" role="alert">
					{sendError}
				</p>
			)}
			{draftError !== null && (
				<p className="error" role="alert">
					{draftError}
				</p>
			)}
			{notePickerOpen && (
				<NotePicker
					pickRef={notePickRef}
					token={token}
					onPick={(n) =>
						setStagedNotes((p) =>
							p.some((e) => e.id === n.id)
								? p
								: [...p, { key: crypto.randomUUID(), id: n.id, title: n.title }],
						)
					}
					onClose={() => setNotePickerOpen(false)}
				/>
			)}
			{skillPickerOpen && (
				<SkillPickerSheet
					token={token}
					onClose={() => setSkillPickerOpen(false)}
					onStage={(picked) =>
						setStagedSkills((p) =>
							p.some((e) => skillRefEquals(e.ref, picked.ref))
								? p
								: [...p, { key: crypto.randomUUID(), name: picked.name, ref: picked.ref }],
						)
					}
				/>
			)}
		</form>
	);
}

// ---------- the chat ----------

// A finished turn pings the OS only when the window isn't looking —
// the notification carries the answer's first line. Permission is
// requested once, from the send path's user gesture.
function notifyDone(title: string, text: string) {
	if (document.visibilityState !== "hidden") return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	const body = text.replace(/\s+/g, " ").trim().slice(0, 140);
	try {
		new Notification(title === "" ? "goblin" : `goblin — ${title}`, { body });
	} catch {
		/* some browsers only allow notifications from a service worker */
	}
}
function askNotifyPermission() {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return;
	void Notification.requestPermission().catch(() => {});
}

// Union of the view and durable history by message id — the reconcile
// merge for an idle reconnect. History is the truth for finished
// messages; the view may additionally hold a live tail the store has
// not seen yet (a just-sent user message, the assistant mid-stream),
// and that tail must survive: the store's interleaving stands whole
// and the tail appends after it — nothing local is ever dropped.
export function mergeTranscript(current: UIMessage[], history: UIMessage[]): UIMessage[] {
	const currentIds = new Set(current.map((m) => m.id));
	const arrivals = history.filter((m) => !currentIds.has(m.id));
	// Nothing new durably — the view stands (a history that shrank or
	// reordered is an anomaly; the live view wins).
	if (arrivals.length === 0) return current;
	const historyIds = new Set(history.map((m) => m.id));
	if (current.every((m) => historyIds.has(m.id))) return history;
	// The store owns the interleaving of every message it holds — an
	// answer belongs between its question and the next one, not below
	// both. The view's contribution is only the messages the store
	// hasn't seen, appended after it as the tail.
	return [...history, ...current.filter((m) => !historyIds.has(m.id))];
}

export function ChatView({
	token,
	conversationId,
	title,
	seed,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	noteProjectId,
	onSeeded,
	onTurnDone,
	onOpenNote,
	onBranched,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	// The message an empty-state send parked while its conversation was
	// being created — delivered once, on mount.
	seed: UIMessage["parts"] | null;
	// The staged-upload list App owns — carried in so the conversation's
	// composer renders the same entries the empty state's did.
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	// Same lift as staged — note chips picked before the first send
	// carry into the new conversation's composer.
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	// Skill invocations staged before the first send carry the same way.
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	// The conversation's project — a note-card "New note" binds to it.
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	// Note chips + fenced note cards navigate to the note page in-app.
	onOpenNote?: ((id: string) => void) | undefined;
	// A branch opened a new conversation — the host refreshes and opens it.
	onBranched?: ((id: string) => void) | undefined;
}) {
	const [initial, setInitial] = useState<{
		messages: UIMessage[];
		ratings: AppRatedReply[];
		rateableMessageIds: string[];
	} | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		getMessages(token, conversationId).then(
			(r) =>
				live &&
				setInitial({
					messages: r.messages,
					ratings: r.ratings,
					rateableMessageIds: r.rateableMessageIds,
				}),
			(err) => live && setLoadError(err instanceof Error ? err.message : "history failed to load"),
		);
		return () => {
			live = false;
		};
	}, [token, conversationId]);

	if (loadError !== null) return <div className="error">History failed to load: {loadError}</div>;
	if (initial === null) return <div className="loading">…</div>;
	return (
		<Chat
			conversationId={conversationId}
			title={title}
			token={token}
			initial={initial.messages}
			initialRatings={initial.ratings}
			initialRateableIds={initial.rateableMessageIds}
			seed={seed}
			staged={staged}
			setStaged={setStaged}
			stagedNotes={stagedNotes}
			setStagedNotes={setStagedNotes}
			stagedSkills={stagedSkills}
			setStagedSkills={setStagedSkills}
			noteProjectId={noteProjectId}
			onSeeded={onSeeded}
			onTurnDone={onTurnDone}
			onOpenNote={onOpenNote}
			onBranched={onBranched}
		/>
	);
}

function Chat({
	token,
	conversationId,
	title,
	initial,
	initialRatings,
	initialRateableIds,
	seed,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	noteProjectId,
	onSeeded,
	onTurnDone,
	onOpenNote,
	onBranched,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	initial: UIMessage[];
	initialRatings: AppRatedReply[];
	initialRateableIds: string[];
	seed: UIMessage["parts"] | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	onOpenNote?: ((id: string) => void) | undefined;
	// A branch exists now — the host refreshes the rail and opens it.
	onBranched?: ((id: string) => void) | undefined;
}) {
	// The transport speaks this channel's contract: one user message per
	// POST, keyed by the app conversation id. A regenerate rides the
	// same endpoint as `retry` — no append, the stored user event
	// anchors the new answer. token null = trust mode — the server
	// wants no credential.
	//
	// A wrapper, not a bare DefaultChatTransport: the SDK exposes no
	// callback for "the resume found no live turn" (on 204 the status
	// never moves and the messages stand), so the transport is the one
	// seam that can see the idle answer. The ref is wired by the effect
	// below useChat — the reconnect's answer resolves after a network
	// round-trip, so it can never beat that effect's assignment.
	const idleReconnect = useRef<() => void>(() => {});
	const [ratings, setRatings] = useState<Record<string, AppRatedReply>>(() =>
		Object.fromEntries(initialRatings.map((r) => [r.messageId, r])),
	);
	const [ratingPending, setRatingPending] = useState<string | null>(null);
	const [ratingErrors, setRatingErrors] = useState<Record<string, string>>({});
	const [rateableIds, setRateableIds] = useState<ReadonlySet<string>>(
		() => new Set(initialRateableIds),
	);
	// Rewriting a prompt is a rewind: everything from that message onward
	// is dropped on the server before the edited text becomes the next
	// turn. The backup exists only for an edit that fails while the
	// transcript refresh cannot reach the server; in every other failure
	// the durable history reconciles the view.
	const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
	const editRestore = useRef<UIMessage[] | null>(null);
	// A branch is a copy in a new chat; the click opens it via the host's
	// navigation. Errors stay on the reply's action row.
	const [branchPending, setBranchPending] = useState<string | null>(null);
	const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
	const applyRatingSnapshot = (next: AppRatedReply[], nextIds: string[]) => {
		setRatings(Object.fromEntries(next.map((rating) => [rating.messageId, rating])));
		setRateableIds(new Set(nextIds));
	};
	const transport = useMemo<ChatTransport<UIMessage>>(() => {
		const base = new DefaultChatTransport({
			api: "/api/app/chat",
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
			// Resumable streams: on mount, useChat(resume) asks the
			// transport to reconnect to a live turn — the GET returns the
			// wire's replay + tail, or 204 when nothing is running and
			// history stands. The URL is ours, not the SDK's default
			// append, so the conversation id keeps the app channel's
			// shape.
			prepareReconnectToStreamRequest: ({ id }) => ({
				api: `/api/app/conversations/${encodeURIComponent(id.slice(4))}/stream`,
			}),
			prepareSendMessagesRequest: ({ trigger, messageId, messages, body }) => ({
				body:
					trigger === "regenerate-message"
						? { conversationId, retry: true }
						: {
								conversationId,
								message:
									trigger === "submit-message"
										? (messages.find((m) => m.id === messageId) ?? messages[messages.length - 1])
										: messages[messages.length - 1],
								// An edit rides the normal send: the message is the
								// replacement text, the id names the durable event
								// the server cuts at. Anything else is ignored.
								...(typeof body?.editMessageId === "string"
									? { editMessageId: body.editMessageId }
									: {}),
							},
			}),
		});
		return {
			sendMessages: (options) => base.sendMessages(options),
			reconnectToStream: async (options) => {
				const stream = await base.reconnectToStream(options);
				// null is the server's 204 — nothing is live, and the runtime
				// persists each reply before it retires the wire, so durable
				// history is already final. The mount-time snapshot may be
				// older than that; the view reconciles.
				if (stream === null) idleReconnect.current();
				return stream;
			},
		};
	}, [token, conversationId]);
	// The running turn's window occupancy — each model step pushes it over
	// the wire as a transient data-context part (never persisted). The
	// gauge shows it while busy; cleared when a new turn starts so a fresh
	// turn never wears the previous turn's last figure.
	const [liveCtx, setLiveCtx] = useState<AppLiveContext | null>(null);
	const { messages, sendMessage, regenerate, status, error, stop, setMessages, resumeStream } =
		useChat({
			id: conversationId,
			messages: initial,
			transport,
			// Reconnect to a live turn on mount: a reload mid-turn resumes the
			// in-flight reply instead of showing a finished-looking chat whose
			// next send would steer a ghost turn.
			resume: true,
			onData: (part) => {
				if (part.type !== "data-context") return;
				const d = (typeof part.data === "object" && part.data !== null ? part.data : {}) as Record<
					string,
					unknown
				>;
				const num = (v: unknown) => (typeof v === "number" ? v : null);
				setLiveCtx({ input: num(d.input), cacheRead: num(d.cacheRead) });
			},
			onFinish: ({ message, isAbort, isError }) => {
				// The edit's server-side answer is final now — a later
				// onError must not resurrect the pre-edit transcript. The
				// SDK fires this on errored turns too, so the done-bell
				// waits for a real finish and the re-sync covers both.
				editRestore.current = null;
				// An aborted reader (stop, or the drop before a steer) is not a
				// finished reply — the bell belongs to the real finish.
				if (!isAbort && !isError) notifyDone(title ?? "", messageText(message));
				onTurnDone();
				refreshTranscript();
			},
			onError: () => {
				// The durable transcript is the truth in every failure mode: a
				// refused request never reached the store (the tail stands
				// there), and a post-commit failure already deleted it — only
				// the server knows which, so reconcile from it. The pre-edit
				// backup covers a refresh that cannot get there.
				const backup = editRestore.current;
				editRestore.current = null;
				if (backup === null) return;
				refreshTranscript(() => setMessages(backup));
			},
		});
		const refreshTranscript = (onUnavailable?: () => void) => {
			void getMessages(token, conversationId).then(
				(r) => {
					setMessages((current) => mergeTranscript(current, r.messages));
					applyRatingSnapshot(r.ratings, r.rateableMessageIds);
				},
				() => onUnavailable?.(),
			);
		};
	// A failed /stop means the client dropped its stream but the turn
	// keeps running server-side and will write the reply the operator
	// asked to stop — that has to be visible, not swallowed.
	const [stopError, setStopError] = useState<string | null>(null);
	useEffect(() => {
		setRatings(Object.fromEntries(initialRatings.map((r) => [r.messageId, r])));
		setRatingPending(null);
		setRatingErrors({});
		setRateableIds(new Set(initialRateableIds));
	}, [initialRatings, initialRateableIds]);
	const rate = (messageId: string, rating: AppReplyRating) => {
		if (ratingPending !== null) return;
		setRatingPending(messageId);
		setRatingErrors((errors) => {
			const next = { ...errors };
			delete next[messageId];
			return next;
		});
		void rateReply(token, conversationId, messageId, rating)
			.then(
				(res) => setRatings((current) => ({ ...current, [messageId]: res.rating })),
				(err: unknown) =>
					setRatingErrors((errors) => ({
						...errors,
						[messageId]: err instanceof Error ? err.message : "rating failed",
					})),
			)
			.finally(() => setRatingPending(null));
	};

	// Reload-window reconciliation: a turn that completed between the
	// history snapshot and the idle reconnect is durably stored but
	// missing from the snapshot — re-read history once and merge. A new
	// turn that started meanwhile is accounted for by the merge (its
	// persisted user message arrives; a live local tail is never
	// dropped). A failed re-read leaves the snapshot standing.
	useEffect(() => {
		idleReconnect.current = () => {
			void getMessages(token, conversationId).then(
				(r) => {
					setMessages((current) => mergeTranscript(current, r.messages));
					setRatings(Object.fromEntries(r.ratings.map((rating) => [rating.messageId, rating])));
					setRateableIds(new Set(r.rateableMessageIds));
				},
				() => {},
			);
		};
		return () => {
			idleReconnect.current = () => {};
		};
	}, [token, conversationId, setMessages]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// The outline rail is a pointer/keyboard affordance — phones don't
	// hover, so it never mounts there (the stylesheet hides it too).
	const phone = usePhoneWidth();
	// Select-to-quote: each QuoteFab click bumps `n`; the Composer appends
	// the text as a blockquote.
	const [quote, setQuote] = useState<{ text: string; n: number }>({ text: "", n: 0 });
	// Follow-mode: the transcript auto-scrolls to the tail while the view
	// is pinned there; scrolling up unpins it, scrolling back (or sending)
	// re-pins. Streaming chunks ride the same effect — the tail follows
	// output only while the operator is already at the tail.
	const pinned = useRef(true);
	const busy = status === "submitted" || status === "streaming";

	// A mid-turn send steers or queues. Drop this client's reader first:
	// the new POST's stream replays the wire from sentence one onto the
	// same assistant message id — a handoff, not a second writer. The
	// await is load-bearing: the aborted reader's teardown flips status
	// back to "ready" a tick after stop() returns control, and a send
	// fired before it lands gets clobbered into a busy:false window —
	// no stop button, and the next send forks a second writer.
	const submit = async (message: Parameters<typeof sendMessage>[0]) => {
		pinned.current = true;
		setLiveCtx(null);
		if (busy) await stop();
		await sendMessage(message);
	};

	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
	}, [messages, busy]);

	// A seed arrives once (empty-state send → conversation created → this
	// view mounts with it). The ref guards re-runs; onSeeded clears the
	// parking slot so a remount can never re-deliver it.
	const seeded = useRef(false);
	useEffect(() => {
		if (seeded.current || seed === null || seed.length === 0) return;
		seeded.current = true;
		pinned.current = true;
		onSeeded();
		void sendMessage({ parts: seed });
	}, [seed, sendMessage, onSeeded]);

	// The retry affordance belongs to the newest answer — anything older
	// gets copy/read only.
	const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

	const beginEdit = (m: UIMessage) => {
		if (busy) return;
		setEditing({ id: m.id, draft: messageText(m) });
	};
	const cancelEdit = () => setEditing(null);
	const saveEdit = (m: UIMessage) => {
		if (busy || editing === null || editing.id !== m.id) return;
		const index = messages.findIndex((x) => x.id === m.id);
		if (index === -1) return;
		const draft = editing.draft;
		const parts = editedParts(m, draft);
		const tail = messages.length - index - 1;
		// A rewind is destructive by design. Say so when it is about to
		// drop real messages; the branch action is the way to keep them.
		if (
			tail > 0 &&
			!window.confirm(
				`Editing this message drops the ${tail} message${tail === 1 ? "" : "s"} after it. Branch first if you want to keep them. Continue?`,
			)
		) {
			return;
		}
		editRestore.current = messages;
		setEditing(null);
		pinned.current = true;
		setLiveCtx(null);
		setMessages(messages.slice(0, index));
		void sendMessage({ parts }, { body: { editMessageId: m.id } });
	};
	const branch = (m: UIMessage) => {
		if (busy || branchPending !== null) return;
		setBranchPending(m.id);
		setBranchErrors((errors) => {
			const next = { ...errors };
			delete next[m.id];
			return next;
		});
		branchConversation(token, conversationId, m.id)
			.then(
				(created) => onBranched?.(created.id),
				(err: unknown) =>
					setBranchErrors((errors) => ({
						...errors,
						[m.id]: err instanceof Error ? err.message : "branch failed",
					})),
			)
			.finally(() => setBranchPending(null));
	};

	return (
		<DocViewerProvider token={token} conversationId={conversationId}>
			<div className="chat">
				<QuoteFab root={scrollRef} onQuote={(text) => setQuote((q) => ({ text, n: q.n + 1 }))} />
				{/* The outline is a hover rail — a pointer affordance, so it does
				    not exist in a phone DOM at all. */}
				{phone ? null : <Outline messages={messages} scrollRef={scrollRef} />}
			<div
				className="transcript"
				ref={scrollRef}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
				}}
			>
				<div className="transcript-inner">
					{messages.length === 0 && <p className="empty">Say something.</p>}
					{messages.map((m) => {
						if (m.role === "user") {
							const isEditing = editing !== null && editing.id === m.id;
							return (
								<div key={m.id} className="msg user" data-outline-anchor={m.id}>
									{isEditing ? (
										<div className="msg-edit">
											<textarea
												value={editing.draft}
												rows={Math.min(10, Math.max(2, editing.draft.split("\n").length))}
												onChange={(e) => setEditing({ id: m.id, draft: e.target.value })}
												aria-label="Edit message"
												// biome-ignore lint/a11y/noAutofocus: opening the editor is the user's request
												autoFocus
											/>
											<div className="msg-edit-actions">
												<button type="button" onClick={cancelEdit}>
													cancel
												</button>
												<button
													type="button"
													className="primary"
													onClick={() => saveEdit(m)}
													disabled={
														editing.draft.trim() === "" && !m.parts.some((p) => p.type !== "text")
													}
												>
													save &amp; resend
												</button>
											</div>
										</div>
									) : (
										<>
											<MessageParts
												parts={m.parts}
												token={token}
												noteProjectId={noteProjectId}
												onOpenNote={onOpenNote}
												clipFences
											/>
											<UserActions message={m} disabled={busy} onEdit={() => beginEdit(m)} />
										</>
									)}
								</div>
							);
						}
						if (m.role === "system")
							return (
								<div key={m.id} className="msg system">
									<MessageParts
										parts={m.parts}
										token={token}
										noteProjectId={noteProjectId}
										messages={messages}
										onOpenNote={onOpenNote}
									/>
								</div>
							);
						const meta = turnMeta(m);
						return (
							<div key={m.id} className="msg assistant">
								<MessageParts
									parts={m.parts}
									token={token}
									noteProjectId={noteProjectId}
									busy={busy}
									streaming={status === "streaming" && m.id === lastAssistantId}
									messages={messages}
									onOpenNote={onOpenNote}
									onAction={(text) => void submit({ text })}
								/>
								<ActionBar
									message={m}
									isLastAssistant={m.id === lastAssistantId}
									busy={busy}
									onRetry={() => {
										setLiveCtx(null);
										void regenerate();
									}}
									token={token}
									rateable={rateableIds.has(m.id)}
									rating={ratings[m.id]?.rating ?? null}
									ratingPending={ratingPending === m.id}
									ratingError={ratingErrors[m.id] ?? null}
									onRate={(vote) => rate(m.id, vote)}
									onBranch={() => branch(m)}
									branchPending={branchPending === m.id}
									branchError={branchErrors[m.id] ?? null}
								/>
								{meta !== null && <MetaLine meta={meta} />}
							</div>
						);
					})}
					{busy && <div className="msg assistant pending shimmer">…</div>}
					{error !== undefined && <div className="error">The turn failed: {error.message}</div>}
					<InterruptedTurns
						key={conversationId}
						token={token}
						conversationId={conversationId}
						busy={busy}
						onResumed={async () => {
							onTurnDone();
							await resumeStream();
						}}
					/>
				</div>
			</div>
			{stopError !== null && (
				<div className="error" role="alert">
					Stop request failed — the turn keeps running server-side: {stopError}
				</div>
			)}
			<Composer
				token={token}
				conversationId={conversationId}
				draftScope={conversationId}
				busy={busy}
				liveCtx={liveCtx}
				staged={staged}
				setStaged={setStaged}
				stagedNotes={stagedNotes}
				setStagedNotes={setStagedNotes}
				stagedSkills={stagedSkills}
				setStagedSkills={setStagedSkills}
				quote={quote}
				onSend={(parts) => {
					askNotifyPermission();
					void submit({ parts });
				}}
				onStop={() => {
					setStopError(null);
					void stopConversation(token, conversationId).catch((err: unknown) =>
						setStopError(err instanceof Error ? err.message : "request failed"),
					);
					void stop();
				}}
			/>
			</div>
		</DocViewerProvider>
	);
}
