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
	isToolUIPart,
	type ChatTransport,
	type DynamicToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import {
	getConfig,
	getConversationConfig,
	getMessages,
	patchConfig,
	patchConversationConfig,
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
	useEffect(() => {
		if (!isImage || path === "") return;
		let live = true;
		let url: string | null = null;
		void fetchAttachmentUrl(token, path)
			.then((u) => {
				url = u;
				if (live) setThumb(u);
			})
			.catch(() => {});
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
				{typeof ref.size === "number" && (
					<span className="attachment-size">{formatSize(ref.size)}</span>
				)}
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
						void fetchAttachmentUrl(token, path).then(
							(u) => {
								const a = document.createElement("a");
								a.href = u;
								a.download = ref.filename;
								a.click();
								URL.revokeObjectURL(u);
							},
							() => {},
						);
					}}
				>
					{ref.filename}
				</button>
			) : (
				<span className="attachment-name">{ref.filename}</span>
			)}
			{typeof ref.size === "number" && (
				<span className="attachment-size">{formatSize(ref.size)}</span>
			)}
			{ref.speech === true && ref.transcript !== undefined && (
				<span className="attachment-transcript">“{ref.transcript}”</span>
			)}
		</span>
	);
}

export function MessageParts({
	parts,
	token,
}: {
	parts: UIMessage["parts"];
	token?: string | null;
}) {
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
		else if (p.type === "data-attachment")
			out.push(<AttachmentChip key={i} data={p.data} token={token ?? null} />);
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
	// natural (design/model.md, 2026-10-07). Repeat: the deterministic
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
			setErr(null);
			cancelled.current = false;
			try {
				const r = await synthesize(token, text);
				if (cancelled.current) return;
				setState("playing");
				for (const b64 of r.chunks) {
					if (cancelled.current) break;
					const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const url = URL.createObjectURL(
						new Blob([bytes.buffer as ArrayBuffer], { type: "audio/ogg" }),
					);
					await new Promise<void>((resolve) => {
						const a = new Audio(url);
						audio.current = a;
						a.onended = () => resolve();
						a.onerror = () => resolve();
						void a.play().catch(() => resolve());
					});
					URL.revokeObjectURL(url);
				}
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
	const { copied, copy } = useCopy();
	const { speech, play, err: speechErr } = useSpeech(token);
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

// Always present — on an empty conversation too. The draft is local;
// staged attachments arrive from above so they outlive this instance
// (#118). onSend hands the assembled parts up, where the caller either
// streams them into the open conversation or creates one.
export function Composer({
	token,
	conversationId,
	busy,
	staged,
	setStaged,
	onSend,
	onStop,
	quote,
	focusSignal,
}: {
	token: string | null;
	conversationId?: string;
	busy: boolean;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	onSend: (parts: UIMessage["parts"]) => void;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
	// A select-to-quote request — `n` bumps per click, so even repeated
	// text appends again.
	quote?: { text: string; n: number } | null;
	// Bumped by the caller when the composer should grab focus (the
	// "New conversation" click) — covers the already-mounted case that
	// an autoFocus attribute can't.
	focusSignal?: number;
}) {
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if ((focusSignal ?? 0) > 0) textareaRef.current?.focus();
	}, [focusSignal]);
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
	// An entry leaves the staged list (sent or removed) — its preview
	// URL goes with it. A composer unmount revokes nothing: staged
	// entries outlive any one composer (#118), and an undropped thumb
	// dies with the document itself.
	const dropEntry = (e: StagedUpload) => {
		if (e.thumb !== undefined) URL.revokeObjectURL(e.thumb);
	};
	const fileInput = useRef<HTMLInputElement>(null);

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
							onSend([{ type: "data-attachment", data: { ...ref, speech: true } }]);
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
		} catch {
			/* permission denied or no device — the button just does nothing */
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
		// The button is disabled while busy; Enter and form submit are
		// not — gate here so a mid-turn send can't fork a second request
		// (or a second conversation from the empty state).
		if (busy || configSaving) return;
		const text = draft.trim();
		const ready = staged.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0) return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready)
			parts.push({
				type: "data-attachment",
				data: e.speech === true ? { ...e.ref, speech: true } : e.ref,
			} as UIMessage["parts"][number]);
		setDraft("");
		// Entries that weren't sent — uploads still in flight, failed
		// chips — stay staged. Clearing them would drop files the
		// operator still sees in the composer.
		for (const e of ready) dropEntry(e);
		setStaged((p) => p.filter((e) => !ready.includes(e)));
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
			{staged.length > 0 && (
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
							<span className="attachment-size">{formatSize(e.ref.size)}</span>
							<button
								type="button"
								aria-label="Remove"
								onClick={() => {
									dropEntry(e);
									setStaged((p) => p.filter((_, j) => j !== i));
								}}
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
							configSaving ||
							recording ||
							(draft.trim() === "" &&
								staged.every((e) => e.failed === true || e.uploading === true))
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
	onSeeded,
	onTurnDone,
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
	onSeeded: () => void;
	onTurnDone: () => void;
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
	staged,
	setStaged,
	onSeeded,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
	title: string | null;
	initial: UIMessage[];
	seed: UIMessage["parts"] | null;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	onSeeded: () => void;
	onTurnDone: () => void;
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
	const { messages, sendMessage, regenerate, status, error, stop, setMessages } = useChat({
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
									<MessageParts parts={m.parts} token={token} />
								</div>
							);
						const meta = turnMeta(m);
						return (
							<div key={m.id} className="msg assistant">
								<MessageParts parts={m.parts} token={token} />
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
				</div>
			</div>
			<Composer
				token={token}
				conversationId={conversationId}
				busy={busy}
				staged={staged}
				setStaged={setStaged}
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
