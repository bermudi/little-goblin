// Gmail send over the operator's own OAuth client (DESIGN.md, "Email").
//
// Reads ride gws: the model's read path is the goblin-mail wrapper +
// gws skill, the watcher's poll surface is mail-gws.ts — this module
// owns only the operator-gated SEND. makeSender mints send tokens
// in-process per call and never touches disk; the send credential never
// reaches a tool path or a skill. Resolved secrets never enter logs or
// errors: log lines carry action, counts, status, and ms — never tokens
// or bodies.

import type { AuthStore } from "./auth.ts";
import { log } from "./log.ts";
import {
	fetchOk,
	ProviderError,
	readJson,
	str,
} from "./agent/tools/web.ts";

// ---------- shapes ----------

export interface MailHit {
	id: string;
	threadId: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
}

/** Thread context for a reply target — resolved through the gws-backed
 *  poller at send time (mail-gws.ts), never the send token. */
export interface ThreadContext {
	threadId: string;
	messageId: string | null;
}

export interface MailDraft {
	to: string[];
	cc?: string[];
	subject: string;
	body: string;
	threadId?: string;
	inReplyTo?: string | null;
}

// ---------- client ----------

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_BASE = "https://oauth2.googleapis.com";
const TIMEOUT_MS = 15_000;

export interface GmailSenderDeps {
	auth: AuthStore;
	clientId: string;
	clientSecretAuth: string;
	/** auth.jsonl name holding the gmail.send refresh token. */
	sendAuth: string;
	gmailBase?: string;
	oauthBase?: string;
}

/** The watcher's poll surface: history intersect + baseline + thread
 *  context. mail-gws.ts's gws reader in production, a fake at the
 *  edge in tests — structural, not nominal. */
export interface MailPoller {
	/** New matches since startHistoryId: history.list intersected with
	 *  the filter's list, oldest first, batched at whole history records
	 *  up to the per-tick cap. historyId in the result is the new
	 *  checkpoint — advance past it even when empty; a truncated batch
	 *  checkpoints at its last fired record so the remainder refires. */
	poll(filter: string, startHistoryId: string): Promise<{ hits: MailHit[]; historyId: string }>;
	/** Current mailbox history id — the no-fire baseline for a new filter. */
	profileHistoryId(): Promise<string>;
	/** Thread context for a reply target, or null when it doesn't exist. */
	threadFor(replyToId: string): Promise<ThreadContext | null>;
}

export interface MailSender {
	send(draft: MailDraft): Promise<{ id: string; threadId: string }>;
}

/** history.list 404 — the stored id expired off Google's window. The
 *  watcher catches this and re-baselines instead of firing. */
export class HistoryExpiredError extends Error {
	constructor() {
		super("gmail: stored history id expired — re-baseline");
		this.name = "HistoryExpiredError";
	}
}

export function makeSender(deps: GmailSenderDeps): MailSender {
	const inner = new Gmail(deps, deps.sendAuth);
	return {
		send: (draft) => inner.send(draft),
	};
}

interface GmailDeps {
	auth: AuthStore;
	clientId: string;
	clientSecretAuth: string;
	gmailBase?: string;
	oauthBase?: string;
}

class Gmail {
	private readonly gmailBase: string;
	private readonly oauthBase: string;

	constructor(
		private readonly deps: GmailDeps,
		private readonly refreshAuth: string,
	) {
		this.gmailBase = deps.gmailBase ?? GMAIL_BASE;
		this.oauthBase = deps.oauthBase ?? OAUTH_BASE;
	}

	// One mint per public-method call: the token covers the method, then
	// is dropped — never cached, never logged. Concurrent methods mint
	// independently; correctness over call-counting.
	private async token(): Promise<string> {
		const [clientSecret, refreshToken] = await Promise.all([
			this.deps.auth.resolve(this.deps.clientSecretAuth),
			this.deps.auth.resolve(this.refreshAuth),
		]);
		const started = Date.now();
		let res: Response;
		try {
			res = await fetch(`${this.oauthBase}/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.deps.clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
					grant_type: "refresh_token",
				}).toString(),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (err) {
			throw new ProviderError("gmail-oauth", `request failed — ${(err as Error).message}`);
		}
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
			throw new ProviderError(
				"gmail-oauth",
				`HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`,
			);
		}
		const { data } = await readJson("gmail-oauth", res);
		const access = str((data as Record<string, unknown>).access_token);
		if (access === "") throw new ProviderError("gmail-oauth", "token response carried no access_token");
		log.debug("gmail oauth mint", { ms: Date.now() - started });
		return access;
	}

	private async call(
		action: string,
		path: string,
		token: string,
		fields: Record<string, unknown>,
		init?: RequestInit,
	): Promise<{ data: unknown; status: number }> {
		const started = Date.now();
		const res = await fetchOk("gmail", `${this.gmailBase}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
		}, TIMEOUT_MS);
		const { data, bytes } = await readJson("gmail", res);
		log.info("gmail call", {
			action,
			...fields,
			status: res.status,
			bytes,
			ms: Date.now() - started,
		});
		return { data, status: res.status };
	}

	async send(draft: MailDraft): Promise<{ id: string; threadId: string }> {
		const token = await this.token();
		const raw = buildRaw(draft);
		const body: Record<string, unknown> = { raw };
		if (draft.threadId !== undefined) body.threadId = draft.threadId;
		const { data } = await this.call("send", "/users/me/messages/send", token, {
			to: draft.to.map(domainOf),
			...(draft.cc?.length ? { cc: draft.cc.map(domainOf) } : {}),
			...(draft.threadId !== undefined ? { threaded: true } : {}),
		}, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const sent = data as { id?: unknown; threadId?: unknown };
		return { id: str(sent.id), threadId: str(sent.threadId) };
	}
}

// RFC 2047 encoded-words (=?charset?B|Q?text?=) — the shape non-ASCII
// subjects and display names arrive in. Undecodable words survive
// verbatim rather than vanishing.
export function decodeRfc2047(value: string): string {
	return value.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset: string, enc: string, text: string) => {
		try {
			const bytes = enc.toLowerCase() === "b"
				? Buffer.from(text, "base64")
				: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
					String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
			// Bun types narrow TextDecoder's label to its Encoding union;
			// the runtime takes any WHATWG label and throws RangeError
			// otherwise — the catch turns that into a verbatim word.
			return new TextDecoder(charset.toLowerCase() as "utf-8", { fatal: false }).decode(bytes);
		} catch {
			return match;
		}
	});
}

// ---------- sending ----------

// Minimal RFC 5322: the authenticated account is the From (Gmail fills
// it), the body is plain UTF-8, non-ASCII subjects ride RFC 2047.
export function buildRaw(draft: MailDraft): string {
	const lines = [
		`To: ${draft.to.join(", ")}`,
		...(draft.cc?.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
		`Subject: ${encodeSubject(draft.subject)}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: 8bit",
		...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`, `References: ${draft.inReplyTo}`] : []),
		"",
		draft.body,
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function encodeSubject(subject: string): string {
	if (/^[\x20-\x7E]*$/.test(subject)) return subject === "" ? "(no subject)" : subject;
	return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

// Log fields carry the recipient domain, never the address or body.
export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "(invalid)" : address.slice(at + 1).toLowerCase() || "(invalid)";
}
