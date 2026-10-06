import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	isToolUIPart,
	type DynamicToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import {
	getConfig,
	getMessages,
	patchConfig,
	stopConversation,
	synthesize,
	uploadAttachment,
} from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { useCopy } from "./useCopy.ts";
import { ToolRun, partFailed, partRunning, partSummaryLine } from "./tools/mod.tsx";
import type { AttachmentRef } from "../../src/agent/attachments.ts";
import type { AppConfigView, TurnMetadata } from "../../src/http/app-wire.ts";

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
				{running ? "Working" : "Worked"} ·{" "}
				<span className="worked-sum">{lines.join("; ")}</span>
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

function formatSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

function AttachmentChip({ data }: { data: unknown }) {
	const ref = data as AttachmentRef;
	if (typeof ref?.filename !== "string") return null;
	return (
		<span className="attachment">
			<FileIcon />
			<span className="attachment-name">{ref.filename}</span>
			{typeof ref.size === "number" && <span className="attachment-size">{formatSize(ref.size)}</span>}
			{ref.speech === true && ref.transcript !== undefined && (
				<span className="attachment-transcript">“{ref.transcript}”</span>
			)}
		</span>
	);
}

export function MessageParts({ parts }: { parts: UIMessage["parts"] }) {
	const out: ReactNode[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (isToolUIPart(p)) {
			// Collapse a run of consecutive tool parts into one Worked row.
			const run: (ToolUIPart | DynamicToolUIPart)[] = [];
			let j = i;
			while (j < parts.length && isToolUIPart(parts[j]!)) {
				run.push(parts[j] as ToolUIPart | DynamicToolUIPart);
				j++;
			}
			out.push(<Worked key={`w${i}`} parts={run} />);
			i = j - 1;
			continue;
		}
		if (p.type === "text") out.push(<Markdown key={i} text={p.text} />);
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
		else if (p.type === "data-attachment") out.push(<AttachmentChip key={i} data={p.data} />);
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
	const audio = useRef<HTMLAudioElement | null>(null);
	const cancelled = useRef(false);
	useEffect(
		() => () => {
			cancelled.current = true;
			audio.current?.pause();
		},
		[],
	);
	const stop = useCallback(() => {
		cancelled.current = true;
		audio.current?.pause();
		audio.current = null;
		setState("idle");
	}, []);
	const play = useCallback(
		async (text: string) => {
			if (state === "playing" || state === "loading") {
				stop();
				return;
			}
			setState("loading");
			cancelled.current = false;
			try {
				const r = await synthesize(token, text);
				if (cancelled.current) return;
				setState("playing");
				for (const b64 of r.chunks) {
					if (cancelled.current) break;
					const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "audio/ogg" }));
					await new Promise<void>((resolve) => {
						const a = new Audio(url);
						audio.current = a;
						a.onended = () => resolve();
						a.onerror = () => resolve();
						void a.play().catch(() => resolve());
					});
					URL.revokeObjectURL(url);
				}
			} catch {
				/* speech unconfigured (503) or the network is down — quiet */
			}
			if (!cancelled.current) setState("idle");
		},
		[token, state, stop],
	);
	return { speech: state, play };
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
	const { copied, copy } = useCopy();
	const { speech, play } = useSpeech(token);
	return (
		<div className="msg-actions">
			<button type="button" onClick={() => copy(text)} aria-label="Copy">
				{copied ? "✓ copied" : "copy"}
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
			const x = Math.min(
				Math.max(rect.left + rect.width / 2, 48),
				window.innerWidth - 48,
			);
			setPos(
				rect.top > 44 ? { x, y: rect.top - 8, above: true } : { x, y: rect.bottom + 8, above: false },
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

// Always present — on an empty conversation too. Draft + staged
// attachments are local; onSend hands the assembled parts up, where the
// caller either streams them into the open conversation or creates one.
export function Composer({
	token,
	busy,
	onSend,
	onStop,
	quote,
}: {
	token: string | null;
	busy: boolean;
	onSend: (parts: UIMessage["parts"]) => void;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
	// A select-to-quote request — `n` bumps per click, so even repeated
	// text appends again.
	quote?: { text: string; n: number } | null;
}) {
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (quote == null || quote.n === 0) return;
		setDraft((d) => appendQuote(d, quote.text));
		const ta = textareaRef.current;
		if (ta !== null) {
			ta.focus();
			// The new draft isn't in the DOM yet — park the cursor at its
			// end on the next frame.
			requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
		}
	}, [quote]);
	const [pending, setPending] = useState<
		{ ref: AttachmentRef; uploading?: boolean; failed?: boolean }[]
	>([]);
	const fileInput = useRef<HTMLInputElement>(null);

	// Model + thinking pickers ride the same operator settings the mini
	// app owns — GET once, PATCH on change, the response is the truth.
	const [cfg, setCfg] = useState<AppConfigView | null>(null);
	useEffect(() => {
		let live = true;
		getConfig(token).then(
			(c) => live && setCfg(c),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [token]);
	const setKnob = (patch: { model?: string; thinking?: string }) => {
		void patchConfig(token, patch).then(
			(c) => setCfg(c),
			() => {},
		);
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
		const t = setInterval(
			() => setRecSec(Math.floor((Date.now() - recStart.current) / 1000)),
			250,
		);
		return () => clearInterval(t);
	}, [recording]);
	const recStart = useRef(0);
	const micSupported =
		typeof navigator !== "undefined" &&
		navigator.mediaDevices !== undefined &&
		typeof MediaRecorder !== "undefined";
	const startRecording = async () => {
		if (recording || !micSupported) return;
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
						onSend([{ type: "data-attachment", data: { ...ref, speech: true } }]);
					} catch {
						setPending((p) => [
							...p,
							{
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
		} catch {
			/* permission denied or no device — the button just does nothing */
		}
	};
	const stopRecording = (cancel: boolean) => {
		recCancel.current = cancel;
		recorder.current?.stop();
	};

	const pickFile = async (file: File) => {
		setPending((p) => [
			...p,
			{
				ref: { path: "", mediaType: file.type, filename: file.name, size: file.size },
				uploading: true,
			},
		]);
		try {
			const { ref } = await uploadAttachment(token, file);
			setPending((p) => p.map((e) => (e.uploading && e.ref.filename === file.name ? { ref } : e)));
		} catch {
			setPending((p) =>
				p.map((e) =>
					e.uploading && e.ref.filename === file.name
						? { ...e, uploading: false, failed: true }
						: e,
				),
			);
		}
	};

	const send = () => {
		// The button is disabled while busy; Enter and form submit are
		// not — gate here so a mid-turn send can't fork a second request
		// (or a second conversation from the empty state).
		if (busy) return;
		const text = draft.trim();
		const ready = pending.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0) return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready)
			parts.push({ type: "data-attachment", data: e.ref } as UIMessage["parts"][number]);
		setDraft("");
		setPending([]);
		onSend(parts);
	};

	const modelName = cfg === null ? null : (cfg.model.split("/").pop() ?? cfg.model);

	return (
		<form
			className={recording ? "composer recording" : "composer"}
			onSubmit={(e) => {
				e.preventDefault();
				send();
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
			{pending.length > 0 && (
				<div className="composer-attachments">
					{pending.map((e, i) => (
						<span key={i} className={e.failed === true ? "attachment failed" : "attachment"}>
							<FileIcon />
							<span className="attachment-name">
								{e.uploading === true ? "↑ " : e.failed === true ? "✗ " : ""}
								{e.ref.filename}
							</span>
							<span className="attachment-size">{formatSize(e.ref.size)}</span>
							<button
								type="button"
								aria-label="Remove"
								onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
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
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
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
				{micSupported && (
					<button
						type="button"
						className={recording ? "icon-btn rec-active" : "icon-btn"}
						aria-label={recording ? "Stop and send" : "Record a voice note"}
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
						<label className="knob" title="Model">
							<select
								value={cfg.model}
								onChange={(e) => setKnob({ model: e.target.value })}
								disabled={busy}
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
						<label className="knob" title="Thinking level">
							<select
								value={cfg.thinking}
								onChange={(e) => setKnob({ thinking: e.target.value })}
								disabled={busy}
							>
								{[...new Set([cfg.thinking, ...cfg.thinkingLevels])].map((l) => (
									<option key={l} value={l}>
										{l === "off" ? "think off" : `think ${l}`}
									</option>
								))}
							</select>
						</label>
					</>
				)}
				{busy && onStop !== undefined ? (
					// Stop means stop: ask the runtime to abort the turn, then
					// let go of this client's stream. History keeps what was written.
					<button type="button" className="stop-btn" aria-label="Stop" onClick={onStop}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
							<rect x="7" y="7" width="10" height="10" rx="2" />
						</svg>
					</button>
				) : (
					<button
						type="submit"
						className="send-btn"
						aria-label="Send"
						disabled={
							busy ||
							recording ||
							(draft.trim() === "" &&
								pending.every((e) => e.failed === true || e.uploading === true))
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
				)}
			</div>
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

export function ChatView({
	token,
	conversationId,
	title,
	seed,
	onSeeded,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	// The message an empty-state send parked while its conversation was
	// being created — delivered once, on mount.
	seed: UIMessage["parts"] | null;
	onSeeded: () => void;
	onTurnDone: () => void;
}) {
	const [initial, setInitial] = useState<UIMessage[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		getMessages(token, conversationId).then(
			(r) => live && setInitial(r.messages),
			(err) =>
				live &&
				setLoadError(err instanceof Error ? err.message : "history failed to load"),
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
			onSeeded={onSeeded}
			onTurnDone={onTurnDone}
		/>
	);
}

function Chat({
	token,
	conversationId,
	title,
	initial,
	seed,
	onSeeded,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	initial: UIMessage[];
	seed: UIMessage["parts"] | null;
	onSeeded: () => void;
	onTurnDone: () => void;
}) {
	// The transport speaks this channel's contract: one user message per
	// POST, keyed by the app conversation id (DESIGN.md, App channel).
	// A regenerate rides the same endpoint as `retry` — no append, the
	// stored user event anchors the new answer.
	// token null = trust mode — the server wants no credential.
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
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
											? (messages.find((m) => m.id === messageId) ??
												messages[messages.length - 1])
											: messages[messages.length - 1],
								},
				}),
			}),
		[token, conversationId],
	);
	const { messages, sendMessage, regenerate, status, error, stop } = useChat({
		id: conversationId,
		messages: initial,
		transport,
		// Reconnect to a live turn on mount: a reload mid-turn resumes the
		// in-flight reply instead of showing a finished-looking chat whose
		// next send would steer a ghost turn (#43).
		resume: true,
		onFinish: ({ message }) => {
			notifyDone(title ?? "", messageText(message));
			onTurnDone();
		},
	});

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
			<QuoteFab
				root={scrollRef}
				onQuote={(text) => setQuote((q) => ({ text, n: q.n + 1 }))}
			/>
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
									<MessageParts parts={m.parts} />
								</div>
							);
						const meta = turnMeta(m);
						return (
							<div key={m.id} className="msg assistant">
								<MessageParts parts={m.parts} />
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
					{error !== undefined && (
						<div className="error">The turn failed: {error.message}</div>
					)}
				</div>
			</div>
			<Composer
				token={token}
				busy={busy}
				quote={quote}
				onSend={(parts) => {
					pinned.current = true;
					askNotifyPermission();
					void sendMessage({ parts });
				}}
				onStop={() => {
					void stopConversation(token, conversationId).catch(() => {});
					void stop();
				}}
			/>
		</div>
	);
}
