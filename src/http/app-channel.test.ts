import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Config, ConfigRef } from "../config.ts";
import { appAddress, openStore, type ConversationStore } from "../conversation.ts";
import { Runtime } from "../runtime.ts";
import type { AuthStore } from "../auth.ts";
import { startHttp } from "./mod.ts";
import { handleAppApi, resolveAppAuth, type AppChannelDeps } from "./app-channel.ts";
import { setLogFile } from "../log.ts";

// End-to-end over the real HTTP listener with the model faked at the
// provider edge (the suite's convention). The appApi closure mirrors
// index.ts's wiring verbatim.

const APP_TOKEN_NAME = "app-token";
const APP_TOKEN_VALUE = "sekret-app-token";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeModel(deltas: string[], delayMs = 5): LanguageModel {
	return {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream() {
			const stream = new ReadableStream<LanguageModelV4StreamPart>({
				async start(controller) {
					const push = (p: LanguageModelV4StreamPart) => {
						try {
							controller.enqueue(p);
						} catch {
							/* closed */
						}
					};
					push({ type: "stream-start", warnings: [] });
					push({ type: "text-start", id: "t1" });
					for (const d of deltas) {
						await sleep(delayMs);
						push({ type: "text-delta", id: "t1", delta: d });
					}
					push({ type: "text-end", id: "t1" });
					push({
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: {
								total: 1,
								noCache: undefined,
								cacheRead: undefined,
								cacheWrite: undefined,
							},
							outputTokens: { total: deltas.length, text: undefined, reasoning: undefined },
						},
					});
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				},
			});
			return { stream };
		},
	} as unknown as LanguageModel;
}

let dirs: string[] = [];
let prevHome: string | undefined;
function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-app-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}
afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function setup(
	opts: {
		token?: string | undefined;
		wireApp?: boolean;
		deltas?: string[];
		delayMs?: number;
		transcribe?: AppChannelDeps["transcribe"];
		speak?: AppChannelDeps["speak"];
		titleFor?: AppChannelDeps["titleFor"];
	} = {},
) {
	const home = useHome();
	const store = openStore(join(home, "goblin.sqlite"));
	const runtime = new Runtime({
		store,
		buildStep: () => ({
			model: fakeModel(opts.deltas ?? ["hello", " app"], opts.delayMs),
			system: "test",
		}),
		makeTools: () => ({}),
	});
	const auth: Pick<AuthStore, "resolve"> = {
		resolve: (name) =>
			name === APP_TOKEN_NAME
				? Promise.resolve(APP_TOKEN_VALUE)
				: Promise.reject(new Error("no such auth record")),
	};
	const configRef: ConfigRef = {
		current: {
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
			},
			model: "zai/m",
			tts: false,
			favorites: [],
			thinking: "medium",
			allowedUsers: [42],
			telegram: { dmGapMinutes: 45 },
			http: { port: 0 },
			logLevel: "info",
			...(opts.token !== undefined ? { appToken: opts.token } : {}),
		} as Config,
		ttsDown: false,
	};
	const configWrites = { count: 0 };
	// Boot-time resolution, verbatim index.ts: the mode pins for the
	// life of this "process" — a configRef flip below must not reach it.
	const appTokenName = resolveAppAuth(opts.token);
	const appDeps: AppChannelDeps = {
		store,
		runtime,
		auth,
		configRef,
		onConfigWritten: () => {
			configWrites.count += 1;
		},
		...(opts.transcribe !== undefined ? { transcribe: opts.transcribe } : {}),
		...(opts.speak !== undefined ? { speak: opts.speak } : {}),
		...(opts.titleFor !== undefined ? { titleFor: opts.titleFor } : {}),
	};
	const http = startHttp({
		configRef,
		botToken: "test-bot-token",
		onConfigWritten: () => {},
		// The composition-root wiring, verbatim: the handler reaches this
		// module only through the opaque dep.
		...(opts.wireApp === false
			? {}
			: { appApi: (req: Request, url: URL) => handleAppApi(req, url, appTokenName, appDeps) }),
	});
	const call = (path: string, init: RequestInit = {}, bearer: string | null = APP_TOKEN_VALUE) =>
		fetch(`http://127.0.0.1:${http.port}${path}`, {
			...init,
			headers: {
				...(init.headers ?? {}),
				...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
			},
		});
	return { http, store, runtime, configRef, configWrites, call, home, appDeps };
}

// The minted conversation + one chat turn, drained — the shape every
// feature test below starts from.
async function createAndChat(
	call: (path: string, init?: RequestInit) => Promise<Response>,
	text = "hi",
	id = "chat-01",
) {
	await call("/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
	const res = await call("/api/app/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			conversationId: `app/${id}`,
			message: { id: "m1", role: "user", parts: [{ type: "text", text }] },
		}),
	});
	const sse = await res.text();
	return { res, sse };
}

describe("app channel browser-origin gate (trust mode, #75)", () => {
	// The attacker shape from the issue: a page on another origin in the
	// operator's own browser fires a no-cors POST (text/plain body — no
	// CORS preflight, response never read) at the tokenless app channel.
	// Bun's fetch sets no Origin/Sec-Fetch-Site of its own, so the plain
	// `call` helper elsewhere in this file is exactly the supported
	// non-browser client this gate must keep passing.
	const EVIL_ORIGIN = "http://attacker.local:1234";

	test("a cross-origin page cannot create conversations or submit turns", async () => {
		const { http, call, store } = setup({ token: undefined });
		try {
			// A legit (non-browser) client owns one conversation to aim at.
			expect(
				(
					await call(
						"/api/app/conversations",
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: "target-01" }),
						},
						null,
					)
				).status,
			).toBe(201);

			// Attacker-chosen id creation: text/plain so no preflight fires.
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
					body: JSON.stringify({ id: "pwned-01" }),
				},
				null,
			);
			expect(created.status).toBe(403);
			expect(store.get("app/pwned-01")).toBeNull();

			// The turn submission — the mutation that spends operator
			// authority on attacker-controlled input.
			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
					body: JSON.stringify({
						conversationId: "app/target-01",
						message: {
							id: "m-evil",
							role: "user",
							parts: [{ type: "text", text: "ATTACKER CONTROLLED INPUT" }],
						},
					}),
				},
				null,
			);
			expect(chat.status).toBe(403);
			await chat.text();
			// Nothing landed: no attacker turn in history.
			expect(store.history("app/target-01")).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("a browser on our own origin still mutates — direct loopback", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const origin = `http://127.0.0.1:${http.port}`;
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ id: "same-origin-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/same-origin-01",
						message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
					}),
				},
				null,
			);
			expect(chat.status).toBe(200);
			await chat.text();
		} finally {
			http.stop();
		}
	});

	test("a browser on the configured publicUrl origin passes behind a Host-rewriting front", async () => {
		const { http, call, configRef } = setup({ token: undefined });
		try {
			// tailscale serve rewrites Host to the local upstream
			// (docs/security.md) — the public origin is the match that
			// survives the proxy.
			configRef.current = {
				...configRef.current,
				publicUrl: "https://goblin.example.ts.net",
			} as Config;
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: "https://goblin.example.ts.net",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "front-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
		} finally {
			http.stop();
		}
	});

	test("a spoofed Host minting its own Origin match is refused (DNS rebinding)", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			// Attacker DNS points evil.example at our endpoint; both
			// Host and Origin name it — the old Host-echo made that
			// look same-origin. Only loopback Hosts may mint a match.
			const rebound = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						host: "evil.example:9999",
						origin: "http://evil.example:9999",
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "rebind-01" }),
				},
				null,
			);
			expect(rebound.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("an unrecognized Host-derived origin is refused once publicUrl is set", async () => {
		const { http, call, configRef } = setup({ token: undefined });
		try {
			configRef.current = {
				...configRef.current,
				publicUrl: "https://goblin.example.ts.net",
			} as Config;
			// The tailnet/local Host no longer mints its own match —
			// the pinned publicUrl is the only browser origin.
			const direct = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: {
						origin: `http://127.0.0.1:${http.port}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ id: "pinned-01" }),
				},
				null,
			);
			expect(direct.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("an opaque origin (null) and Sec-Fetch-Site: cross-site are refused", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const opaque = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: "null", "content-type": "application/json" },
					body: JSON.stringify({ id: "opaque-01" }),
				},
				null,
			);
			expect(opaque.status).toBe(403);
			// No Origin at all, but the browser fetch-metadata header says
			// cross-site — belt for the Origin check.
			const sfs = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
					body: JSON.stringify({ id: "sfs-01" }),
				},
				null,
			);
			expect(sfs.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("non-browser clients (no Origin, no Sec-Fetch-Site) pass in trust mode", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: "curl-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
		} finally {
			http.stop();
		}
	});

	test("JSON mutations must claim application/json — text/plain bodies refuse 415", async () => {
		const { http, call, store } = setup({ token: undefined });
		try {
			// A non-browser client (no Origin) with a text/plain body: the
			// origin gate has nothing to say — the content-type line does.
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: JSON.stringify({ id: "plain-01" }),
				},
				null,
			);
			expect(created.status).toBe(415);
			expect(store.get("app/plain-01")).toBeNull();
		} finally {
			http.stop();
		}
	});

	test("a cross-origin multipart upload is refused", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "evil.bin");
			const res = await call(
				"/api/app/attachments",
				{ method: "POST", headers: { origin: EVIL_ORIGIN }, body: form },
				null,
			);
			expect(res.status).toBe(403);
		} finally {
			http.stop();
		}
	});

	test("bearer mode is unaffected by browser origin — the token is the check", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { origin: EVIL_ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ id: "token-01" }),
				},
				// call() appends the valid bearer by default.
			);
			expect(created.status).toBe(201);
			// The content-type line still applies with a token, though.
			const plain = await call("/api/app/conversations", {
				method: "POST",
				headers: { origin: EVIL_ORIGIN, "content-type": "text/plain" },
				body: JSON.stringify({ id: "token-02" }),
			});
			expect(plain.status).toBe(415);
		} finally {
			http.stop();
		}
	});
});

describe("app channel http", () => {
	test("boot resolution logs the auth mode — trust mode warns about funnel", () => {
		const home = useHome();
		const logFile = join(home, "goblin.log");
		setLogFile(logFile);
		try {
			expect(resolveAppAuth(undefined)).toBeUndefined();
			expect(resolveAppAuth(APP_TOKEN_NAME)).toBe(APP_TOKEN_NAME);
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as { level: string; msg: string });
			expect(
				lines.some(
					(l) =>
						l.level === "warn" && l.msg === "app channel auth: trust mode (no token; tailnet only)",
				),
			).toBe(true);
			expect(lines.some((l) => l.level === "warn" && l.msg.includes("funnel"))).toBe(true);
			expect(
				lines.some((l) => l.level === "info" && l.msg === "app channel auth: token required"),
			).toBe(true);
		} finally {
			setLogFile(null);
		}
	});

	test("unset appToken is trust mode — /api/app/* serves unauthenticated", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			// No Authorization header at all — and a stray bearer is
			// ignored too: there is nothing to check it against.
			expect((await call("/api/app/conversations", {}, null)).status).toBe(200);
			expect((await call("/api/app/conversations", {}, "bogus")).status).toBe(200);
			const created = await call(
				"/api/app/conversations",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: "trust-01" }),
				},
				null,
			);
			expect(created.status).toBe(201);
			expect((await call("/api/app/conversations/trust-01/messages", {}, null)).status).toBe(200);
			const chat = await call(
				"/api/app/chat",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/trust-01",
						message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
					}),
				},
				null,
			);
			expect(chat.status).toBe(200);
			await chat.text();
		} finally {
			http.stop();
		}
	});

	test("an unwired surface refuses identically", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME, wireApp: false });
		try {
			const res = await call("/api/app/conversations");
			expect(res.status).toBe(503);
		} finally {
			http.stop();
		}
	});

	test("bearer auth gates every route — absent, wrong, right", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/conversations", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations", {}, "wrong-token")).status).toBe(401);
			expect((await call("/api/app/conversations")).status).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("the auth mode is boot-pinned — a mid-run appToken flip does not apply", async () => {
		const { http, call, configRef } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/conversations")).status).toBe(200);
			configRef.current = { ...configRef.current, appToken: undefined };
			// Live config now says trust, but the mode resolved at boot
			// owns the gate: bare requests stay refused until a restart.
			expect((await call("/api/app/conversations", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations")).status).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("create, list, and history ride the app pool only", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			// A telegram conversation in the same store must never surface.
			store.resolve({ kind: "dm", chatId: 99 }, "/w");
			const created = await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01", title: "First" }),
			});
			expect(created.status).toBe(201);
			const createdBody = (await created.json()) as { id: string; title: string | null };
			expect(createdBody.id).toBe("app/chat-01");
			expect(createdBody.title).toBe("First");

			const list = await call("/api/app/conversations");
			const listBody = (await list.json()) as { conversations: { id: string }[] };
			expect(listBody.conversations.map((c) => c.id)).toEqual(["app/chat-01"]);

			// Bad ids 404 — including a telegram-shaped id, which parses as an
			// app segment but resolves to nothing app-side.
			expect((await call("/api/app/conversations/dm-1/messages")).status).toBe(404);
			expect((await call("/api/app/conversations/../x/messages")).status).toBe(404);

			const messages = await call("/api/app/conversations/chat-01/messages");
			expect(messages.status).toBe(200);
			expect((await messages.json()) as { messages: unknown[] }).toEqual({ messages: [] });
		} finally {
			http.stop();
		}
	});

	test("chat submits a user message and streams UIMessage chunks as SSE", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
			expect(res.headers.get("content-type")).toContain("text/event-stream");

			const body = await res.text();
			const frames = body
				.split("\n\n")
				.filter((f) => f.startsWith("data: "))
				.map((f) => f.slice("data: ".length));
			expect(frames.at(-1)).toBe("[DONE]");
			const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as { type: string });
			const types = chunks.map((c) => c.type);
			expect(types).toContain("text-delta");
			expect(types).toContain("finish");

			// The turn landed in durable history — user + assistant.
			expect(store.history("app/chat-01").map((m) => m.role)).toEqual(["user", "assistant"]);
		} finally {
			http.stop();
		}
	});

	test("long silent stretches get SSE comment pings — the wire never idles out", async () => {
		// Bun.serve's default idleTimeout (10s) killed silent streams
		// mid-tool-call before the heartbeat existed (2026-10-07): the
		// browser's fetch body died with the wire. Slow deltas fake the
		// tool-call silence; the heartbeat must keep comment pings flowing
		// without polluting data frames.
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b"],
			delayMs: 6_000,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-ping" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-ping",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(200);
			const body = await res.text();
			// Comment keepalives rode the wire through the silence…
			expect(body).toContain(": ping\n\n");
			// …and stay invisible to data-frame parsing — exactly how the
			// client's eventsource parser skips them.
			const frames = body
				.split("\n\n")
				.filter((f) => f.startsWith("data: "))
				.map((f) => f.slice("data: ".length));
			expect(frames.at(-1)).toBe("[DONE]");
			const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as { type: string });
			expect(chunks.map((c) => c.type)).toContain("finish");
		} finally {
			http.stop();
		}
	}, 20_000);

	test("stop aborts a live turn — the stream ends with the error chunk", async () => {
		// 50ms deltas keep the turn alive well past the stop POST below.
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(chat.status).toBe(200);
			const stop = await call("/api/app/conversations/chat-01/stop", { method: "POST" });
			expect(stop.status).toBe(200);
			expect((await stop.json()) as { stopped: boolean }).toEqual({ stopped: true });
			// The fenced turn's stream ends with an error chunk + [DONE].
			const body = await chat.text();
			expect(body).toContain('"type":"error"');
			expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("stop on an idle or unknown conversation stays honest", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const idle = await call("/api/app/conversations/chat-01/stop", { method: "POST" });
			expect(idle.status).toBe(200);
			expect((await idle.json()) as { stopped: boolean }).toEqual({ stopped: false });
			expect((await call("/api/app/conversations/ghost/stop", { method: "POST" })).status).toBe(
				404,
			);
		} finally {
			http.stop();
		}
	});

	test("a data-attachment part must name a file the pipeline wrote", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = (ref: Record<string, unknown>) =>
				call("/api/app/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: "app/chat-01",
						message: { id: "m1", role: "user", parts: [{ type: "data-attachment", data: ref }] },
					}),
				});
			const base = { mediaType: "text/plain", filename: "x", size: 1 };
			// Outside the attachments dir outright, or escaping it through
			// a `..` segment — both would become readFile targets at turn
			// time.
			expect((await chat({ ...base, path: join(home, "goblin.sqlite") })).status).toBe(422);
			expect(
				(await chat({ ...base, path: join(home, "workspace", "attachments", "..", "evil") }))
					.status,
			).toBe(422);
			// A ref the upload endpoint minted passes the pin.
			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array([1, 2, 3])], { type: "text/plain" }),
				"note.txt",
			);
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: Record<string, unknown> };
			const ok = await chat(ref);
			expect(ok.status).toBe(200);
			expect((await ok.text()).trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("chat refuses a non-app conversation id and an unknown one", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "dm-99",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(res.status).toBe(422);
			const missing = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/ghost",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(missing.status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("multipart upload lands durably in workspace/attachments", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([1, 2, 3, 4, 5]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				ref: { path: string; mediaType: string; filename: string; size: number };
			};
			expect(body.ref.filename).toBe("shot.png");
			expect(body.ref.mediaType).toBe("image/png");
			expect(body.ref.size).toBe(5);
			expect(body.ref.path).toContain(join(home, "workspace", "attachments"));
			expect(readFileSync(body.ref.path)).toEqual(Buffer.from(bytes));
		} finally {
			http.stop();
		}
	});

	test("GET attachments/<name> serves stored bytes, confined to the dir", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([137, 80, 78, 71, 13]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: { path: string } };
			const name = ref.path.split("/").pop()!;

			const res = await call(`/api/app/attachments/${encodeURIComponent(name)}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			// Operator content serves inert: no shared caches, no sniffing,
			// a navigated document lands sandboxed.
			expect(res.headers.get("cache-control")).toContain("private");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes));

			// A path segment is a basename, not a route out of the dir —
			// traversal and dotfile temps refuse before touching disk.
			for (const bad of ["..%2F..%2Fconfig.json", ".deadbeef.tmp", "sub%2Ff.png"]) {
				expect((await call(`/api/app/attachments/${bad}`)).status).toBe(400);
			}
			expect((await call("/api/app/attachments/nope.png")).status).toBe(404);
			// Bearer-less in token mode is refused like every other route.
			expect((await call(`/api/app/attachments/${name}`, {}, null)).status).toBe(401);
		} finally {
			http.stop();
		}
	});

	test("an upload with no file part is a clean 400, nothing written", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const form = new FormData();
			form.append("note", "no file here");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(400);
			const attDir = join(home, "workspace", "attachments");
			const stat = statSync(attDir, { throwIfNoEntry: false });
			expect(stat === undefined || readdirSync(attDir).length === 0).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("GET stream: 204 when idle; replay + tail + [DONE] mid-turn", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 60,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			// No live turn: the SDK's reconnect contract expects 204 and
			// falls back to history.
			const idle = await call("/api/app/conversations/chat-01/stream");
			expect(idle.status).toBe(204);
			// Non-GET is refused.
			const wrongMethod = await call("/api/app/conversations/chat-01/stream", { method: "POST" });
			expect(wrongMethod.status).toBe(405);
			// Unknown conversation.
			const missing = await call("/api/app/conversations/nope/stream");
			expect(missing.status).toBe(404);
			// A live turn: attach mid-stream (deltas land every 60ms).
			const chatP = call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			await Bun.sleep(140);
			const res = await call("/api/app/conversations/chat-01/stream");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			const text = await res.text(); // resolves when the turn ends
			const events = text
				.split("\n\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice("data: ".length));
			expect(events.at(-1)).toBe("[DONE]");
			// The replay starts at the wire's first chunk — a reload sees
			// the reply from its beginning, not mid-sentence.
			expect(JSON.parse(events[0]!) as { type: string }).toMatchObject({ type: "start" });
			const types = events
				.filter((e) => e !== "[DONE]")
				.map((e) => (JSON.parse(e) as { type: string }).type);
			expect(types).toContain("text-delta");
			expect(types.filter((t) => t === "start")).toHaveLength(1); // no duplicate start from replay + tail
			await chatP;
		} finally {
			http.stop();
		}
	});

	// #79's server half: the client re-reads history when a reconnect
	// comes back idle, which is only sound because the 204 promises
	// durability — the runtime persists a turn's reply before it retires
	// the wire, so the moment the endpoint first says "nothing is live"
	// (after the turn was seen live), the completed answer is already in
	// the store. Pins that ordering at the HTTP boundary; a reorder
	// (append after the wire retires) opens a 204-without-reply window
	// this poll catches.
	test("the idle 204 never precedes durability — history holds the reply the moment the stream endpoint says nothing is live (#79)", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 25,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chatP = call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			let seenLive = false;
			let wentIdle = false;
			for (let i = 0; i < 500 && !wentIdle; i++) {
				const probe = await call("/api/app/conversations/chat-01/stream");
				if (probe.status === 200) {
					seenLive = true;
					await probe.body?.cancel(); // detach; keep polling
				} else if (probe.status === 204 && seenLive) {
					wentIdle = true;
				}
				if (!wentIdle) await Bun.sleep(5);
			}
			expect(seenLive).toBe(true);
			expect(wentIdle).toBe(true);
			const history = store.history("app/chat-01");
			expect(
				history.some(
					(m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text !== ""),
				),
			).toBe(true);
			await chatP;
		} finally {
			http.stop();
		}
	});

	test("rename writes an explicit title; empty or unknown ids refuse", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call);
			const res = await call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Renamed thread" }),
			});
			expect(res.status).toBe(200);
			expect((await res.json()) as { title: string }).toEqual({ title: "Renamed thread" });
			const conv = store.get("app/chat-01");
			expect(conv?.title).toBe("Renamed thread");
			// An operator title is explicit — the auto-title rule must
			// never overwrite it.
			expect(conv?.titleImplicit).toBe(false);

			const empty = await call("/api/app/conversations/chat-01", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "" }),
			});
			expect(empty.status).toBe(422);
			expect(
				(
					await call("/api/app/conversations/ghost", {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ title: "x" }),
					})
				).status,
			).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("delete removes the row, its events, and the FTS index", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call, "deletable-marker text");
			expect((await call("/api/app/search?q=deletable")).status).toBe(200);
			const hitsBefore = (await (await call("/api/app/search?q=deletable")).json()) as {
				hits: { conversationId: string }[];
			};
			expect(hitsBefore.hits.length).toBeGreaterThan(0);

			const res = await call("/api/app/conversations/chat-01", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(store.get("app/chat-01")).toBeNull();
			expect(store.history("app/chat-01")).toEqual([]);
			expect(store.listAppConversations()).toEqual([]);
			// The FTS delete triggers kept the index honest.
			const hitsAfter = (await (await call("/api/app/search?q=deletable")).json()) as {
				hits: { conversationId: string }[];
			};
			expect(hitsAfter.hits).toEqual([]);
			expect((await call("/api/app/conversations/ghost", { method: "DELETE" })).status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("delete fences a live turn before the row goes", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c", "d", "e"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			expect(chat.status).toBe(200);
			const del = await call("/api/app/conversations/chat-01", { method: "DELETE" });
			expect(del.status).toBe(200);
			expect(store.get("app/chat-01")).toBeNull();
			// The fenced turn's stream still terminates cleanly.
			const body = await chat.text();
			expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("search scopes to the app pool — telegram hits never leak", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			// Same term in both pools; only the app hit may come back.
			const tg = store.resolve({ kind: "dm", chatId: 99 }, "/w");
			store.append(tg.id, [
				{ id: "tg1", role: "user", parts: [{ type: "text", text: "needle in telegram" }] },
			]);
			await createAndChat(call, "needle in the app pool");

			const res = await call("/api/app/search?q=needle");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hits: { conversationId: string; role: string; text: string }[];
			};
			expect(body.hits.length).toBeGreaterThan(0);
			expect(body.hits.every((h) => h.conversationId.startsWith("app/"))).toBe(true);
			expect(body.hits.some((h) => h.text.includes("needle in the app pool"))).toBe(true);

			// A telegram-only term returns empty — the pool filter is on
			// the SQL side, not a post-filter that could under-fill.
			const tgOnly = (await (await call("/api/app/search?q=telegram")).json()) as {
				hits: unknown[];
			};
			expect(tgOnly.hits).toEqual([]);
			// Non-token queries are a clean empty, not a 500.
			expect((await call("/api/app/search?q=")).status).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("config GET reports the live knobs; POST patches model and thinking", async () => {
		const { http, call, configRef, configWrites, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const view = (await (await call("/api/app/config")).json()) as {
				model: string;
				thinking: string;
				favorites: string[];
				thinkingLevels: string[];
			};
			expect(view.model).toBe("zai/m");
			expect(view.thinking).toBe("medium");
			expect(view.thinkingLevels).toContain("medium");

			const write = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ thinking: "high" }),
			});
			expect(write.status).toBe(200);
			expect(configRef.current.thinking).toBe("high");
			expect(configWrites.count).toBe(1);
			// The write is durable — the file under GOBLIN_HOME carries it.
			expect(readFileSync(join(home, "goblin.json5"), "utf8")).toContain("'high'");

			const model = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "zai/m2" }),
			});
			expect(model.status).toBe(200);
			expect(configRef.current.model).toBe("zai/m2");

			// A ref naming an unconfigured provider fails validation.
			const badModel = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "ghost/x" }),
			});
			expect(badModel.status).toBe(422);
			// An empty patch and a bogus level are client bugs, not writes.
			expect(
				(
					await call("/api/app/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({}),
					})
				).status,
			).toBe(422);
			expect(
				(
					await call("/api/app/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ thinking: "ultra" }),
					})
				).status,
			).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("tts serves base64 chunks when speech is wired, 503s otherwise", async () => {
		const { http: h1, call: c1 } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await c1("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "read me" }),
			});
			expect(res.status).toBe(503);
		} finally {
			h1.stop();
		}

		const spoken = new Uint8Array([9, 8, 7]);
		const { http: h2, call: c2 } = setup({
			token: APP_TOKEN_NAME,
			speak: async () => [spoken],
		});
		try {
			const res = await c2("/api/app/tts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "read me" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { chunks: string[]; mediaType: string };
			expect(body.mediaType).toBe("audio/ogg");
			expect(body.chunks.map((c) => [...Buffer.from(c, "base64")])).toEqual([[9, 8, 7]]);
		} finally {
			h2.stop();
		}

		// A null return is "speech unavailable at runtime" — same 503.
		const { http: h3, call: c3 } = setup({ token: APP_TOKEN_NAME, speak: async () => null });
		try {
			expect(
				(
					await c3("/api/app/tts", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: "x" }),
					})
				).status,
			).toBe(503);
		} finally {
			h3.stop();
		}
	});

	test("the first turn auto-titles an unnamed conversation", async () => {
		const titled: string[] = [];
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			titleFor: async (text) => {
				titled.push(text);
				return "First Burst Title";
			},
		});
		try {
			await createAndChat(call, "what is the meaning of this");
			// titleFor fires beside the turn — poll briefly for the write.
			for (let i = 0; i < 50 && store.get("app/chat-01")?.title === null; i++) await sleep(10);
			const conv = store.get("app/chat-01");
			expect(conv?.title).toBe("First Burst Title");
			expect(conv?.titleImplicit).toBe(true);
			expect(titled).toEqual(["what is the meaning of this"]);
		} finally {
			http.stop();
		}
	});

	test("a preset title keeps titleFor out of the first turn", async () => {
		let calls = 0;
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			titleFor: async () => {
				calls += 1;
				return "implicit";
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01", title: "Named by hand" }),
			});
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			await res.text();
			await sleep(20);
			expect(calls).toBe(0);
			expect(store.get("app/chat-01")?.title).toBe("Named by hand");
		} finally {
			http.stop();
		}
	});

	test("a speech-flagged attachment gets its transcript before submit", async () => {
		const heard: { filename: string }[] = [];
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			transcribe: async (file) => {
				heard.push({ filename: file.filename });
				return "spoken words here";
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "note.ogg");
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: Record<string, unknown> };

			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: {
						id: "m1",
						role: "user",
						parts: [{ type: "data-attachment", data: { ...ref, speech: true } }],
					},
				}),
			});
			expect(res.status).toBe(200);
			await res.text();
			expect(heard).toEqual([{ filename: "note.ogg" }]);
			// The transcript rode into durable history with the ref.
			const stored = store.history("app/chat-01")[0]!;
			const part = stored.parts[0] as { type: string; data: { transcript?: string } };
			expect(part.data.transcript).toBe("spoken words here");
		} finally {
			http.stop();
		}
	});

	test("retry re-runs the newest user message without duplicating it", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			await createAndChat(call);
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(res.status).toBe(200);
			expect((await res.text()).trimEnd().endsWith("data: [DONE]")).toBe(true);
			// One user event, two anchored answers — history stays honest.
			const roles = store.history("app/chat-01").map((m) => m.role);
			expect(roles).toEqual(["user", "assistant", "assistant"]);
		} finally {
			http.stop();
		}
	});

	test("retry refuses an empty history and a live lane", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			deltas: ["a", "b", "c"],
			delayMs: 50,
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const empty = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(empty.status).toBe(409);

			const chat = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
				}),
			});
			const busy = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversationId: "app/chat-01", retry: true }),
			});
			expect(busy.status).toBe(409);
			await call("/api/app/conversations/chat-01/stop", { method: "POST" });
			await chat.text();

			// retry:true with a message attached is a client bug, not a turn.
			expect(
				(
					await call("/api/app/chat", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							conversationId: "app/chat-01",
							retry: true,
							message: { id: "m2", role: "user", parts: [{ type: "text", text: "x" }] },
						}),
					})
				).status,
			).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("a failed transcription keeps the attachment and the turn runs", async () => {
		const { http, call, store } = setup({
			token: APP_TOKEN_NAME,
			transcribe: () => Promise.reject(new Error("stt down")),
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01" }),
			});
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array([1])], { type: "audio/ogg" }), "n.ogg");
			const { ref } = (await (
				await call("/api/app/attachments", { method: "POST", body: form })
			).json()) as { ref: Record<string, unknown> };
			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/chat-01",
					message: {
						id: "m1",
						role: "user",
						parts: [{ type: "data-attachment", data: { ...ref, speech: true } }],
					},
				}),
			});
			expect(res.status).toBe(200);
			expect((await res.text()).trimEnd().endsWith("data: [DONE]")).toBe(true);
			const stored = store.history("app/chat-01")[0]!;
			const part = stored.parts[0] as { data: { transcript?: string; path: string } };
			expect(part.data.transcript).toBeUndefined();
			expect(part.data.path).toBe(String(ref.path));
		} finally {
			http.stop();
		}
	});
});

test("conversation settings are isolated, durable, validated, and only future chats use changed app defaults", async () => {
	const { http, call, store, configRef, configWrites, home } = setup();
	const patch = (path: string, body: unknown) =>
		call(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		// Legacy row never read through settings: changing defaults still
		// freezes it against the previous selection before writing.
		const legacy = store.resolve(appAddress("legacy-settings"), "/work");
		const create = (id: string) =>
			call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
		await create("settings-a");
		await create("settings-b");
		const a = "/api/app/conversations/settings-a/config";
		const epoch = store.get("app/settings-a")!.epoch;
		expect((await patch(a, { model: "zai/personal", thinking: "high" })).status).toBe(200);
		expect(store.get("app/settings-a")!.epoch).toBe(epoch);
		expect(configWrites.count).toBe(0);
		expect(store.get("app/settings-b")).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect((await patch(a, { model: "missing/x" })).status).toBe(422);
		expect((await patch(a, { model: "bare" })).status).toBe(422);
		expect((await patch(a, { thinking: "invalid" })).status).toBe(422);
		expect((await patch(a, {})).status).toBe(422);
		expect(
			(await patch("/api/app/conversations/not-created/config", { model: "zai/x" })).status,
		).toBe(404);
		expect(store.get("app/not-created")).toBeNull();
		store.resolve({ kind: "dm", chatId: 42 }, "/work");
		expect((await patch("/api/app/conversations/dm%3A42/config", { model: "zai/x" })).status).toBe(
			404,
		);
		expect(
			(await patch("/api/app/conversations/app%2Fsettings-a/config", { model: "zai/x" })).status,
		).toBe(404);
		expect((await patch("/api/app/config", { model: "zai/future", thinking: "low" })).status).toBe(
			200,
		);
		expect(configRef.current.telegram).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect(store.get(legacy.id)).toMatchObject({ model: "zai/m", thinking: "medium" });
		await create("settings-future");
		await create("settings-a"); // idempotent create never resets settings
		expect(store.get("app/settings-future")).toMatchObject({
			model: "zai/future",
			thinking: "low",
		});
		const view = await (await call(a)).json();
		expect(view).toMatchObject({
			model: "zai/personal",
			thinking: "high",
			favorites: [],
			thinkingLevels: expect.any(Array),
		});
		store.close();
		const reopened = openStore(join(home, "goblin.sqlite"));
		try {
			expect(reopened.get("app/settings-a")).toMatchObject({
				model: "zai/personal",
				thinking: "high",
			});
		} finally {
			reopened.close();
		}
	} finally {
		http.stop();
	}
});

test("conversation PATCH rechecks the live registry and row after awaiting its request body", async () => {
	const { http, store, configRef, appDeps } = setup();
	const row = store.resolve(appAddress("held-config"), "/work", configRef.current);
	async function heldPatch(body: unknown, mutate: () => void): Promise<Response> {
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const waiting = new Promise<void>((r) => {
			release = r;
		});
		const reading = new Promise<void>((r) => {
			entered = r;
		});
		class HeldRequest extends Request {
			override json = async (): Promise<unknown> => {
				entered();
				await waiting;
				return body;
			};
		}
		const url = new URL("http://localhost/api/app/conversations/held-config/config");
		const pending = handleAppApi(
			new HeldRequest(url.href, {
				method: "PATCH",
				// The route's wire contract: JSON mutations must claim
				// application/json (#75) — the held json() below is reached
				// only past that line.
				headers: { "content-type": "application/json" },
			}),
			url,
			undefined,
			appDeps,
		);
		await reading;
		mutate();
		release();
		return pending;
	}
	try {
		configRef.current.providers.other = { kind: "codex" };
		expect(
			(
				await heldPatch({ model: "other/chat" }, () => {
					delete configRef.current.providers.other;
				})
			).status,
		).toBe(422);
		expect(store.get(row.id)!.model).toBe("zai/m");
		expect(
			(await heldPatch({ thinking: "high" }, () => store.deleteConversation(row.id))).status,
		).toBe(404);
		expect(store.get(row.id)).toBeNull();
	} finally {
		http.stop();
		store.close();
	}
});
