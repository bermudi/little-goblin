// The send client's boundaries: OAuth minting (SEND token only) and
// MIME construction — all against fake Google servers, never the wire.
// The read/poll surface moved to gws (mail-gws.ts + its test); the
// multipart/attachment parsing left with it.

import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStore } from "./auth.ts";
import {
	buildRaw,
	decodeRfc2047,
	makeSender,
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


describe("gmail send", () => {
	test("an oauth failure fails the call with the provider named", async () => {
		const oauth = serve(() => new Response("bad", { status: 401 }));
		const sender = makeSender({
			auth: fakeAuth,
			clientId: "cid",
			clientSecretAuth: "gmail-secret",
			sendAuth: "gmail-send",
			gmailBase: "http://127.0.0.1:1/gmail/v1",
			oauthBase: oauth,
		});
		await expect(sender.send({ to: ["a@x.com"], subject: "hi", body: "hello" })).rejects.toThrow("gmail-oauth");
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
