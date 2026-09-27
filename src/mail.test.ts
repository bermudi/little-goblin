// The Gmail client's boundaries: OAuth minting, list/get parsing,
// multipart body choice, attachment separation, history polling, and
// MIME construction — all against fake Google servers, never the wire.

import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStore } from "./auth.ts";
import { setLogFile, setLogWriter } from "./log.ts";
import {
	buildRaw,
	decodeRfc2047,
	HistoryExpiredError,
	htmlToText,
	makeReader,
	makeSender,
	type MailHit,
} from "./mail.ts";

const fakeAuth: AuthStore = {
	resolve: async (name) => `secret:${name}`,
	has: () => true,
	names: () => [],
};

let servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
	for (const s of servers) await s.stop();
	servers = [];
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

function headers(...pairs: [string, string][]): Array<{ name: string; value: string }> {
	return pairs.map(([name, value]) => ({ name, value }));
}

describe("decodeRfc2047", () => {
	test("plain values pass through", () => {
		expect(decodeRfc2047("Hello world")).toBe("Hello world");
		expect(decodeRfc2047("alice@example.com")).toBe("alice@example.com");
	});

	test("B-encoded words decode", () => {
		expect(decodeRfc2047("=?UTF-8?B?SGVsbMOzIHdvcmxk?=")).toBe("Helló world");
	});

	test("Q-encoded words decode with underscores as spaces", () => {
		expect(decodeRfc2047("=?UTF-8?Q?booking_confirmed_=E2=9C=93?=")).toBe("booking confirmed ✓");
	});

	test("an undecodable word survives verbatim", () => {
		expect(decodeRfc2047("=?X?B?!!!?=")).toBe("=?X?B?!!!?=");
	});
});

describe("htmlToText", () => {
	test("short mail is kept — no minimum length", () => {
		expect(htmlToText("<p>ok thanks</p>")).toContain("ok thanks");
	});

	test("a normal HTML mail reads as text", () => {
		const text = htmlToText("<html><body><h1>Hi</h1><p>second line</p></body></html>");
		expect(text).toContain("Hi");
		expect(text).toContain("second line");
	});
});

describe("buildRaw", () => {
	function decoded(draft: Parameters<typeof buildRaw>[0]): string {
		return Buffer.from(buildRaw(draft), "base64url").toString("utf8");
	}

	test("minimal headers + body, base64url round-trip", () => {
		const raw = decoded({ to: ["a@x.com"], subject: "hi", body: "hello" });
		expect(raw).toContain("To: a@x.com");
		expect(raw).toContain("Subject: hi");
		expect(raw).toContain("Content-Type: text/plain");
		expect(raw).toContain("hello");
		expect(buildRaw({ to: ["a@x.com"], subject: "hi", body: "hello" })).not.toMatch(/[+/=]/);
	});

	test("non-ASCII subjects ride RFC 2047, replies thread", () => {
		const raw = decoded({
			to: ["a@x.com"],
			cc: ["b@y.com"],
			subject: "Hellóz",
			body: "x",
			threadId: "t1",
			inReplyTo: "<orig@mail>",
		});
		expect(raw).toContain("Cc: b@y.com");
		expect(raw).toContain("=?UTF-8?B?");
		expect(raw).toContain("In-Reply-To: <orig@mail>");
		expect(raw).toContain("References: <orig@mail>");
	});
});

describe("gmail client", () => {
	function oauthBase(seen: { body: string }): string {
		return serve(async (req) => {
			if (new URL(req.url).pathname !== "/token") return new Response("nf", { status: 404 });
			seen.body = await req.text();
			return Response.json({ access_token: "tok-1", expires_in: 3600 });
		});
	}

	test("search lists then resolves each hit's headers", async () => {
		const seen = { body: "" };
		const oauth = oauthBase(seen);
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/messages") {
				expect(req.headers.get("authorization")).toBe("Bearer tok-1");
				expect(url.searchParams.get("q")).toBe("from:bank");
				return Response.json({ messages: [{ id: "m1" }, { id: "m2" }], resultSizeEstimate: 2 });
			}
			const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
			if (m) {
				return Response.json({
					id: m[1],
					threadId: `t-${m[1]}`,
					snippet: `snip-${m[1]}`,
					payload: {
						headers: headers(
							["From", `a-${m[1]}@x.com`],
							["Subject", `sub-${m[1]}`],
							["Date", "Sat, 26 Sep 2026 10:00:00 +0000"],
						),
					},
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const hits = await reader.search("from:bank", 10);
		expect(hits).toHaveLength(2);
		expect(hits[0]).toMatchObject({
			id: "m1",
			threadId: "t-m1",
			from: "a-m1@x.com",
			subject: "sub-m1",
			snippet: "snip-m1",
		});
		// The mint posted the desktop-flow fields — and the READ refresh token.
		expect(seen.body).toContain("grant_type=refresh_token");
		expect(seen.body).toContain("client_id=cid");
		expect(seen.body).toContain(encodeURIComponent("secret:gmail-read"));
	});

	test("an oauth failure fails the call with the provider named", async () => {
		const oauth = serve(() => new Response("bad", { status: 401 }));
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: "http://127.0.0.1:1/gmail/v1",
			oauthBase: oauth,
		});
		await expect(reader.search("q", 5)).rejects.toThrow("gmail-oauth");
	});

	test("read prefers plain text and separates attachments", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/messages/m1") {
				return Response.json({
					id: "m1",
					threadId: "t1",
					snippet: "snip",
					payload: {
						mimeType: "multipart/mixed",
						headers: headers(
							["From", "Bank <noreply@bank.com>"],
							["To", "me@gmail.com"],
							["Subject", "=?UTF-8?B?U3RhdGVtZW50?="],
							["Date", "Sat, 26 Sep 2026 10:00:00 +0000"],
						),
						parts: [
							{ mimeType: "text/plain", body: { data: b64url("plain body"), size: 10 } },
							{ mimeType: "text/html", body: { data: b64url("<p>html body</p>"), size: 16 } },
							{
								mimeType: "application/pdf",
								filename: "stmt.pdf",
								body: { attachmentId: "att1", size: 1234 },
							},
						],
					},
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const msg = await reader.read("m1");
		expect(msg.subject).toBe("Statement");
		expect(msg.textBody).toBe("plain body");
		expect(msg.htmlConverted).toBe(false);
		expect(msg.attachments).toEqual([
			{ attachmentId: "att1", filename: "stmt.pdf", mimeType: "application/pdf", size: 1234 },
		]);
	});

	test("read converts html-only mail and flags it", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve(() =>
			Response.json({
				id: "m2",
				threadId: "t2",
				snippet: "s",
				payload: {
					mimeType: "text/html",
					headers: headers(["From", "x@y.com"], ["Subject", "hi"], ["Date", "today"]),
					body: { data: b64url("<p>html only</p>"), size: 16 },
				},
			}),
		);
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const msg = await reader.read("m2");
		expect(msg.textBody).toContain("html only");
		expect(msg.htmlConverted).toBe(true);
	});

	test("an oversized message body throws at the cap, not after buffering it", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		// format=FULL inlines every text part — an attacker-sized mail
		// streams forever, so the read must trip the cap mid-stream.
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		const gmail = serve(() =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(chunk);
					},
				}),
				{ headers: { "content-type": "application/json" } },
			));
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		await expect(reader.read("m-huge")).rejects.toThrow("8 MiB cap");
	});

	test("attachment bytes decode from base64url", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve(() =>
			Response.json({ data: Buffer.from("file-bytes").toString("base64url"), size: 10 }),
		);
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		expect(Buffer.from(await reader.attachment("m", "a")).toString()).toBe("file-bytes");
	});

	test("poll intersects arrivals with the filter, oldest first", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				expect(url.searchParams.get("startHistoryId")).toBe("100");
				return Response.json({
					history: [
						{ messagesAdded: [{ message: { id: "new-match" } }] },
						{ messagesAdded: [{ message: { id: "new-other" } }] },
					],
					historyId: "120",
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages") {
				// Newest first — new-match is older than the noise above it.
				return Response.json({ messages: [{ id: "old-noise" }, { id: "new-match" }] });
			}
			const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
			if (m) {
				return Response.json({
					id: m[1],
					threadId: "t",
					snippet: "s",
					payload: { headers: headers(["From", "f"], ["Subject", "s"], ["Date", "d"]) },
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const { hits, historyId } = await reader.poll("from:bank", "100");
		// new-other arrived but doesn't match; old-noise matches but isn't new.
		expect(hits.map((h) => h.id)).toEqual(["new-match"]);
		expect(historyId).toBe("120");
	});

	test("a multi-record burst fires the oldest cap-many and checkpoints at the last fired record", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		// 14 matching arrivals, one per history record — Google split the
		// burst across records, so a record-boundary cursor can hold the
		// unfired tail back for the next poll.
		const ids = Array.from({ length: 14 }, (_, i) => `m${i + 1}`);
		const records = ids.map((id, i) => ({
			id: String(101 + i),
			messagesAdded: [{ message: { id } }],
		}));
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				// Records strictly after the cursor — the checkpoint contract.
				const start = Number(url.searchParams.get("startHistoryId"));
				return Response.json({
					history: records.filter((r) => Number(r.id) > start),
					historyId: "200",
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages") {
					// Newest first — and all 14 still match on the second poll.
				return Response.json({ messages: [...ids].reverse().map((id) => ({ id })) });
			}
			const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
			if (m) {
				return Response.json({
					id: m[1],
					threadId: "t",
					snippet: "s",
					payload: { headers: headers(["From", "f"], ["Subject", "s"], ["Date", "d"]) },
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const first = await reader.poll("from:bank", "100");
		expect(first.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		// The checkpoint is the 10th match's record — the last one that
		// fired — not the mailbox head.
		expect(first.historyId).toBe("110");
		const second = await reader.poll("from:bank", first.historyId);
		// The remainder fires, no duplicates: only the records after the
		// checkpoint count as arrivals.
		expect(second.hits.map((h) => h.id)).toEqual(ids.slice(10));
		expect(second.historyId).toBe("200");
	});

	test("a single record over the cap fires cap-many, skips the rest, and warns", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		// Gmail collapsed a 12-message burst into ONE history record — a
		// record is the smallest checkpoint unit, so the 2 overflow
		// matches can only be skipped, and the warn says exactly that.
		const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				return Response.json({
					history: [{ id: "150", messagesAdded: ids.map((id) => ({ message: { id } })) }],
					historyId: "200",
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages") {
				return Response.json({ messages: [...ids].reverse().map((id) => ({ id })) });
			}
			const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
			if (m) {
				return Response.json({
					id: m[1],
					threadId: "t",
					snippet: "s",
					payload: { headers: headers(["From", "f"], ["Subject", "s"], ["Date", "d"]) },
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const captured: string[] = [];
		setLogFile("mail-poll-collapse-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await reader.poll("from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		// Advanced past the collapsed record — the 2 skipped matches
		// never refire (and never loop).
		expect(out.historyId).toBe("150");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg === "Gmail collapsed a burst into one history record — 2 matches skipped");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({ level: "warn", filter: "from:bank", matched: 12, firing: 10 });
	});

	test("a full filter list page warns — older matches may be invisible to the intersection", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		// Two arrivals, but the filter's list page comes back full (50/50)
		// — arrivals older than the newest 50 matches are invisible to
		// the intersection, and the head checkpoint would skip them. The
		// poll still works; it just says the loss is possible.
		const ids = ["m1", "m2"];
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				return Response.json({
					history: ids.map((id, i) => ({ id: String(101 + i), messagesAdded: [{ message: { id } }] })),
					historyId: "200",
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages") {
				const page = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}` }));
				// The two arrivals ride at the top of a FULL page.
				return Response.json({ messages: [...ids.reverse().map((id) => ({ id })), ...page.slice(ids.length)] });
			}
			const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
			if (m) {
				return Response.json({
					id: m[1],
					threadId: "t",
					snippet: "s",
					payload: { headers: headers(["From", "f"], ["Subject", "s"], ["Date", "d"]) },
				});
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const captured: string[] = [];
		setLogFile("mail-poll-fullpage-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await reader.poll("from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(["m1", "m2"]);
		expect(out.historyId).toBe("200");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg === "mail poll filter list page full — matches older than the newest 50 may be skipped by this checkpoint");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({ level: "warn", filter: "from:bank", listed: 50 });
	});

	test("poll with no arrivals advances the checkpoint without a list call", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		let lists = 0;
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				return Response.json({ historyId: "130" });
			}
			if (url.pathname === "/gmail/v1/users/me/messages") lists++;
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const { hits, historyId } = await reader.poll("from:bank", "120");
		expect(hits).toEqual([]);
		expect(historyId).toBe("130");
		expect(lists).toBe(0);
	});

	test("an expired history id surfaces as HistoryExpiredError", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/history") {
				return Response.json({ error: { code: 404 } }, { status: 404 });
			}
			return new Response("nf", { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		await expect(reader.poll("from:bank", "1")).rejects.toBeInstanceOf(HistoryExpiredError);
	});

	test("profileHistoryId returns the baseline checkpoint", async () => {
		const oauth = serve(() => Response.json({ access_token: "t", expires_in: 3600 }));
		const gmail = serve(() => Response.json({ historyId: "999", messagesTotal: 1 }));
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		expect(await reader.profileHistoryId()).toBe("999");
	});

	test("threadFor rides the read credential; a missing target is null", async () => {
		const seen = { body: "" };
		const oauth = serve(async (req) => {
			seen.body = await req.text();
			return Response.json({ access_token: "t", expires_in: 3600 });
		});
		const gmail = serve((req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/messages/m1") {
				return Response.json({
					id: "m1",
					threadId: "thread-9",
					payload: { headers: headers(["Message-ID", "<orig@mail>"]) },
				});
			}
			return Response.json({ error: {} }, { status: 404 });
		});
		const reader = makeReader({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			readAuth: "gmail-read",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		expect(await reader.threadFor("m1")).toEqual({ threadId: "thread-9", messageId: "<orig@mail>" });
		expect(await reader.threadFor("ghost")).toBeNull();
		// The mint used the READ refresh token — the lookup is a read
		// (the send-only scope would answer 403).
		expect(seen.body).toContain(encodeURIComponent("secret:gmail-read"));
	});

	test("send posts MIME + thread id; the mint used the SEND token", async () => {
		const seen = { body: "", send: "" as unknown };
		const oauth = serve(async (req) => {
			seen.body = await req.text();
			return Response.json({ access_token: "t", expires_in: 3600 });
		});
		const gmail = serve(async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
				seen.send = (await req.json()) as unknown;
				return Response.json({ id: "sent-1", threadId: "thread-9" });
			}
			return new Response("nf", { status: 404 });
		});
		const sender = makeSender({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			sendAuth: "gmail-send",
			gmailBase: `${gmail}/gmail/v1`,
			oauthBase: oauth,
		});
		const out = await sender.send({
			to: ["a@x.com"],
			subject: "hi",
			body: "hello",
			threadId: "thread-9",
			inReplyTo: "<orig@mail>",
		});
		expect(out).toEqual({ id: "sent-1", threadId: "thread-9" });
		const posted = seen.send as { raw: string; threadId: string };
		expect(posted.threadId).toBe("thread-9");
		const mime = Buffer.from(posted.raw, "base64url").toString("utf8");
		expect(mime).toContain("To: a@x.com");
		expect(mime).toContain("In-Reply-To: <orig@mail>");
		expect(seen.body).toContain(encodeURIComponent("secret:gmail-send"));
		expect(seen.body).not.toContain("gmail-read");
	});
});
