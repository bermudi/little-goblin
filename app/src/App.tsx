import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ApiError, clearToken, createConversation, listConversations, loadToken, saveToken } from "./api.ts";
import { ChatView, Composer } from "./ChatView.tsx";
import type { AppConversationList } from "../../src/http/app-wire.ts";

// Sidebar timestamps are relative: "now", minutes, hours, days, then a
// short date — the format Open WebUI's chat list uses.
function relTime(iso: string): string {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "";
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) return "now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d`;
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Sidebar rows are single-line labels, so markdown furniture comes off
// the stored title at display time: fences and their language tag,
// inline-code backticks, link syntax (text survives), paired emphasis,
// and line-lead markers. Mirrors conversation.ts's flatLine — the client
// does its own pass because a running server may predate the store-side
// flattening and still hand over a fenced title.
export function flatLine(text: string): string {
	return text
		.replace(/```+[ \t]*[^\s`\n]*/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(\*|_)([^\s*_][^*_]*?[^\s*]|[^\s*_])\1/g, "$2")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

// A title reduced to nothing falls through to the preview, same as the
// server's `flatLine(r.title) || null` projection.
function flatTitle(title: string | null): string | null {
	if (title === null) return null;
	return flatLine(title) || null;
}

// The token is the operator-pasted credential (the value behind the
// auth.jsonl record config.appToken names), kept in localStorage. When
// the server runs trust mode (appToken unset) no credential exists —
// App probes unauthenticated first so the gate never shows.

function TokenGate({ hint, onToken }: { hint: string | null; onToken: (token: string) => void }) {
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(hint);
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		const token = draft.trim();
		if (token === "") return;
		setBusy(true);
		setError(null);
		try {
			// Prove the token before storing it — a bad paste should fail here.
			await listConversations(token);
			saveToken(token);
			onToken(token);
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 503
					? "The app channel isn't configured on this goblin."
					: "That token wasn't accepted.",
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="gate">
			<h1>goblin</h1>
			<p className="gate-hint">Paste the app token to open the channel.</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<input
					type="password"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="app token"
					autoFocus
					autoComplete="off"
				/>
				<button type="submit" disabled={busy || draft.trim() === ""}>
					Open
				</button>
			</form>
			{error !== null && <p className="error">{error}</p>}
		</div>
	);
}

export function App() {
	const [token, setToken] = useState<string | null>(loadToken);
	// The gate is conditional: the server may be in trust mode (appToken
	// unset — the tailnet is the only lock), where a bare request just
	// works and the token screen must never show. A stored token answers
	// the question itself through refresh(); with none stored, probe
	// unauthenticated first — 200 means trust mode, 401 shows the gate.
	const [gate, setGate] = useState<"probing" | "shown" | "passed">(
		token === null ? "probing" : "passed",
	);
	const [probeHint, setProbeHint] = useState<string | null>(null);
	const [conversations, setConversations] = useState<AppConversationList["conversations"] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [navOpen, setNavOpen] = useState(false);
	// The empty state has the composer too — its send creates the
	// conversation, then ChatView delivers the parked message as `seed`.
	const [seed, setSeed] = useState<{ id: string; parts: UIMessage["parts"] } | null>(null);
	const [starting, setStarting] = useState(false);
	const [startFailed, setStartFailed] = useState(false);
	const listSeq = useRef(0);

	useEffect(() => {
		if (gate !== "probing") return;
		let live = true;
		listConversations(null).then(
			() => live && setGate("passed"),
			(err) => {
				if (!live) return;
				if (!(err instanceof ApiError) || err.status !== 401) {
					setProbeHint(
						err instanceof ApiError
							? `The app channel answered ${err.status} — check goblin's log.`
							: "Couldn't reach goblin — check the tailnet.",
					);
				}
				setGate("shown");
			},
		);
		return () => {
			live = false;
		};
	}, [gate]);

	const refresh = useCallback(async () => {
		const seq = ++listSeq.current;
		try {
			const list = await listConversations(token);
			if (seq !== listSeq.current) return;
			setConversations(list.conversations);
			setListError(null);
		} catch (err) {
			setListError(err instanceof ApiError && err.status === 401 ? "unauthorized" : "list failed");
		}
	}, [token]);

	useEffect(() => {
		if (gate === "passed") void refresh();
	}, [gate, refresh]);

	// A dead token means 401s forever — offer a way back to the gate.
	if (listError === "unauthorized") {
		return (
			<div className="gate">
				<h1>goblin</h1>
				<p className="error">The stored token stopped working.</p>
				<button
					type="button"
					onClick={() => {
						clearToken();
						setToken(null);
						setListError(null);
						setProbeHint(null);
						setGate("shown");
					}}
				>
					Paste a new token
				</button>
			</div>
		);
	}

	if (gate === "probing") {
		return (
			<div className="gate">
				<h1>goblin</h1>
				<p className="gate-hint">Connecting…</p>
			</div>
		);
	}

	if (gate === "shown") {
		return (
			<TokenGate
				hint={probeHint}
				onToken={(t) => {
					setToken(t);
					setGate("passed");
				}}
			/>
		);
	}

	// "New conversation" opens the empty state; the conversation itself is
	// created lazily, on the first send — an untouched composer never
	// leaves an empty row in the store.
	const newConversation = () => {
		setNavOpen(false);
		setCurrent(null);
	};

	const startConversation = async (parts: UIMessage["parts"]) => {
		setStarting(true);
		setStartFailed(false);
		try {
			const created = await createConversation(token);
			setSeed({ id: created.id, parts });
			setCurrent(created.id);
			await refresh();
		} catch {
			setStartFailed(true);
		} finally {
			setStarting(false);
		}
	};

	return (
		<div className="shell">
			<nav className={navOpen ? "rail open" : "rail"}>
				<button type="button" className="new" onClick={newConversation}>
					New conversation
				</button>
				<ul>
					{(conversations ?? []).map((c) => {
						// Both single-line labels get the display-side flatten —
						// an old server hands over the raw store fields, and the
						// preview is as markdown-laced as the title.
						const title = flatTitle(c.title);
						const preview = flatLine(c.preview);
						return (
							<li key={c.id}>
								<button
									type="button"
									className={c.id === current ? "conv current" : "conv"}
									onClick={() => {
										setCurrent(c.id);
										setNavOpen(false);
									}}
								>
									<span className="conv-head">
										<span className="conv-title">{title ?? (preview === "" ? "new conversation" : preview)}</span>
										<span className="conv-time">{relTime(c.updatedAt)}</span>
									</span>
									{title !== null && preview !== "" && <span className="conv-preview">{preview}</span>}
								</button>
							</li>
						);
					})}
				</ul>
				{conversations !== null && conversations.length === 0 && (
					<p className="empty">Nothing here yet — start a conversation.</p>
				)}
				{listError !== null && <p className="error">Couldn't refresh the list.</p>}
			</nav>
			<div
				className={navOpen ? "scrim open" : "scrim"}
				onClick={() => setNavOpen(false)}
			/>
			<main>
				<header>
					<button
						type="button"
						className="nav-toggle"
						aria-label="Conversations"
						onClick={() => setNavOpen((v) => !v)}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.75"
							strokeLinecap="round"
							width="18"
							height="18"
						>
							<rect x="3" y="4" width="18" height="16" rx="3" />
							<line x1="9.5" y1="4" x2="9.5" y2="20" />
						</svg>
					</button>
					<h1>goblin</h1>
				</header>
				{current === null ? (
					<div className="chat">
						<div className="transcript">
							<div className="transcript-inner">
								<p className="empty">Pick a conversation, or say something — a new one starts here.</p>
								{startFailed && <p className="error">Couldn't start a conversation — check the tailnet, then resend.</p>}
							</div>
						</div>
						<Composer token={token} busy={starting} onSend={(parts) => void startConversation(parts)} />
					</div>
				) : (
					<ChatView
						key={current}
						token={token}
						conversationId={current}
						seed={seed !== null && seed.id === current ? seed.parts : null}
						onSeeded={() => setSeed(null)}
						onTurnDone={() => void refresh()}
					/>
				)}
			</main>
		</div>
	);
}
