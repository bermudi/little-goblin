import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
	ApiError,
	clearToken,
	createConversation,
	deleteConversation,
	listConversations,
	loadToken,
	renameConversation,
	saveToken,
	searchConversations,
} from "./api.ts";
import { ChatView, Composer } from "./ChatView.tsx";
import type { AppConversationList, AppSearchHit } from "../../src/http/app-wire.ts";

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

// The spin-off deep link (design/app.md → Spin-off → Links):
// /app/c/<appId> opens one conversation — the id matches the server's
// appIdSchema and the conversation id is "app/<appId>".
export function deepLinkConv(pathname: string): string | null {
	const m = /^\/app\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(pathname);
	return m === null ? null : `app/${m[1]}`;
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

// One rail row: the conversation button plus hover affordances —
// rename turns the title into an input, delete asks then removes.
function ConversationRow({
	conv,
	current,
	onOpen,
	onRenamed,
	onDeleted,
	token,
}: {
	conv: AppConversationList["conversations"][number];
	current: string | null;
	onOpen: (id: string) => void;
	onRenamed: () => void;
	onDeleted: (id: string) => void;
	token: string | null;
}) {
	const title = flatTitle(conv.title);
	const preview = flatLine(conv.preview);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	// Enter commits and unmounts the input — its blur then fires
	// commitRename a second time, a duplicate PATCH with the same title.
	const committed = useRef(false);
	useEffect(() => {
		if (editing) {
			committed.current = false;
			editRef.current?.focus();
			editRef.current?.select();
		}
	}, [editing]);

	const commitRename = () => {
		if (committed.current) return;
		committed.current = true;
		const t = draft.trim();
		setEditing(false);
		if (t === "" || t === title) return;
		void renameConversation(token, conv.id, t).then(onRenamed, () => {});
	};
	const remove = () => {
		if (!window.confirm(`Delete "${title ?? preview ?? "this conversation"}"?`)) return;
		void deleteConversation(token, conv.id).then(
			() => onDeleted(conv.id),
			() => {},
		);
	};

	if (editing) {
		return (
			<div className="conv editing">
				<input
					ref={editRef}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") setEditing(false);
					}}
				/>
			</div>
		);
	}
	return (
		<div className={conv.id === current ? "conv current" : "conv"}>
			<button type="button" className="conv-main" onClick={() => onOpen(conv.id)}>
				<span className="conv-head">
					<span className="conv-title">
						{title ?? (preview === "" ? "new conversation" : preview)}
					</span>
					<span className="conv-time">{relTime(conv.updatedAt)}</span>
				</span>
				{title !== null && preview !== "" && <span className="conv-preview">{preview}</span>}
			</button>
			<span className="conv-actions">
				<button
					type="button"
					aria-label="Rename"
					title="Rename"
					onClick={() => {
						setDraft(title ?? "");
						setEditing(true);
					}}
				>
					✎
				</button>
				<button type="button" aria-label="Delete" title="Delete" onClick={remove}>
					×
				</button>
			</span>
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
	const [conversations, setConversations] = useState<AppConversationList["conversations"] | null>(
		null,
	);
	const [current, setCurrent] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [navOpen, setNavOpen] = useState(false);
	// Rail search: debounced against the app-pool FTS endpoint. A non-
	// empty query swaps the conversation list for the hit list.
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AppSearchHit[] | null>(null);
	const searchSeq = useRef(0);
	// The empty state has the composer too — its send creates the
	// conversation, then ChatView delivers the parked message as `seed`.
	const [seed, setSeed] = useState<{ id: string; parts: UIMessage["parts"] } | null>(null);
	// Bump on "New conversation" — the composer focuses itself, mounted
	// or not (a remount sees the non-zero signal on first effect).
	const [composerFocus, setComposerFocus] = useState(0);
	const [starting, setStarting] = useState(false);
	const [startFailed, setStartFailed] = useState(false);
	const listSeq = useRef(0);
	// The deep link applies once — after the first list load — so an
	// operator's own navigation is never overridden later.
	const deepApplied = useRef(false);

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

	// A /app/c/<id> load selects that conversation once the list
	// arrives — an unknown id just shows the list.
	useEffect(() => {
		if (conversations === null || deepApplied.current) return;
		deepApplied.current = true;
		const id = deepLinkConv(window.location.pathname);
		if (id === null) return;
		if (conversations.some((c) => c.id === id)) {
			setCurrent(id);
		} else {
			// A dead link must not masquerade — normalize to the root.
			window.history.replaceState(null, "", "/app/");
		}
	}, [conversations]);

	// Debounced app-pool search — an empty box clears back to the list.
	useEffect(() => {
		const q = query.trim();
		if (q === "") {
			setHits(null);
			return;
		}
		const seq = ++searchSeq.current;
		const t = setTimeout(() => {
			void searchConversations(token, q).then(
				(r) => seq === searchSeq.current && setHits(r.hits),
				() => {},
			);
		}, 250);
		return () => clearTimeout(t);
	}, [query, token]);

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

	// Selection owns the URL — /app/c/<id> for a conversation, /app/
	// for the list/empty state, matching the deep link the pings carry.
	const select = (id: string | null) => {
		setCurrent(id);
		window.history.replaceState(
			null,
			"",
			id === null ? "/app/" : `/app/c/${id.slice("app/".length)}`,
		);
	};

	// "New conversation" opens the empty state; the conversation itself is
	// created lazily, on the first send — an untouched composer never
	// leaves an empty row in the store.
	const newConversation = () => {
		setNavOpen(false);
		setComposerFocus((t) => t + 1);
		select(null);
	};

	const openConversation = (id: string) => {
		select(id);
		setNavOpen(false);
	};

	const startConversation = async (parts: UIMessage["parts"]) => {
		setStarting(true);
		setStartFailed(false);
		try {
			const created = await createConversation(token);
			setSeed({ id: created.id, parts });
			select(created.id);
			await refresh();
		} catch {
			setStartFailed(true);
		} finally {
			setStarting(false);
		}
	};

	const currentTitle = conversations?.find((c) => c.id === current)?.title ?? null;

	return (
		<div className="shell">
			<nav className={navOpen ? "rail open" : "rail"}>
				<button type="button" className="new" onClick={newConversation}>
					New conversation
				</button>
				<input
					className="rail-search"
					type="search"
					placeholder="Search history"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setQuery("");
					}}
				/>
				{hits !== null ? (
					<>
						<ul className="search-results">
							{hits.map((h) => (
								<li key={`${h.conversationId}:${h.seq}`}>
									<button
										type="button"
										className="hit"
										onClick={() => {
											openConversation(h.conversationId);
											setQuery("");
										}}
									>
										<span className="hit-role">{h.role === "user" ? "you" : "goblin"}</span>
										<span className="hit-text">{flatLine(h.text)}</span>
										<span className="hit-conv">
											{flatTitle(h.title) ?? h.conversationId.slice(4)}
											{" · "}
											{relTime(h.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
						{hits.length === 0 && <p className="empty">No matches.</p>}
					</>
				) : (
					<ul>
						{(conversations ?? []).map((c) => (
							<li key={c.id}>
								<ConversationRow
									conv={c}
									current={current}
									token={token}
									onOpen={openConversation}
									onRenamed={() => void refresh()}
									onDeleted={(id) => {
										if (id === current) select(null);
										void refresh();
									}}
								/>
							</li>
						))}
					</ul>
				)}
				{hits === null && conversations !== null && conversations.length === 0 && (
					<p className="empty">Nothing here yet — start a conversation.</p>
				)}
				{listError !== null && <p className="error">Couldn't refresh the list.</p>}
			</nav>
			<div className={navOpen ? "scrim open" : "scrim"} onClick={() => setNavOpen(false)} />
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
					{current !== null && <span className="header-title">{flatTitle(currentTitle)}</span>}
				</header>
				{current === null ? (
					<div className="chat">
						<div className="transcript">
							<div className="transcript-inner">
								<p className="empty">
									Pick a conversation, or say something — a new one starts here.
								</p>
								{startFailed && (
									<p className="error">
										Couldn't start a conversation — check the tailnet, then resend.
									</p>
								)}
							</div>
						</div>
						<Composer
							token={token}
							busy={starting}
							focusSignal={composerFocus}
							onSend={(parts) => void startConversation(parts)}
						/>
					</div>
				) : (
					<ChatView
						key={current}
						token={token}
						conversationId={current}
						title={flatTitle(currentTitle)}
						seed={seed !== null && seed.id === current ? seed.parts : null}
						onSeeded={() => setSeed(null)}
						onTurnDone={() => void refresh()}
					/>
				)}
			</main>
		</div>
	);
}
