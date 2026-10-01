import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	getToolName,
	isToolUIPart,
	type DynamicToolUIPart,
	type ToolUIPart,
	type UIMessage,
} from "ai";
import { getMessages, stopConversation, uploadAttachment } from "./api.ts";
import type { AttachmentRef } from "../../src/agent/attachments.ts";

// ---------- transcript rendering ----------

// Inline marks: [links](url), `code` spans, and bare URLs become
// elements; everything else stays text. Long answers are the reason
// this channel exists — the renderer's job is comfortable reading, not
// markdown completeness. The link alternative must lead: it swallows the
// URL inside its own parens before the bare-URL branch can split it.
const INLINE =
	/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|(https?:\/\/[^\s<>"')\]]+)/g;

function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) out.push(text.slice(last, m.index));
		if (m[1] !== undefined)
			out.push(
				<a key={i} href={m[2]} target="_blank" rel="noreferrer">
					{m[1]}
				</a>,
			);
		else if (m[3] !== undefined) out.push(<code key={i}>{m[3]}</code>);
		else
			out.push(
				<a key={i} href={m[4]} target="_blank" rel="noreferrer">
					{m[4]}
				</a>,
			);
		last = m.index + m[0].length;
		i++;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

// Fenced blocks render as a card: mono language label, copy button, then
// the code. No syntax coloring — mono + label + copy (the Computer v1).
function CodeBlock({ lang, code }: { lang: string; code: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = () => {
		void navigator.clipboard.writeText(code).catch(() => {});
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="codeblock">
			<div className="codeblock-head">
				<span className="codeblock-lang">{lang === "" ? "text" : lang}</span>
				<button type="button" className="codeblock-copy" onClick={copy}>
					{copied ? "✓" : "copy"}
				</button>
			</div>
			<pre>
				<code>{code}</code>
			</pre>
		</div>
	);
}

function TextBlock({ text }: { text: string }) {
	// Fenced blocks are code; the rest is paragraphs separated by blank
	// lines. pre-wrap keeps single newlines readable.
	const blocks: ReactNode[] = [];
	const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(fence)) {
		const prose = text.slice(last, m.index);
		for (const para of prose.split(/\n{2,}/)) {
			const trimmed = para.trim();
			if (trimmed !== "") blocks.push(<p key={i++}>{inline(trimmed)}</p>);
		}
		blocks.push(<CodeBlock key={i++} lang={(m[1] ?? "").trim()} code={m[2] ?? ""} />);
		last = m.index + m[0].length;
	}
	for (const para of text.slice(last).split(/\n{2,}/)) {
		const trimmed = para.trim();
		if (trimmed !== "") blocks.push(<p key={i++}>{inline(trimmed)}</p>);
	}
	return <>{blocks}</>;
}

const TOOL_STATE_LABEL: Record<string, string> = {
	"input-streaming": "running",
	"input-available": "running",
	"approval-requested": "waiting",
	"approval-responded": "waiting",
	"output-available": "done",
	"output-error": "failed",
	"output-denied": "refused",
};

function summarizeValue(value: unknown): string {
	try {
		const s = JSON.stringify(value);
		return s.length > 300 ? `${s.slice(0, 300)}…` : s;
	} catch {
		return "(unprintable)";
	}
}

// Tool activity collapses into one expandable row per run — the answer
// stays readable, the work stays inspectable.
function Worked({ parts }: { parts: (ToolUIPart | DynamicToolUIPart)[] }) {
	const running = parts.some((p) => TOOL_STATE_LABEL[p.state] === "running");
	const failed = parts.some((p) => p.state === "output-error");
	const names = [...new Set(parts.map((p) => getToolName(p)))];
	return (
		<details className="worked">
			<summary>
				{running ? "Working" : "Worked"} · {names.join(", ")}
				{failed ? " — one failed" : ""}
			</summary>
			<ul>
				{parts.map((p, i) => (
					<li key={i}>
						<span className={`tool-state ${TOOL_STATE_LABEL[p.state] ?? "done"}`}>
							{TOOL_STATE_LABEL[p.state] ?? p.state}
						</span>{" "}
						{getToolName(p)}
						{p.state === "output-error" && (
							<pre className="tool-detail">{p.errorText ?? "tool failed"}</pre>
						)}
						{p.state === "input-available" || p.state === "output-available" ? (
							<pre className="tool-detail">{summarizeValue(p.input)}</pre>
						) : null}
					</li>
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
		if (p.type === "text") out.push(<TextBlock key={i} text={p.text} />);
		else if (p.type === "reasoning") out.push(<div key={i} className="reasoning">{p.text}</div>);
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

// ---------- the composer ----------

// Always present — on an empty conversation too. Draft + staged
// attachments are local; onSend hands the assembled parts up, where the
// caller either streams them into the open conversation or creates one.
export function Composer({
	token,
	busy,
	onSend,
	onStop,
}: {
	token: string | null;
	busy: boolean;
	onSend: (parts: UIMessage["parts"]) => void;
	// Present only where a live turn exists to interrupt (ChatView).
	onStop?: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState<{ ref: AttachmentRef; uploading?: boolean; failed?: boolean }[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);

	const pickFile = async (file: File) => {
		setPending((p) => [...p, { ref: { path: "", mediaType: file.type, filename: file.name, size: file.size }, uploading: true }]);
		try {
			const { ref } = await uploadAttachment(token, file);
			setPending((p) => p.map((e) => (e.uploading && e.ref.filename === file.name ? { ref } : e)));
		} catch {
			setPending((p) => p.map((e) => (e.uploading && e.ref.filename === file.name ? { ...e, uploading: false, failed: true } : e)));
		}
	};

	const send = () => {
		const text = draft.trim();
		const ready = pending.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0) return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready) parts.push({ type: "data-attachment", data: e.ref } as UIMessage["parts"][number]);
		setDraft("");
		setPending([]);
		onSend(parts);
	};

	return (
		<form
			className="composer"
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
							<button type="button" aria-label="Remove" onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
								×
							</button>
						</span>
					))}
				</div>
			)}
			<textarea
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
			<div className="composer-bar">
				<button type="button" className="icon-btn" aria-label="Attach" onClick={() => fileInput.current?.click()}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" width="16" height="16">
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
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
						disabled={busy || (draft.trim() === "" && pending.every((e) => e.failed === true || e.uploading === true))}
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

export function ChatView({
	token,
	conversationId,
	seed,
	onSeeded,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
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
	initial,
	seed,
	onSeeded,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
	initial: UIMessage[];
	seed: UIMessage["parts"] | null;
	onSeeded: () => void;
	onTurnDone: () => void;
}) {
	// The transport speaks this channel's contract: one user message per
	// POST, keyed by the app conversation id (DESIGN.md, App channel).
	// token null = trust mode — the server wants no credential.
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: "/api/app/chat",
				headers: token === null ? {} : { authorization: `Bearer ${token}` },
				prepareSendMessagesRequest: ({ trigger, messageId, messages }) => ({
					body: {
						conversationId,
						message:
							trigger === "submit-message"
								? messages.find((m) => m.id === messageId) ?? messages[messages.length - 1]
								: messages[messages.length - 1],
					},
				}),
			}),
		[token, conversationId],
	);
	const { messages, sendMessage, status, error, stop } = useChat({
		id: conversationId,
		messages: initial,
		transport,
		onFinish: onTurnDone,
	});

	const scrollRef = useRef<HTMLDivElement>(null);
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

	return (
		<div className="chat">
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
					{messages.map((m) => (
						<div key={m.id} className={m.role === "user" ? "msg user" : "msg assistant"}>
							<MessageParts parts={m.parts} />
						</div>
					))}
					{busy && <div className="msg assistant pending shimmer">…</div>}
					{error !== undefined && <div className="error">The turn failed: {error.message}</div>}
				</div>
			</div>
			<Composer
				token={token}
				busy={busy}
				onSend={(parts) => {
					pinned.current = true;
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
