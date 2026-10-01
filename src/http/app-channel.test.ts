import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Config } from "../config.ts";
import { openStore, type ConversationStore } from "../conversation.ts";
import { Runtime } from "../runtime.ts";
import type { AuthStore } from "../auth.ts";
import { startHttp } from "./mod.ts";
import { handleAppApi } from "./app-channel.ts";

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
							inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
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

function setup(opts: { token?: string | undefined; wireApp?: boolean; deltas?: string[] } = {}) {
	const home = useHome();
	const store = openStore(join(home, "goblin.sqlite"));
	const runtime = new Runtime({
		store,
		buildStep: () => ({ model: fakeModel(opts.deltas ?? ["hello", " app"]), system: "test" }),
		makeTools: () => ({}),
	});
	const auth: Pick<AuthStore, "resolve"> = {
		resolve: (name) =>
			name === APP_TOKEN_NAME ? Promise.resolve(APP_TOKEN_VALUE) : Promise.reject(new Error("no such auth record")),
	};
	const configRef = {
		current: {
			providers: { zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" } },
			model: "zai/m",
			tts: false,
			favorites: [],
			thinking: "medium",
			allowedUsers: [42],
			telegram: {},
			http: { port: 0 },
			logLevel: "info",
			...(opts.token !== undefined ? { appToken: opts.token } : {}),
		} as Config,
	};
	const appDeps = { store, runtime, auth };
	const http = startHttp({
		configRef,
		botToken: "test-bot-token",
		onConfigWritten: () => {},
		// The composition-root wiring, verbatim: the handler reaches this
		// module only through the opaque dep.
		...(opts.wireApp === false
			? {}
			: { appApi: (req: Request, url: URL, tok: string | undefined) => handleAppApi(req, url, tok, appDeps) }),
	});
	const call = (path: string, init: RequestInit = {}, bearer: string | null = APP_TOKEN_VALUE) =>
		fetch(`http://127.0.0.1:${http.port}${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}) },
		});
	return { http, store, runtime, configRef, call, home };
}

describe("app channel http", () => {
	test("unset appToken refuses every /api/app/* request", async () => {
		const { http, call } = setup({ token: undefined });
		try {
			for (const [method, path] of [
				["GET", "/api/app/conversations"],
				["POST", "/api/app/conversations"],
				["POST", "/api/app/chat"],
			] as const) {
				const res = await call(path, { method });
				expect(res.status).toBe(503);
			}
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

	test("token removal takes effect without a restart", async () => {
		const { http, call, configRef } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/conversations")).status).toBe(200);
			configRef.current = { ...configRef.current, appToken: undefined };
			expect((await call("/api/app/conversations")).status).toBe(503);
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
});
