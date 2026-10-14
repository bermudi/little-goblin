import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ConfigPostBody } from "../../src/http/operator-wire.ts";
import {
	ApiError,
	clearToken,
	forgetMemoryDocument,
	getConfig,
	getConversationConfig,
	getMessages,
	getOperatorConfig,
	listMemoryDocuments,
	loadToken,
	NoteConflictError,
	patchConfig,
	patchNote,
	patchConversationConfig,
	restoreNoteVersion,
	saveOperatorConfig,
	saveToken,
} from "./api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

// sessionStorage, not localStorage — /t/ and /app/ are one origin, so
// this only narrows exposure (the credential dies with the tab), it
// does not isolate; pinning the scope here so a casual revert to
// localStorage has to argue with a test.
describe("token store", () => {
	const win = new Window();
	const originalSession = globalThis.sessionStorage;

	beforeEach(() => {
		win.sessionStorage.clear();
		Reflect.set(globalThis, "sessionStorage", win.sessionStorage);
	});

	afterEach(() => {
		if (originalSession !== undefined) globalThis.sessionStorage = originalSession;
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	});

	test("the token round-trips through session storage and clears clean", () => {
		expect(loadToken()).toBeNull();
		saveToken("tok-1");
		expect(loadToken()).toBe("tok-1");
		expect(win.sessionStorage.getItem("goblin.appToken")).toBe("tok-1");
		clearToken();
		expect(loadToken()).toBeNull();
		expect(win.sessionStorage.getItem("goblin.appToken")).toBeNull();
	});
});

describe("model setting scopes", () => {
	test("conversation controls address only that conversation, not app defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(new URL(String(input), "http://localhost"), init));
				return Response.json({
					model: "test/chat",
					thinking: "high",
					favorites: [],
					thinkingLevels: ["high"],
				});
			},
			{ preconnect: originalFetch.preconnect },
		);
		await getConversationConfig(null, "app/chat-1");
		const changed = await patchConversationConfig(null, "app/chat-1", {
			model: "test/chat",
			thinking: "high",
		});
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/conversations/chat-1/config", "GET"],
			["/api/app/conversations/chat-1/config", "PATCH"],
		]);
		expect(await requests[1]!.json()).toEqual({ model: "test/chat", thinking: "high" });
		expect(changed.model).toBe("test/chat");
	});

	test("start-screen controls still address new-chat defaults", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(new URL(String(input), "http://localhost"), init));
				return Response.json({
					model: "test/default",
					thinking: "low",
					favorites: [],
					thinkingLevels: ["low"],
				});
			},
			{ preconnect: originalFetch.preconnect },
		);
		await getConfig(null);
		await patchConfig(null, { model: "test/default" });
		expect(requests.map((req) => [new URL(req.url).pathname, req.method])).toEqual([
			["/api/app/config", "GET"],
			["/api/app/config", "POST"],
		]);
	});

	test("a rejected conversation save surfaces the server error", async () => {
		globalThis.fetch = Object.assign(
			async () => Response.json({ error: "unknown provider" }, { status: 422 }),
			{ preconnect: originalFetch.preconnect },
		);
		await expect(patchConversationConfig(null, "app/chat", { model: "missing/m" })).rejects.toThrow(
			"unknown provider",
		);
		await expect(getConversationConfig(null, "app/missing")).rejects.toBeInstanceOf(ApiError);
	});
});

describe("operator surface", () => {
	const fakeFetch = (handler: (req: Request) => Response | Promise<Response>) => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const req = new Request(new URL(String(input), "http://localhost"), init);
				requests.push(req);
				return handler(req);
			},
			{ preconnect: originalFetch.preconnect },
		);
		return requests;
	};

	test("the settings GET returns the response's etag alongside the body", async () => {
		fakeFetch(
			() =>
				new Response(
					JSON.stringify({ config: {}, providerKinds: [], searchKinds: [], fetchKinds: [] }),
					{
						status: 200,
						headers: { "content-type": "application/json", etag: '"v1"' },
					},
				),
		);
		const { data, etag } = await getOperatorConfig(null);
		expect(etag).toBe('"v1"');
		expect(data.providerKinds).toEqual([]);
	});

	test("the settings POST sends If-Match and returns the rotated etag", async () => {
		const requests = fakeFetch((req) => {
			expect(req.headers.get("if-match")).toBe('"v1"');
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json", etag: '"v2"' },
			});
		});
		const body: ConfigPostBody = {
			providers: {},
			model: "p/m",
			titleModel: "",
			favorites: [],
			thinking: "medium",
			tts: "",
			transcription: "",
			vision: "",
			search: "",
			fetch: "",
			operators: [1],
			allowedUsers: [1],
			telegram: { apiRoot: "", dmGapMinutes: 45 },
			publicUrl: "",
			http: { port: 8787 },
			memory: "",
			logLevel: "info",
		};
		const { etag } = await saveOperatorConfig("tok", body, '"v1"');
		expect(etag).toBe('"v2"');
		expect(new URL(requests[0]!.url).pathname).toBe("/api/app/settings");
		expect(requests[0]!.method).toBe("POST");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer tok");
	});

	test("memory documents take a query string; forget deletes", async () => {
		const requests = fakeFetch(() => Response.json({ items: [], total: 0, limit: 20, offset: 40 }));
		await listMemoryDocuments(null, { q: "weather", limit: 20, offset: 40 });
		const url = new URL(requests[0]!.url);
		expect(url.pathname).toBe("/api/app/memory/documents");
		expect(url.searchParams.get("q")).toBe("weather");
		expect(url.searchParams.get("offset")).toBe("40");

		const forgets = fakeFetch(() => Response.json({ ok: true, cancelled: 0, redacted: 1 }));
		const res = await forgetMemoryDocument(null, "doc-1");
		expect(res.ok).toBe(true);
		expect(forgets[0]!.method).toBe("DELETE");
		expect(new URL(forgets[0]!.url).pathname).toBe("/api/app/memory/documents/doc-1");
	});
});

// The Telegram door (design/telegram.md → Mini Apps): served under /t/,
// operator requests rewrite /api/app/* to the identically-named /api/*
// tails and ride x-init-data instead of a bearer token.
describe("telegram door", () => {
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalWindow !== undefined) globalThis.window = originalWindow;
		else Reflect.deleteProperty(globalThis, "window");
	});

	// happy-dom window installed as the global — the door reads
	// window.location.pathname per request, and Telegram's injected
	// payload is stubbed on the same window.
	function mountAt(path: string): Window {
		const win = new Window({ url: `http://localhost${path}` });
		Reflect.set(win, "Telegram", {
			WebApp: { initData: "user=%7B%22id%22%3A111%7D&hash=abc" },
		});
		Reflect.set(globalThis, "window", win);
		return win;
	}

	const SETTINGS_OK = () =>
		new Response(
			JSON.stringify({ config: {}, providerKinds: [], searchKinds: [], fetchKinds: [] }),
			{
				status: 200,
				headers: { "content-type": "application/json", etag: '"v1"' },
			},
		);

	test("operator calls rewrite to /api/* and carry x-init-data instead of a bearer token", async () => {
		mountAt("/t/settings");
		const requests: Request[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(new URL(String(input), "http://localhost"), init));
			return SETTINGS_OK();
		}) as typeof fetch;
		await getOperatorConfig(null);
		expect(new URL(requests[0]!.url).pathname).toBe("/api/settings");
		expect(requests[0]!.headers.get("x-init-data")).toBe("user=%7B%22id%22%3A111%7D&hash=abc");
		expect(requests[0]!.headers.get("authorization")).toBeNull();
	});

	test("the app door keeps its paths and never sprouts the header", async () => {
		const win = mountAt("/app/settings");
		Reflect.deleteProperty(win, "Telegram");
		const requests: Request[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(new URL(String(input), "http://localhost"), init));
			return SETTINGS_OK();
		}) as typeof fetch;
		await getOperatorConfig("tok");
		expect(new URL(requests[0]!.url).pathname).toBe("/api/app/settings");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer tok");
		expect(requests[0]!.headers.get("x-init-data")).toBeNull();
	});

	test("chat routes rewrite too — they exist only on the app door, so a telegram-door mount fails loudly (404), not silently", async () => {
		mountAt("/t/settings");
		const requests: Request[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(new URL(String(input), "http://localhost"), init));
			return Response.json({ messages: [] });
		}) as typeof fetch;
		await getMessages(null, "app/chat-1");
		expect(new URL(requests[0]!.url).pathname).toBe("/api/conversations/chat-1/messages");
	});
});

// restoreNoteVersion is a content write — the caller's live rev rides
// If-Match, and a stale one decodes into the same conflict the editor
// gets from a PATCH.
describe("restoreNoteVersion", () => {
	const NOTE = {
		id: "n-1",
		projectId: null,
		title: "t",
		body: "x",
		rev: 8,
		stateRev: 8,
		lastSource: "app",
		pinnedAt: null,
		archivedAt: null,
		createdAt: "x",
		updatedAt: "x",
	};

	test("sends expectedRev as If-Match and returns the restored note", async () => {
		const seen: Request[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(new Request(new URL(String(input), "http://localhost"), init));
			return Response.json(NOTE);
		}) as typeof fetch;
		const restored = await restoreNoteVersion("tok", "n-1", 3, 7);
		expect(restored.rev).toBe(8);
		expect(seen[0]!.method).toBe("POST");
		expect(new URL(seen[0]!.url).pathname).toBe("/api/app/notes/n-1/versions/3/restore");
		expect(seen[0]!.headers.get("if-match")).toBe('"7"');
		expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok");
	});

	test("a 409 decodes the live note into NoteConflictError", async () => {
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ error: "conflict", note: NOTE }, { status: 409 })) as typeof fetch;
		try {
			await restoreNoteVersion(null, "n-1", 3, 7);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(NoteConflictError);
			expect((err as NoteConflictError).note.rev).toBe(8);
		}
	});
});

// patchNote's keepalive is best effort: past the portable 64KiB bound
// the flag is dropped and the body still leaves whole — the durable
// draft is the recovery path for big edits.
describe("patchNote keepalive bound", () => {
	const NOTE = {
		id: "n-1",
		projectId: null,
		title: "t",
		body: "x",
		rev: 2,
		stateRev: 2,
		lastSource: "app",
		pinnedAt: null,
		archivedAt: null,
		createdAt: "x",
		updatedAt: "x",
	};
	const capture = (): { init: RequestInit | undefined; body: string }[] => {
		const seen: { init: RequestInit | undefined; body: string }[] = [];
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push({ init, body: String(init?.body) });
			return Response.json(NOTE);
		}) as typeof fetch;
		return seen;
	};

	test("an >80KiB body omits keepalive but sends every byte — ASCII and multibyte", async () => {
		const seen = capture();
		const big = "x".repeat(80 * 1024);
		await patchNote(null, "n-1", { body: big }, { keepalive: true });
		expect(seen[0]!.init?.keepalive).not.toBe(true);
		expect((JSON.parse(seen[0]!.body) as { body: string }).body).toBe(big);

		// 30Ki multibyte chars ≈ 90KiB UTF-8 — the cap is bytes, not chars.
		const multi = "日".repeat(30 * 1024);
		await patchNote(null, "n-1", { body: multi }, { keepalive: true });
		expect(seen[1]!.init?.keepalive).not.toBe(true);
		expect((JSON.parse(seen[1]!.body) as { body: string }).body).toBe(multi);
	});

	test("a small opt-in still rides keepalive; no opt-in stays ordinary", async () => {
		const seen = capture();
		await patchNote(null, "n-1", { body: "small" }, { keepalive: true });
		expect(seen[0]!.init?.keepalive).toBe(true);
		await patchNote(null, "n-1", { body: "small" });
		expect(seen[1]!.init?.keepalive).not.toBe(true);
	});
});
