// Gmail over the operator's own OAuth client (DESIGN.md, "Email").
//
// Split tokens by construction: makeReader mints only read tokens,
// makeSender only send tokens, and the mail tool only ever receives a
// reader — the send credential never reaches a tool path or a skill.
// Access tokens are minted in-process per public-method call (one mint
// covers a method's whole sub-call fan-out) and never touch disk.
// Resolved secrets never enter logs or errors: log lines carry action,
// query or id, counts, status, and ms — never tokens or bodies.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
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

export interface MailAttachmentMeta {
	attachmentId: string;
	filename: string;
	mimeType: string;
	size: number;
}

export interface MailMessage extends MailHit {
	to: string;
	textBody: string;
	/** True when textBody came from HTML conversion, not a text part. */
	htmlConverted: boolean;
	attachments: MailAttachmentMeta[];
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
// A message.get(FULL) inlines every text part — an attacker-sized mail
// must fail loud, not balloon memory (fetch.ts's DOWNLOAD_CAP rule).
const MESSAGE_CAP = 8 * 1024 * 1024;
// attachments.get returns base64 (~4/3 of the file); Gmail caps files
// at 25 MiB, so 40 MiB of JSON headroom covers the largest legal one.
const ATTACHMENT_CAP = 40 * 1024 * 1024;
// One watcher tick fires once no matter how many matches — the batch
// cap bounds the per-tick get fan-out, oldest first.
const POLL_BATCH_CAP = 10;

export interface GmailReaderDeps {
	auth: AuthStore;
	clientId: string;
	/** auth.jsonl name holding the client secret. */
	clientSecretAuth: string;
	/** auth.jsonl name holding the gmail.readonly refresh token. */
	readAuth: string;
	/** Test doors — production always uses the Google bases. */
	gmailBase?: string;
	oauthBase?: string;
}

export interface GmailSenderDeps {
	auth: AuthStore;
	clientId: string;
	clientSecretAuth: string;
	/** auth.jsonl name holding the gmail.send refresh token. */
	sendAuth: string;
	gmailBase?: string;
	oauthBase?: string;
}

export interface MailReader {
	search(query: string, max: number): Promise<MailHit[]>;
	read(id: string): Promise<MailMessage>;
	attachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
	/** New matches since startHistoryId: history.list intersected with
	 *  the filter's list, oldest first, capped. historyId in the
	 *  result is the new checkpoint — advance past it even when empty. */
	poll(filter: string, startHistoryId: string): Promise<{ hits: MailHit[]; historyId: string }>;
	/** Current mailbox history id — the no-fire baseline for a new filter. */
	profileHistoryId(): Promise<string>;
}

export interface MailSender {
	/** Thread context for a reply target, or null when it doesn't exist. */
	threadFor(replyToId: string): Promise<{ threadId: string; messageId: string | null } | null>;
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

export function makeReader(deps: GmailReaderDeps): MailReader {
	const inner = new Gmail(deps, deps.readAuth);
	return {
		search: (query, max) => inner.search(query, max),
		read: (id) => inner.read(id),
		attachment: (messageId, attachmentId) => inner.attachment(messageId, attachmentId),
		poll: (filter, startHistoryId) => inner.poll(filter, startHistoryId),
		profileHistoryId: () => inner.profileHistoryId(),
	};
}

export function makeSender(deps: GmailSenderDeps): MailSender {
	const inner = new Gmail(deps, deps.sendAuth);
	return {
		threadFor: (replyToId) => inner.threadFor(replyToId),
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

	// One mint per public-method call: the token covers the method's
	// whole sub-call fan-out, then is dropped — never cached, never
	// logged. Concurrent methods mint independently; correctness over
	// call-counting.
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

	// Same call, but the body is attacker-sizable (a full message or an
	// attachment): gate the read on a cap instead of buffering blindly.
	private async callCapped(
		action: string,
		path: string,
		token: string,
		fields: Record<string, unknown>,
		cap: number,
	): Promise<unknown> {
		const started = Date.now();
		const res = await fetchOk("gmail", `${this.gmailBase}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		}, TIMEOUT_MS);
		const text = await readTextCapped(res, cap);
		let data: unknown;
		try {
			data = JSON.parse(text) as unknown;
		} catch (err) {
			throw new ProviderError("gmail", `non-JSON response — ${(err as Error).message}`);
		}
		log.info("gmail call", {
			action,
			...fields,
			status: res.status,
			bytes: Buffer.byteLength(text),
			ms: Date.now() - started,
		});
		return data;
	}

	async search(query: string, max: number): Promise<MailHit[]> {
		const token = await this.token();
		const params = new URLSearchParams({ q: query, maxResults: String(max) });
		const { data } = await this.call("search.list", `/users/me/messages?${params}`, token, { query });
		const rows = ((data as Record<string, unknown>).messages ?? []) as Array<Record<string, unknown>>;
		const hits: MailHit[] = [];
		for (const row of rows.slice(0, max)) {
			const id = str(row.id);
			if (id === "") continue;
			hits.push(await this.getMetadata(token, id));
		}
		return hits;
	}

	async read(id: string): Promise<MailMessage> {
		const token = await this.token();
		const data = await this.callCapped(
			"read.get", `/users/me/messages/${encodeURIComponent(id)}?format=FULL`, token,
			{ id }, MESSAGE_CAP,
		);
		return parseFull(data);
	}

	async attachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
		const token = await this.token();
		const data = await this.callCapped(
			"attachment.get",
			`/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
			token, { id: messageId }, ATTACHMENT_CAP,
		);
		const raw = str((data as Record<string, unknown>).data);
		if (raw === "") throw new ProviderError("gmail", "attachment response carried no data");
		return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
	}

	async poll(filter: string, startHistoryId: string): Promise<{ hits: MailHit[]; historyId: string }> {
		const token = await this.token();
		const params = new URLSearchParams({
			startHistoryId,
			historyTypes: "messageAdded",
		});
		let data: unknown;
		try {
			({ data } = await this.call(
				"poll.history", `/users/me/history?${params}`, token, { filter },
			));
		} catch (err) {
			// Expired ids 404 — the only 404 here that means "re-baseline";
			// anything else propagates as a poll failure.
			if (err instanceof ProviderError && err.message.includes("HTTP 404")) {
				throw new HistoryExpiredError();
			}
			throw err;
		}
		const body = data as { history?: unknown[]; historyId?: unknown };
		const latest = str(body.historyId);
		const added = new Set<string>();
		for (const h of body.history ?? []) {
			const rec = h as { messagesAdded?: unknown[] };
			for (const m of rec.messagesAdded ?? []) {
				const id = str((m as { message?: Record<string, unknown> }).message?.id);
				if (id !== "") added.add(id);
			}
		}
		if (added.size === 0) return { hits: [], historyId: latest };
		// history.list takes no query — intersect the mailbox-wide
		// arrivals with the filter's own recent matches (newest first),
		// then present oldest first.
		const listParams = new URLSearchParams({ q: filter, maxResults: "50" });
		const { data: listData } = await this.call(
			"poll.list", `/users/me/messages?${listParams}`, token, { filter },
		);
		const matching = ((listData as Record<string, unknown>).messages ?? []) as Array<Record<string, unknown>>;
		const matched = matching.map((m) => str(m.id)).filter((id) => id !== "" && added.has(id));
		matched.reverse();
		const batch = matched.slice(0, POLL_BATCH_CAP);
		if (matched.length > batch.length) {
			log.warn("mail poll batch capped — oldest matches fire, the rest wait for the next tick", {
				filter,
				matched: matched.length,
				firing: batch.length,
			});
		}
		const hits: MailHit[] = [];
		for (const id of batch) hits.push(await this.getMetadata(token, id));
		return { hits, historyId: latest };
	}

	async profileHistoryId(): Promise<string> {
		const token = await this.token();
		const { data } = await this.call("profile.get", "/users/me/profile", token, {});
		const historyId = str((data as Record<string, unknown>).historyId);
		if (historyId === "") throw new ProviderError("gmail", "profile response carried no historyId");
		return historyId;
	}

	async threadFor(replyToId: string): Promise<{ threadId: string; messageId: string | null } | null> {
		const token = await this.token();
		const params = new URLSearchParams({ format: "METADATA" });
		params.append("metadataHeaders", "Message-ID");
		let data: unknown;
		try {
			({ data } = await this.call(
				"reply.get", `/users/me/messages/${encodeURIComponent(replyToId)}?${params}`, token,
				{ id: replyToId },
			));
		} catch (err) {
			// A missing reply target is model-actionable (don't thread a
			// ghost); anything else is a failure.
			if (err instanceof ProviderError && err.message.includes("HTTP 404")) return null;
			throw err;
		}
		const msg = data as { threadId?: unknown; payload?: unknown };
		const threadId = str(msg.threadId);
		if (threadId === "") return null;
		const messageId = header((msg.payload ?? {}) as PartPayload, "Message-ID");
		return { threadId, messageId: messageId === "" ? null : messageId };
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

	private async getMetadata(token: string, id: string): Promise<MailHit> {
		const params = new URLSearchParams({ format: "METADATA" });
		for (const h of ["From", "Subject", "Date"]) params.append("metadataHeaders", h);
		const { data } = await this.call(
			"meta.get", `/users/me/messages/${encodeURIComponent(id)}?${params}`, token, { id },
		);
		const msg = data as {
			id?: unknown; threadId?: unknown; snippet?: unknown; payload?: unknown;
		};
		const payload = (msg.payload ?? {}) as PartPayload;
		return {
			id: str(msg.id) || id,
			threadId: str(msg.threadId),
			from: header(payload, "From"),
			subject: header(payload, "Subject"),
			date: header(payload, "Date"),
			snippet: str(msg.snippet),
		};
	}
}

// The cap is a ceiling on reads, not a post-hoc check (fetch.ts's
// readBodyCapped rule): cancel the moment it trips, assemble only a
// stream that ends within it.
async function readTextCapped(res: Response, cap: number): Promise<string> {
	if (res.body === null) return res.text();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let seen = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		chunks.push(value);
		seen += value.byteLength;
		if (seen > cap) {
			await reader.cancel();
			throw new ProviderError(
				"gmail",
				`response exceeds the ${Math.round(cap / 1024 / 1024)} MiB cap — narrow with search instead`,
			);
		}
	}
	const bytes = new Uint8Array(seen);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---------- parsing ----------

interface PartPayload {
	mimeType?: unknown;
	filename?: unknown;
	headers?: unknown;
	body?: unknown;
	parts?: unknown;
}

function header(payload: PartPayload, name: string): string {
	const headers = Array.isArray(payload.headers) ? payload.headers : [];
	const want = name.toLowerCase();
	for (const h of headers) {
		const row = h as { name?: unknown; value?: unknown };
		if (str(row.name).toLowerCase() === want) return decodeRfc2047(str(row.value));
	}
	return "";
}

function partBody(part: PartPayload): { data: string; attachmentId: string; size: number } {
	const body = (part.body ?? {}) as { data?: unknown; attachmentId?: unknown; size?: unknown };
	return {
		data: str(body.data),
		attachmentId: str(body.attachmentId),
		size: typeof body.size === "number" ? body.size : 0,
	};
}

function parseFull(data: unknown): MailMessage {
	const msg = data as {
		id?: unknown; threadId?: unknown; snippet?: unknown; payload?: unknown;
	};
	const payload = (msg.payload ?? {}) as PartPayload;
	const plains: string[] = [];
	const htmls: string[] = [];
	const attachments: MailAttachmentMeta[] = [];
	walkParts(payload, plains, htmls, attachments);
	const plain = plains.join("\n\n").trim();
	const htmlConverted = plain === "" && htmls.length > 0;
	const textBody = plain !== ""
		? plain
		: htmls.map(htmlToText).filter((t) => t !== "").join("\n\n");
	return {
		id: str(msg.id),
		threadId: str(msg.threadId),
		from: header(payload, "From"),
		to: header(payload, "To"),
		subject: header(payload, "Subject"),
		date: header(payload, "Date"),
		snippet: str(msg.snippet),
		textBody,
		htmlConverted,
		attachments,
	};
}

function walkParts(
	part: PartPayload,
	plains: string[],
	htmls: string[],
	attachments: MailAttachmentMeta[],
): void {
	const mime = str(part.mimeType).toLowerCase() || "text/plain";
	const filename = str(part.filename);
	const { data, attachmentId, size } = partBody(part);
	// A named part with an attachment id is a file, even when its mime
	// says text — never inline it into the body.
	if (filename !== "" && attachmentId !== "") {
		attachments.push({ attachmentId, filename, mimeType: mime, size });
		return;
	}
	if (mime === "text/html" && data !== "") {
		htmls.push(decodeBody(data));
		return;
	}
	if (mime.startsWith("text/") && data !== "") {
		plains.push(decodeBody(data));
		return;
	}
	const parts = Array.isArray(part.parts) ? part.parts : [];
	for (const sub of parts) {
		walkParts((sub ?? {}) as PartPayload, plains, htmls, attachments);
	}
	// Single-part non-multipart with an inline body and no text mime
	// (e.g. a bare message/rfc822 forward): surface the raw text.
	if (parts.length === 0 && data !== "" && filename === "" && attachmentId === "") {
		plains.push(decodeBody(data));
	}
}

function decodeBody(data: string): string {
	try {
		return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
	} catch {
		return "";
	}
}

/** HTML → text for mail bodies. Short mail is normal — no minimum
 *  length, no browser-skill refusal (fetch.ts's MIN_EXTRACT rule would
 *  reject half of all mail); readability with a textContent fallback. */
export function htmlToText(html: string): string {
	try {
		const dom = parseHTML(html);
		const article = new Readability(dom.document).parse();
		const text = (article?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
		if (text !== "") return text;
	} catch {
		// fall through to the raw fallback
	}
	try {
		const dom = parseHTML(html);
		const doc = dom.document as unknown as {
			body?: { textContent?: string };
			documentElement?: { textContent?: string };
		};
		// Fragments parse without a body — documentElement holds the text.
		const raw = doc.body?.textContent || doc.documentElement?.textContent || "";
		return raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	} catch {
		return "";
	}
}

// RFC 2047 encoded-words (=?charset?B|Q?text?=) — the shape non-ASCII
// subjects and display names arrive in. Unknown charsets decode as
// UTF-8; undecodable words survive verbatim rather than vanishing.
export function decodeRfc2047(value: string): string {
	return value.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset: string, enc: string, text: string) => {
		try {
			const bytes = enc.toLowerCase() === "b"
				? Buffer.from(text, "base64")
				: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
					String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
			return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
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
function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "(invalid)" : address.slice(at + 1).toLowerCase() || "(invalid)";
}
