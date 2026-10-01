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

// Inline marks: `code` spans and bare URLs become elements; everything
// else stays text. Long answers are the reason this channel exists —
// the renderer's job is comfortable reading, not markdown completeness.
const INLINE = /`([^`]+)`|(https?:\/\/[^\s<>"')\]]+)/g;

function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) out.push(text.slice(last, m.index));
		if (m[1] !== undefined) out.push(<code key={i}>{m[1]}</code>);
		else out.push(<a key={i} href={m[2]} target="_blank" rel="noreferrer">{m[2]}</a>);
		last = m.index + m[0].length;
		i++;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

function TextBlock({ text }: { text: string }) {
	// Fenced blocks are code; the rest is paragraphs separated by blank
	// lines. pre-wrap keeps single newlines readable.
	const blocks: ReactNode[] = [];
	const fence = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(fence)) {
		const prose = text.slice(last, m.index);
		for (const para of prose.split(/\n{2,}/)) {
			const trimmed = para.trim();
			if (trimmed !== "") blocks.push(<p key={i++}>{inline(trimmed)}</p>);
		}
		blocks.push(<pre key={i++}><code>{m[1]}</code></pre>);
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

function AttachmentChip({ data }: { data: unknown }) {
	const ref = data as AttachmentRef;
	if (typeof ref?.filename !== "string") return null;
	return <span className="attachment">📎 {ref.filename}</span>;
}

function MessageParts({ parts }: { parts: UIMessage["parts"] }) {
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
		else if (p.type === "file") out.push(<span key={i} className="attachment">📎 {p.filename ?? "attachment"}</span>);
		// step-start and other plumbing parts render as nothing.
	}
	return <>{out}</>;
}

// ---------- the chat ----------

export function ChatView({
	token,
	conversationId,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
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
	return <Chat conversationId={conversationId} token={token} initial={initial} onTurnDone={onTurnDone} />;
}

function Chat({
	token,
	conversationId,
	initial,
	onTurnDone,
}: {
	token: string | null;
	conversationId: string;
	initial: UIMessage[];
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

	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState<{ ref: AttachmentRef; uploading?: boolean; failed?: boolean }[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const busy = status === "submitted" || status === "streaming";

	useEffect(() => {
		const el = scrollRef.current;
		if (el !== null) el.scrollTop = el.scrollHeight;
	}, [messages]);

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
		void sendMessage({ parts });
	};

	return (
		<div className="chat">
			<div className="transcript" ref={scrollRef}>
				{messages.length === 0 && <p className="empty">Say something.</p>}
				{messages.map((m) => (
					<div key={m.id} className={m.role === "user" ? "msg user" : "msg assistant"}>
						<MessageParts parts={m.parts} />
					</div>
				))}
				{busy && <div className="msg assistant pending">…</div>}
				{error !== undefined && <div className="error">The turn failed: {error.message}</div>}
			</div>
			{pending.length > 0 && (
				<div className="pending-attachments">
					{pending.map((e, i) => (
						<span key={i} className={e.failed === true ? "attachment failed" : "attachment"}>
							{e.uploading === true ? "↑ " : e.failed === true ? "✗ " : ""}
							{e.ref.filename}
							<button type="button" aria-label="Remove" onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
								×
							</button>
						</span>
					))}
				</div>
			)}
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
				<button type="button" aria-label="Attach" onClick={() => fileInput.current?.click()}>
					📎
				</button>
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
				{busy ? (
					// Stop means stop: ask the runtime to abort the turn, then
					// let go of this client's stream. History keeps what was written.
					<button
						type="button"
						onClick={() => {
							void stopConversation(token, conversationId).catch(() => {});
							void stop();
						}}
					>
						Stop
					</button>
				) : (
					<button type="submit" disabled={draft.trim() === "" && pending.every((e) => e.failed === true || e.uploading === true)}>
						Send
					</button>
				)}
			</form>
		</div>
	);
}
