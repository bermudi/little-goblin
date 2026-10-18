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
	type ToolUIPart,
	type UIMessage,
} from "ai";
import {
	compactConversation,
	getConfig,
	getContext,
	getConversationConfig,
	getMessages,
	listNotes,
	patchConfig,
	patchConversationConfig,
	stopConversation,
	synthesize,
	uploadAttachment,
} from "./api.ts";
import { InterruptedTurns } from "./InterruptedTurns.tsx";
import { Markdown } from "./markdown.tsx";
import { bytes } from "./opsShared.tsx";
import { useCopy } from "./useCopy.ts";
import { ToolRun, partFailed, partRunning, partSummaryLine } from "./tools/mod.tsx";
import { UiPart } from "./ui/UiPart.tsx";
import type { AttachmentRef } from "../../src/agent/attachments.ts";
import type {
	AppConfigView,
	AppContextView,
	AppNoteSummary,
	TurnMetadata,
} from "../../src/http/app-wire.ts";

// ---------- transcript rendering ----------

// Tool activity collapses into one expandable fold per run — the answer
// stays readable, the work stays inspectable. The fold opens itself
// while a call is live (streaming rows show skeletons) and stays open
// when a call failed; each row is its own fold inside, collapsed to
// tool name + one-line outcome, expanding to the tool's component. The
// collapsed summary carries the same one-liners — "search «q» · 5
// results" — so the outcome is legible without expanding.
function Worked({ parts }: { parts: (ToolUIPart | DynamicToolUIPart)[] }) {
	const running = parts.some(partRunning);
	const failures = parts.filter(partFailed).length;
	const lines = parts.map(partSummaryLine);
	return (
		<details className="worked" open={running || failures > 0}>
			<summary>
				{running ? "Working" : "Worked"} · <span className="worked-sum">{lines.join("; ")}</span>
				{failures > 0 && <span className="worked-fail">— {failures} failed</span>}
			</summary>
			<ul>
				{parts.map((p, i) => (
					<ToolRun key={p.toolCallId === "" ? i : p.toolCallId} part={p} />
				))}
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

// Read-back for a stored attachment — bearer header, blob, object URL.
// The name segment is the stored path's basename; the server confines
// reads to workspace/attachments/ regardless.
// Raster formats keep their type for inline rendering (<img> and a
// top-level image document run no script). Everything else — SVG
// carries script, and blob: URLs execute in this origin — is
// re-wrapped as octet-stream so opening it downloads, never executes.
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;
async function fetchAttachmentUrl(token: string | null, path: string): Promise<string> {
	const name = path.split("/").pop() ?? "";
	const res = await fetch(`/api/app/attachments/${encodeURIComponent(name)}`, {
		headers: token === null ? {} : { authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	const bytes = await res.blob();
	if (INLINE_IMAGE.test(bytes.type)) return URL.createObjectURL(bytes);
	return URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
}

function AttachmentChip({ data, token }: { data: unknown; token: string | null }) {
	const ref = (typeof data === "object" && data !== null ? data : {}) as AttachmentRef;
	const isImage = typeof ref.mediaType === "string" && ref.mediaType.startsWith("image/");
	const path = typeof ref.path === "string" ? ref.path : "";
	const [thumb, setThumb] = useState<string | null>(null);
	// A failed download is a boundary-safe error response: the fetch
	// rejects on HTTP (!ok) or network failure, and the chip shows the
	// message instead of swallowing it (a missing attachment or an
	// expired credential otherwise reads as a dead button).
	const [dlError, setDlError] = useState<string | null>(null);
	useEffect(() => {
		if (!isImage || path === "") return;
		let live = true;
		let url: string | null = null;
		void fetchAttachmentUrl(token, path)
			.then((u) => {
				if (live) {
					url = u;
					setThumb(u);
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
	}, [isImage, path, token]);
	if (typeof ref.filename !== "string") return null;
	if (isImage && thumb !== null) {
		return (
			<a className="attachment image" href={thumb} target="_blank" rel="noreferrer">
				<img src={thumb} alt={ref.filename} />
				<span className="attachment-name">{ref.filename}</span>
				{typeof ref.size === "number" && <span className="attachment-size">{bytes(ref.size)}</span>}
			</a>
		);
	}
	return (
		<span className="attachment">
			<FileIcon />
			{path !== "" ? (
				// Click downloads the stored file — fetched lazily so
				// non-image attachments cost nothing until asked. A
				// download, not window.open: the bytes aren't render-safe
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

// A stored note attachment — the server expanded it at intake, so the
// chip carries title+rev as of that message (design/projects.md →
// Attach). Clicking lands on the note's page.
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
		if (isToolUIPart(p)) {
			// ui parts render inline as the interface itself — they never
			// join a Worked run (design/app.md → Intelligent UI).
			if (getToolName(p) === "ui") {
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
			// Collapse a run of consecutive tool parts into one Worked row.
			const run: (ToolUIPart | DynamicToolUIPart)[] = [];
			let j = i;
			while (j < parts.length) {
				const q = parts[j]!;
				if (!isToolUIPart(q) || getToolName(q) === "ui") break;
				run.push(q);
				j++;
			}
			out.push(<Worked key={`w${i}`} parts={run} />);
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
		// Empty reasoning parts exist in history — providers that seal
		// chain-of-thought (encrypted, or an unmapped dialect) still emit the
		// part. A fold with nothing inside reads as a bug; skip it.
		else if (p.type === "reasoning" && p.text.trim() !== "")
			out.push(
				<details key={i} className="reasoning-fold">
					<summary>Thought</summary>
					<div className="reasoning">{p.text}</div>
				</details>,
			);
		else if (p.type === "data-attachment")
			out.push(<AttachmentChip key={i} data={p.data} token={token ?? null} />);
		else if (p.type === "data-note")
			out.push(<NoteChip key={i} data={p.data} onOpenNote={onOpenNote} />);
		else if (p.type === "file")
			out.push(
				<span key={i} className="attachment">
					<FileIcon />
					<span className="attachment-name">{p.filename ?? "attachment"}</span>
				</span>,
			);
		// step-start and other plumbing parts render as nothing.
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
	// natural (design/model.md). Repeat: the deterministic
	// detector; watchdog: system1 judged the loop stuck twice; context:
	// the window filled mid-turn.
	if (meta.forcedCompletion === "repeat") bits.push("loop detector — answer forced");
	if (meta.forcedCompletion === "watchdog") bits.push("loop watchdog — answer forced");
	if (meta.forcedCompletion === "context") bits.push("context nearly full — answer forced");
	bits.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
	const { input, output, cacheRead } = meta.usage;
	if (input !== null || output !== null) {
		let tok = `${input === null ? "?" : kfmt(input)}→${output === null ? "?" : kfmt(output)} tok`;
		if (cacheRead !== null && cacheRead > 0) tok += ` (${kfmt(cacheRead)} cached)`;
		bits.push(tok);
	}
	return <div className="msg-meta">{bits.join(" · ")}</div>;
}

// Read-aloud: fetch the speech chunks once, then toggle play/stop.
// Ogg/opus arrives base64'd — the Audio element owns the sequence.
function useSpeech(token: string | null) {
	const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
	// A silent catch made read failures invisible — the button looked
	// dead. The API's error string (e.g. "speech is unavailable") is
	// shown next to the button until the next attempt.
	const [err, setErr] = useState<string | null>(null);
	const audio = useRef<HTMLAudioElement | null>(null);
	const cancelled = useRef(false);
	// pause() settles no event — without this a stopped chunk's promise
	// hangs forever, leaking the loop's frame and that chunk's object
	// URL. stop resolves it as "played"; the cancelled flag ends the
	// loop before the failure branch can run.
	const releaseChunk = useRef<(() => void) | null>(null);
	const cancel = useCallback(() => {
		cancelled.current = true;
		releaseChunk.current?.();
		releaseChunk.current = null;
		audio.current?.pause();
		audio.current = null;
	}, []);
	useEffect(() => cancel, [cancel]);
	const stop = useCallback(() => {
		cancel();
		setState("idle");
	}, [cancel]);
	const play = useCallback(
		async (text: string) => {
			if (state === "playing" || state === "loading") {
				stop();
				return;
			}
			setState("loading");
			setErr(null);
			cancelled.current = false;
			try {
				const r = await synthesize(token, text);
				if (cancelled.current) return;
				setState("playing");
				let played = true;
				for (const b64 of r.chunks) {
					if (cancelled.current) break;
					const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const url = URL.createObjectURL(
						new Blob([bytes.buffer as ArrayBuffer], { type: "audio/ogg" }),
					);
					played = await new Promise<boolean>((resolve) => {
						const a = new Audio(url);
						audio.current = a;
						releaseChunk.current = () => resolve(true);
						a.onended = () => resolve(true);
						// Decode/playback failures are per-browser, not
						// per-chunk — one failure means the rest will too.
						a.onerror = () => resolve(false);
						void a.play().catch(() => resolve(false));
					});
					URL.revokeObjectURL(url);
					if (!played) break;
				}
				if (!played) setErr("playback failed — this browser may not support ogg audio");
			} catch (e) {
				setErr(e instanceof Error ? e.message : "speech failed");
			}
			if (!cancelled.current) setState("idle");
		},
		[token, state, stop],
	);
	return { speech: state, play, err };
}

function ActionBar({
	message,
	isLastAssistant,
	busy,
	onRetry,
	token,
}: {
	message: UIMessage;
	isLastAssistant: boolean;
	busy: boolean;
	onRetry: () => void;
	token: string | null;
}) {
	const text = messageText(message);
	const { copied, failed, copy } = useCopy();
	const { speech, play, err: speechErr } = useSpeech(token);
	return (
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
					onClick={() => void play(text)}
					aria-label="Read aloud"
					disabled={speech === "loading"}
				>
					{speech === "playing" ? "■ stop" : speech === "loading" ? "…" : "▶ read"}
				</button>
			)}
			{speechErr !== null && <span className="msg-err">{speechErr}</span>}
			{isLastAssistant && !busy && (
				<button type="button" onClick={onRetry} aria-label="Retry">
					↻ retry
				</button>
			)}
		</div>
	);
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

// One staged attachment — an entry in the composer's chip row. The
// list is owned above the composer (App), not inside it: the empty
// state's composer unmounts when its first send creates the
// conversation, and entries still uploading — or failed chips the
// operator can see — must carry across; an upload resolving after
// that unmount writes into the lifted list, not the discarded
// component (#118).
//
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
// intake (design/projects.md → Attach). Lifted beside `staged` for the
// same #118 reason: chips must outlive the empty-state composer.
export interface StagedNote {
	key: string;
	id: string;
	title: string;
}

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
}: {
	token: string | null;
	conversationId: string | undefined;
	busy: boolean;
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, conversationId, busy]);
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
	const barPct =
		ctx?.pct === null || ctx?.pct === undefined ? 0 : Math.min(100, Math.max(0, ctx.pct));
	// 85% is the ring's red line — the button and the popover's bar wear
	// the same state so every face of the gauge agrees.
	const hot = barPct >= 85;
	// A failed read has no numbers to show and the popover won't open —
	// the label carries it on wide screens, the reddened ring on narrow.
	// The click becomes the retry, with the reason on the tooltip.
	const failedRead = failed && ctx === null;
	return (
		<span className="ctx-gauge" ref={gaugeRef}>
			<button
				type="button"
				ref={btnRef}
				className={failedRead ? "ctx-btn failed" : hot ? "ctx-btn hot" : "ctx-btn"}
				aria-label={
					failedRead
						? "Context window usage — read failed, activate to retry"
						: ctx === null
							? "Context window usage"
							: `Context window: ${contextLabel(ctx)} — ${ctx.model}`
				}
				aria-expanded={open && ctx !== null}
				title={
					failedRead
						? `Context window usage — read failed: ${lastError ?? "unknown error"}`
						: ctx === null
							? "Context window usage"
							: `Context window: ${contextLabel(ctx)} — ${ctx.model}`
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
					{barPct > 0 && (
						<circle
							className={barPct >= 85 ? "ctx-ring-fill hot" : "ctx-ring-fill"}
							cx="8"
							cy="8"
							r="6.5"
							strokeDasharray={`${(barPct / 100) * 40.84} 40.84`}
							transform="rotate(-90 8 8)"
						/>
					)}
				</svg>
				<span className="ctx-label">{failedRead ? "ctx failed" : contextLabel(ctx)}</span>
			</button>
			{open && ctx !== null && (
				<div className="note-pick composer-pick ctx-pop">
					<div className="ctx-head">
						<span>Context window</span>
						<span className="mono">
							{ctx.input === null || ctx.limit === null
								? "—"
								: `${contextCount(ctx.input)}/${contextCount(ctx.limit)}`}
						</span>
					</div>
					{/* The hero — utilization is the one number the popover
						exists for; everything else on this panel whispers. */}
					<div className="ctx-hero">
						{ctx.limit === null
							? ctx.input === null
								? "—"
								: `${contextCount(ctx.input)} tok`
							: ctx.pct === null
								? "?"
								: `${ctx.pct}%`}
					</div>
					<div
						className={ctx?.pct == null ? "ctx-bar bare" : hot ? "ctx-bar hot" : "ctx-bar"}
						aria-hidden="true"
					>
						<span style={{ width: `${barPct}%` }} />
					</div>
					<dl className="ctx-rows">
						<div>
							<dt>Input</dt>
							<dd className="mono">
								{ctx.input === null ? "—" : `${contextCount(ctx.input)} tok`}
							</dd>
						</div>
						<div>
							<dt>Cache hit</dt>
							<dd className="mono">{contextRate(ctx.cacheHitRate)}</dd>
						</div>
						<div>
							<dt>Avg cache hit</dt>
							<dd className="mono">{contextRate(ctx.avgCacheHitRate)}</dd>
						</div>
					</dl>
					<p className="empty">
						{ctx.model} · {ctx.turns} {ctx.turns === 1 ? "turn" : "turns"}
						{ctx.limit === null ? " · limit unknown" : ""}
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
// staged attachments arrive from above so they outlive this instance
// (#118). onSend hands the assembled parts up, where the caller either
// streams them into the open conversation or creates one; its result
// says whether the send was accepted — `false` keeps everything the
// operator composed so a failed lazy create leaves a resendable draft
// instead of an empty composer and a shrug.
export function Composer({
	token,
	conversationId,
	busy,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	onSend,
	onStop,
	quote,
	focusSignal,
	draftRestore,
	onDraftRestored,
}: {
	token: string | null;
	conversationId?: string;
	busy: boolean;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
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
	const [draft, setDraft] = useState("");
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const editedAfterSend = useRef(false);
	const [notePickerOpen, setNotePickerOpen] = useState(false);
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
			}
		}
		if (uploads.length > 0)
			setStaged((prev) => [
				...prev,
				...uploads.filter((u) => !prev.some((e) => e.ref.path === u.ref.path)),
			]);
		if (notes.length > 0)
			setStagedNotes((prev) => [...prev, ...notes.filter((n) => !prev.some((e) => e.id === n.id))]);
		onDraftRestored?.();
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [draftRestore]);
	// An entry leaves the staged list (sent or removed) — its preview
	// URL goes with it. A composer unmount revokes nothing: staged
	// entries outlive any one composer (#118), and an undropped thumb
	// dies with the document itself.
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
	useEffect(() => {
		let live = true;
		setCfg(null);
		setConfigError(null);
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
	// Non-file drags (selected text into the textarea, links) keep
	// their native handling.
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
		// Enter, form submit, and the button all funnel here. A send
		// while a turn runs steers it (DESIGN.md → Turn; onSend drops
		// the stale reader first) — but without a stop path there is no
		// steer lane, so a lazy create still refuses mid-flight: a second
		// send must not fork a second conversation.
		if ((busy && onStop === undefined) || configSaving || sendingRef.current) return;
		const text = draft.trim();
		const ready = staged.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0 && stagedNotes.length === 0) return;
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
		// Clear only once the send is accepted — the lazy-create path can
		// fail after this point, and a compose wiped before that failure
		// leaves nothing to resend (blob URLs are unrecoverable). Typing
		// that lands mid-flight survives: only the sent prefix comes off.
		sendingRef.current = true;
		setSendError(null);
		void Promise.resolve()
			.then(() => onSend(parts) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				setDraft((d) => (d === draft ? "" : d.startsWith(draft) ? d.slice(draft.length) : d));
				// Entries that weren't sent — uploads still in flight, failed
				// chips — stay staged. Clearing them would drop files the
				// operator still sees in the composer.
				for (const e of ready) dropEntry(e);
				setStaged((p) => p.filter((e) => !ready.includes(e)));
				setStagedNotes((p) => p.filter((n) => !stagedNotes.includes(n)));
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	const modelName = cfg === null ? null : (cfg.model.split("/").pop() ?? cfg.model);

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
			{micError !== null && (
				<div className="error" role="alert">
					Microphone {micError} — check the browser's permission for this page.
				</div>
			)}
			{(staged.length > 0 || stagedNotes.length > 0) && (
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
				{cfg !== null && (
					<>
						<label
							className="knob"
							title={
								conversationId === undefined
									? "Default model for new app chats"
									: "Model for this conversation"
							}
						>
							<select
								aria-label={
									conversationId === undefined ? "New app chat model" : "Conversation model"
								}
								value={cfg.model}
								onChange={(e) => setKnob({ model: e.target.value })}
								disabled={busy || configSaving}
							>
								{cfg.favorites.length === 0 ? (
									<option value={cfg.model}>{modelName}</option>
								) : (
									[...new Set([cfg.model, ...cfg.favorites])].map((m) => (
										<option key={m} value={m}>
											{m.split("/").pop()}
										</option>
									))
								)}
							</select>
						</label>
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
					</>
				)}
				<ContextGauge token={token} conversationId={conversationId} busy={busy} />
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
							stagedNotes.length === 0)
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
// merge for an idle reconnect (#79). History is the truth for finished
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
	// No live tail: the store's order is the whole truth.
	if (current.every((m) => historyIds.has(m.id))) return history;
	// The store owns the interleaving of every message it holds — an
	// answer belongs between its question and the next one, not below
	// both (#117). The view's contribution is only the messages the
	// store hasn't seen, appended after it as the tail.
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
	noteProjectId,
	onSeeded,
	onTurnDone,
	onOpenNote,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	// The message an empty-state send parked while its conversation was
	// being created — delivered once, on mount.
	seed: UIMessage["parts"] | null;
	// The staged-upload list App owns — carried in so the conversation's
	// composer renders the same entries the empty state's did (#118).
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	// Same lift as staged — note chips picked before the first send
	// carry into the new conversation's composer.
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	// The conversation's project — a note-card "New note" binds to it.
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	// Note chips + fenced note cards navigate to the note page in-app.
	onOpenNote?: ((id: string) => void) | undefined;
}) {
	const [initial, setInitial] = useState<UIMessage[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		getMessages(token, conversationId).then(
			(r) => live && setInitial(r.messages),
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
			initial={initial}
			seed={seed}
			staged={staged}
			setStaged={setStaged}
			stagedNotes={stagedNotes}
			setStagedNotes={setStagedNotes}
			noteProjectId={noteProjectId}
			onSeeded={onSeeded}
			onTurnDone={onTurnDone}
			onOpenNote={onOpenNote}
		/>
	);
}

function Chat({
	token,
	conversationId,
	title,
	initial,
	seed,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	noteProjectId,
	onSeeded,
	onTurnDone,
	onOpenNote,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	initial: UIMessage[];
	seed: UIMessage["parts"] | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	noteProjectId?: string | null | undefined;
	onSeeded: () => void;
	onTurnDone: () => void;
	onOpenNote?: ((id: string) => void) | undefined;
}) {
	// The transport speaks this channel's contract: one user message per
	// POST, keyed by the app conversation id (DESIGN.md, App channel).
	// A regenerate rides the same endpoint as `retry` — no append, the
	// stored user event anchors the new answer.
	// token null = trust mode — the server wants no credential.
	//
	// It is a wrapper, not a bare DefaultChatTransport: the SDK exposes
	// no callback for "the resume found no live turn" (on 204 the status
	// never moves and the messages stand), so the transport is the one
	// seam that can see the idle answer. The ref is wired by the effect
	// below useChat — the reconnect's answer resolves after a network
	// round-trip, so it can never beat that effect's assignment.
	const idleReconnect = useRef<() => void>(() => {});
	const transport = useMemo<ChatTransport<UIMessage>>(() => {
		const base = new DefaultChatTransport({
			api: "/api/app/chat",
			headers: token === null ? {} : { authorization: `Bearer ${token}` },
			// Resumable streams (design/app.md → Streaming members): on
			// mount, useChat(resume) asks the transport to reconnect to a
			// live turn — the GET returns the wire's replay + tail, or 204
			// when nothing is running and history stands. The URL is
			// ours, not the SDK's default append, so the conversation id
			// keeps the app channel's shape.
			prepareReconnectToStreamRequest: ({ id }) => ({
				api: `/api/app/conversations/${encodeURIComponent(id.slice(4))}/stream`,
			}),
			prepareSendMessagesRequest: ({ trigger, messageId, messages }) => ({
				body:
					trigger === "regenerate-message"
						? { conversationId, retry: true }
						: {
								conversationId,
								message:
									trigger === "submit-message"
										? (messages.find((m) => m.id === messageId) ?? messages[messages.length - 1])
										: messages[messages.length - 1],
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
				// older than that (#79); the view reconciles.
				if (stream === null) idleReconnect.current();
				return stream;
			},
		};
	}, [token, conversationId]);
	const { messages, sendMessage, regenerate, status, error, stop, setMessages, resumeStream } =
		useChat({
			id: conversationId,
			messages: initial,
			transport,
			// Reconnect to a live turn on mount: a reload mid-turn resumes the
			// in-flight reply instead of showing a finished-looking chat whose
			// next send would steer a ghost turn (#43).
			resume: true,
			onFinish: ({ message, isAbort }) => {
				// An aborted reader (stop, or the drop before a steer) is not a
				// finished reply — the bell belongs to the real finish.
				if (!isAbort) notifyDone(title ?? "", messageText(message));
				onTurnDone();
			},
		});
	// A failed /stop means the client dropped its stream but the turn
	// keeps running server-side and will write the reply the operator
	// asked to stop — that has to be visible, not swallowed.
	const [stopError, setStopError] = useState<string | null>(null);

	// Reload-window reconciliation (#79): a turn that completed between
	// the history snapshot and the idle reconnect is durably stored but
	// missing from the snapshot — re-read history once and merge. A new
	// turn that started meanwhile is accounted for by the merge (its
	// persisted user message arrives; a live local tail is never
	// dropped). A failed re-read leaves the snapshot standing: the next
	// reload recovers, exactly the pre-fix behavior.
	useEffect(() => {
		idleReconnect.current = () => {
			void getMessages(token, conversationId).then(
				(r) => setMessages((current) => mergeTranscript(current, r.messages)),
				() => {},
			);
		};
		return () => {
			idleReconnect.current = () => {};
		};
	}, [token, conversationId, setMessages]);

	const scrollRef = useRef<HTMLDivElement>(null);
	// Select-to-quote: each QuoteFab click bumps `n`; the Composer appends
	// the text as a blockquote.
	const [quote, setQuote] = useState<{ text: string; n: number }>({ text: "", n: 0 });
	// Follow-mode: the transcript auto-scrolls to the tail while the view
	// is pinned there; scrolling up unpins it, scrolling back (or sending)
	// re-pins. Streaming chunks ride the same effect — the tail follows
	// output only while the operator is already at the tail.
	const pinned = useRef(true);
	const busy = status === "submitted" || status === "streaming";

	// A mid-turn send steers or queues (DESIGN.md → Turn — the app chat
	// POST rides the Telegram lane). Drop this client's reader first:
	// the new POST's stream replays the wire from sentence one onto the
	// same assistant message id — a handoff, not a second writer. The
	// await is load-bearing: the aborted reader's teardown flips status
	// back to "ready" a tick after stop() returns control, and a send
	// fired before it lands gets clobbered into a busy:false window —
	// no stop button, and the next send forks a second writer.
	const submit = async (message: Parameters<typeof sendMessage>[0]) => {
		pinned.current = true;
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

	return (
		<div className="chat">
			<QuoteFab root={scrollRef} onQuote={(text) => setQuote((q) => ({ text, n: q.n + 1 }))} />
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
						if (m.role === "user")
							return (
								<div key={m.id} className="msg user">
									<MessageParts
										parts={m.parts}
										token={token}
										noteProjectId={noteProjectId}
										onOpenNote={onOpenNote}
										clipFences
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
									onRetry={() => void regenerate()}
									token={token}
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
				busy={busy}
				staged={staged}
				setStaged={setStaged}
				stagedNotes={stagedNotes}
				setStagedNotes={setStagedNotes}
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
	);
}
