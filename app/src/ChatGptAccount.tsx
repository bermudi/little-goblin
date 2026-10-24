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
import { Row } from "./settingsKit.tsx";

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

	const applyStatus = (s: ChatGptStatus) => {
		// Fallback credentials can report signed-in with an error when the
		// requested pairing itself failed — that is not completion.
		const completed = wasPending.current && s.state === "signed-in" && s.error === null;
		wasPending.current = s.state === "pending";
		setStatus(s);
		if (completed) onSignedIn?.();
	};

	useEffect(() => {
		let dead = false;
		const load = () =>
			getChatGptStatus(token)
				.then((s) => {
					if (dead) return;
					applyStatus(s);
				})
				.catch((e: unknown) => {
					// UI boundary: report HTTP/network/decoding failures on the
					// card; never present a failed read as signed-out.
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
			applyStatus(await fn(token));
		} catch (e) {
			// UI boundary: a failed sign-in/cancel/logout stays visible
			// without replacing the last known account state.
			setErr(e instanceof ApiError ? e.message : "Couldn't reach goblin.");
		} finally {
			setBusy(false);
		}
	};

	if (status === null) {
		return (
			<>
				<h2 className="ops-h2">ChatGPT</h2>
				<div className="card">
					<div className="cap">{err ?? "Loading…"}</div>
				</div>
			</>
		);
	}

	const doorNote = telegramDoor() ? "Finish the pairing in the browser tab that opens." : null;
	const signIn = (
		<button
			type="button"
			className="addbtn"
			disabled={busy}
			onClick={() => void act(startChatGptLogin)}
		>
			Sign in with ChatGPT
		</button>
	);

	return (
		<>
			<h2 className="ops-h2">ChatGPT</h2>
			<div className="card">
				{status.state === "pending" && status.pending !== null ? (
					<>
						<Row
							label="Pairing code"
							cap={`Enter it at OpenAI's sign-in page${doorNote !== null ? ` — ${doorNote}` : ""}.`}
						>
							<code className="mono chatgpt-code">{status.pending.userCode}</code>
						</Row>
						<div className="addrow">
							<button
								type="button"
								className="addbtn"
								onClick={() => copy(status.pending!.userCode)}
							>
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
							<button
								type="button"
								className="ghost"
								disabled={busy}
								onClick={() => void act(cancelChatGptLogin)}
							>
								Cancel
							</button>
						</div>
						<div className="cap">
							{expiryCountdown(status.pending.expiresAt, nowMs) !== null
								? `Expires in ${expiryCountdown(status.pending.expiresAt, nowMs)}`
								: "Pairing code expired — start again."}
						</div>
					</>
				) : status.state === "signed-in" && status.source === "goblin" ? (
					<Row
						label="Status"
						cap={`Signed in as ${status.email ?? "your ChatGPT account"}${status.plan !== null ? ` · ${status.plan}` : ""}`}
					>
						<button
							type="button"
							className="ghost"
							disabled={busy}
							onClick={() => {
								if (window.confirm("Sign goblin out of ChatGPT?")) {
									void act(signOutChatGpt);
								}
							}}
						>
							Sign out
						</button>
					</Row>
				) : status.state === "signed-in" && status.source === "codex-cli" ? (
					<>
						<Row
							label="Status"
							cap={`Using your Codex CLI login${status.email !== null ? ` (${status.email})` : ""} — sign in here to give goblin its own login; your terminal's codex stays untouched.`}
						>
							{signIn}
						</Row>
					</>
				) : status.pinned ? (
					<Row
						label="Status"
						cap="Using the auth file set in goblin.json5 — remove authFile from the codex provider to sign in here."
					>
						<span className="cap">read-only</span>
					</Row>
				) : (
					<Row label="Status" cap="Not signed in.">
						{signIn}
					</Row>
				)}
				{status.error !== null && <div className="cap err-inline">{status.error}</div>}
				{err !== null && <div className="cap err-inline">{err}</div>}
			</div>
		</>
	);
}
