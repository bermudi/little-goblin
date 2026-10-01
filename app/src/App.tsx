import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, clearToken, createConversation, listConversations, loadToken, saveToken } from "./api.ts";
import { ChatView } from "./ChatView.tsx";
import type { AppConversationList } from "../../src/http/app-wire.ts";

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

	const newConversation = async () => {
		try {
			const created = await createConversation(token);
			setNavOpen(false);
			setCurrent(created.id);
			await refresh();
		} catch {
			setListError("create failed");
		}
	};

	return (
		<div className="shell">
			<nav className={navOpen ? "rail open" : "rail"}>
				<button type="button" className="new" onClick={() => void newConversation()}>
					New conversation
				</button>
				<ul>
					{(conversations ?? []).map((c) => (
						<li key={c.id}>
							<button
								type="button"
								className={c.id === current ? "conv current" : "conv"}
								onClick={() => {
									setCurrent(c.id);
									setNavOpen(false);
								}}
							>
								<span className="conv-title">{c.title ?? c.preview ?? "new conversation"}</span>
								{c.title !== null && c.preview !== "" && <span className="conv-preview">{c.preview}</span>}
							</button>
						</li>
					))}
				</ul>
				{conversations !== null && conversations.length === 0 && (
					<p className="empty">Nothing here yet — start a conversation.</p>
				)}
				{listError !== null && (
					<p className="error">{listError === "create failed" ? "Couldn't start a conversation." : "Couldn't refresh the list."}</p>
				)}
			</nav>
			<main>
				<header>
					<button
						type="button"
						className="nav-toggle"
						aria-label="Conversations"
						onClick={() => setNavOpen((v) => !v)}
					>
						≡
					</button>
					<h1>goblin</h1>
				</header>
				{current === null ? (
					<div className="placeholder">
						<p>Pick a conversation, or start a new one.</p>
					</div>
				) : (
					<ChatView key={current} token={token} conversationId={current} onTurnDone={() => void refresh()} />
				)}
			</main>
		</div>
	);
}
