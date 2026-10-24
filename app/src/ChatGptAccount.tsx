// The ChatGPT sign-in card: device-code pairing against goblin's own
// accounts/chatgpt routes. The heavy lifting is server-side — this
// card only renders ChatGptStatus and fires the four endpoints.

import { useEffect, useRef, useState } from "react";
import type { ChatGptStatus } from "../../src/http/operator-wire.ts";
import {
	ApiError,
	cancelChatGptLogin,
	getChatGptStatus,
	signOutChatGpt,
	startChatGptLogin,
	telegramDoor,
} from "./api.ts";
import { useCopy } from "./useCopy.ts";

const POLL_MS = 3000;

function expiryCountdown(expiresAt: string, nowMs: number): string | null {
	const ms = Date.parse(expiresAt) - nowMs;
	if (!Number.isFinite(ms) || ms <= 0) return null;
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ChatGptAccount({
	token,
	onSignedIn,
}: {
	token: string | null;
	/** Fired once on each transition to signed-in — the parent may want
	 *  to reload the settings view (a codex provider may have landed). */
	onSignedIn?: () => void;
}) {
	const [status, setStatus] = useState<ChatGptStatus | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const { copy, copied } = useCopy();
	const wasPending = useRef(false);

	useEffect(() => {
		let dead = false;
		const load = () =>
			getChatGptStatus(token)
				.then((s) => {
					if (dead) return;
					setStatus(s);
					if (wasPending.current && s.state === "signed-in") onSignedIn?.();
					wasPending.current = s.state === "pending";
				})
				.catch((e: unknown) => {
					if (!dead) setErr(e instanceof ApiError ? e.message : "Couldn't reach goblin.");
				});
		void load();
		// Only a live pairing is polled — quiet otherwise.
		const t = setInterval(() => {
			setNowMs(Date.now());
			if (wasPending.current) void load();
		}, POLL_MS);
		return () => {
			dead = true;
			clearInterval(t);
		};
	}, [token, onSignedIn]);

	const act = async (fn: (t: string | null) => Promise<ChatGptStatus>) => {
		setBusy(true);
		setErr(null);
		try {
			setStatus(await fn(token));
		} catch (e) {
			setErr(e instanceof ApiError ? e.message : "Couldn't reach goblin.");
		} finally {
			setBusy(false);
		}
	};

	if (status === null) {
		return (
			<div className="card">
				<h3 className="ops-h3">ChatGPT</h3>
				<div className="cap">{err ?? "Loading…"}</div>
			</div>
		);
	}

	const doorNote = telegramDoor() ? "Finish the pairing in the browser tab that opens." : null;

	return (
		<div className="card">
			<h3 className="ops-h3">ChatGPT</h3>
			{status.state === "pending" && status.pending !== null ? (
				<>
					<div className="cap">
						Enter this code at OpenAI's sign-in page
						{doorNote !== null ? ` — ${doorNote}` : ""}:
					</div>
					<div className="addrow">
						<code className="mono" style={{ fontSize: "1.4em", letterSpacing: "0.15em" }}>
							{status.pending.userCode}
						</code>
						<button type="button" className="addbtn" onClick={() => copy(status.pending!.userCode)}>
							{copied ? "Copied" : "Copy"}
						</button>
						<a
							href={status.pending.verificationUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="keylink"
						>
							Open sign-in page
						</a>
					</div>
					<div className="cap">
						{expiryCountdown(status.pending.expiresAt, nowMs) !== null
							? `Expires in ${expiryCountdown(status.pending.expiresAt, nowMs)}`
							: "Pairing code expired — start again."}
					</div>
					<button
						type="button"
						className="addbtn"
						disabled={busy}
						onClick={() => void act(cancelChatGptLogin)}
					>
						Cancel
					</button>
				</>
			) : status.state === "signed-in" && status.source === "goblin" ? (
				<>
					<div>
						Signed in as {status.email ?? "your ChatGPT account"}
						{status.plan !== null ? ` · ${status.plan}` : ""}
					</div>
					<button
						type="button"
						className="keylink"
						disabled={busy}
						onClick={() => {
							if (window.confirm("Sign goblin out of ChatGPT?")) {
								void act(signOutChatGpt);
							}
						}}
					>
						Sign out
					</button>
				</>
			) : status.state === "signed-in" && status.source === "codex-cli" ? (
				<>
					<div>Using your Codex CLI login{status.email !== null ? ` (${status.email})` : ""}.</div>
					<div className="cap">
						Sign in here to give goblin its own login — your terminal's codex stays untouched.
					</div>
					<button
						type="button"
						className="addbtn"
						disabled={busy}
						onClick={() => void act(startChatGptLogin)}
					>
						Sign in with ChatGPT
					</button>
				</>
			) : status.pinned ? (
				<>
					<div>Using the auth file set in goblin.json5.</div>
					<div className="cap">Remove authFile from the codex provider to sign in here.</div>
				</>
			) : (
				<>
					<div>Not signed in.</div>
					{status.error !== null && <div className="cap err-inline">{status.error}</div>}
					<button
						type="button"
						className="addbtn"
						disabled={busy}
						onClick={() => void act(startChatGptLogin)}
					>
						Sign in with ChatGPT
					</button>
				</>
			)}
			{err !== null && <div className="cap err-inline">{err}</div>}
		</div>
	);
}
