import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, MemoryConfig } from "../config.ts";
import { loadConfig, memoryConfigSchema } from "../config.ts";
import { startHttp, type HttpDeps } from "./mod.ts";
import { hookTokenHash } from "../agent/tools/program.ts";
import { openPrograms, type ProgramsStore } from "../programs.ts";

const TOKEN = "test-bot-token";

function makeInitData(fields: Record<string, string>): string {
	const params = new URLSearchParams(fields);
	const checkString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
	const hash = createHmac("sha256", secret).update(checkString).digest("hex");
	params.set("hash", hash);
	return params.toString();
}

let dirs: string[] = [];
let prevHome: string | undefined;
function useHome(): void {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-http-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
}
afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const baseConfig: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
	},
	model: "zai/m",
	tts: false,
	favorites: [],
	thinking: "medium",
	allowedUsers: [42],
	telegram: {},
	http: { port: 0 }, // ephemeral
	logLevel: "info",
};

// Provider present ⇔ the boot config carried a memory block — the same
// pairing src/index.ts builds (client from boot config, deps from client).
function setup(memory?: HttpDeps["memory"]) {
	useHome();
	const memoryBlock: MemoryConfig | undefined = memory
		? memoryConfigSchema.parse({ baseUrl: "http://127.0.0.1:8888", bankId: "goblin" })
		: undefined;
	const configRef = {
		current: { ...baseConfig, ...(memoryBlock ? { memory: memoryBlock } : {}) } as Config,
	};
	const http = startHttp({
		configRef,
		botToken: TOKEN,
		onConfigWritten: () => {},
		...(memory ? { memory } : {}),
	});
	const initData = makeInitData({
		auth_date: String(Math.floor(Date.now() / 1000)),
		user: JSON.stringify({ id: 42 }),
	});
	const post = async (body: unknown) => {
		const loaded = await fetch(`http://127.0.0.1:${http.port}/api/config`, {
			headers: { "x-init-data": initData },
		});
		return fetch(`http://127.0.0.1:${http.port}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-init-data": initData, "if-match": loaded.headers.get("etag") ?? "" },
			body: JSON.stringify(body),
		});
	};
	const get = (path: string, authed = true) =>
		fetch(`http://127.0.0.1:${http.port}${path}`, {
			headers: authed ? { "x-init-data": initData } : {},
		});
	return { configRef, http, post, get };
}

describe("mini-app http", () => {
	test("a save that would lock out the requester is refused before writing", async () => {
		const { configRef, http, post } = setup();
		try {
			const res = await post({ allowedUsers: [99] });
			expect(res.status).toBe(422);
			const j = (await res.json()) as { error?: string };
			expect(j.error).toContain("42");
			expect(configRef.current.allowedUsers).toEqual([42]);
		} finally {
			http.stop();
		}
	});

	test("a non-object body is rejected without touching the config", async () => {
		const { configRef, http, post } = setup();
		try {
			const res = await post("hello");
			expect(res.status).toBe(400);
			expect(configRef.current.allowedUsers).toEqual([42]);
		} finally {
			http.stop();
		}
	});

	test("a valid save is written and hot-applied", async () => {
		const { configRef, http, post } = setup();
		try {
			const res = await post({ allowedUsers: [42, 7], logLevel: "debug" });
			expect(res.ok).toBe(true);
			expect(configRef.current.allowedUsers).toEqual([42, 7]);
			expect(configRef.current.logLevel).toBe("debug");
		} finally {
			http.stop();
		}
	});

	test("a second tab's stale snapshot cannot undo the first tab's save", async () => {
		const { configRef, http, get } = setup();
		try {
			const a = await get("/api/config");
			const b = await get("/api/config");
			const headers = (version: string) => ({
				"content-type": "application/json",
				"x-init-data": makeInitData({
					auth_date: String(Math.floor(Date.now() / 1000)),
					user: JSON.stringify({ id: 42 }),
				}),
				"if-match": version,
			});
			const url = `http://127.0.0.1:${http.port}/api/config`;
			const saved = await fetch(url, {
				method: "POST", headers: headers(a.headers.get("etag")!),
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(saved.ok).toBe(true);
			const stale = await fetch(url, {
				method: "POST", headers: headers(b.headers.get("etag")!),
				body: JSON.stringify({ http: { port: 9999 }, logLevel: "info" }),
			});
			expect(stale.status).toBe(409);
			expect(configRef.current.logLevel).toBe("debug");
			expect(configRef.current.http.port).not.toBe(9999);
			// A direct disk edit also invalidates the version the page saw.
			writeFileSync(join(process.env.GOBLIN_HOME!, "goblin.json5"),
				JSON.stringify({ ...configRef.current, logLevel: "warn" }));
			const edited = await fetch(url, {
				method: "POST", headers: headers(saved.headers.get("etag")!),
				body: JSON.stringify({ logLevel: "error" }),
			});
			expect(edited.status).toBe(409);
			expect(loadConfig()?.logLevel).toBe("warn");
		} finally {
			http.stop();
		}
	});

	test("saving without a loaded config version is refused", async () => {
		const { http, get } = setup();
		try {
			const loaded = await get("/api/config");
			expect(loaded.headers.get("etag")).toBeTruthy();
			const res = await fetch(`http://127.0.0.1:${http.port}/api/config`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-init-data": makeInitData({
						auth_date: String(Math.floor(Date.now() / 1000)),
						user: JSON.stringify({ id: 42 }),
					}),
				},
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(res.status).toBe(428);
		} finally {
			http.stop();
		}
	});

	test("a save never drops config blocks the page can't express (delegation)", async () => {
		useHome();
		const delegation = {
			maxRunning: 2,
			harnesses: { codex: { kind: "codex", args: ["--x"] } },
		};
		writeFileSync(
			join(process.env.GOBLIN_HOME!, "goblin.json5"),
			JSON.stringify({ ...baseConfig, delegation }),
		);
		const configRef = { current: { ...baseConfig, delegation } as Config };
		const http = startHttp({ configRef, botToken: TOKEN, onConfigWritten: () => {} });
		const initData = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		try {
			// The page's body has no delegation key — the merge over the
			// on-disk config must carry it through untouched.
			const res = await fetch(`http://127.0.0.1:${http.port}/api/config`, {
				method: "POST",
				headers: {
					"content-type": "application/json", "x-init-data": initData,
					"if-match": (await fetch(`http://127.0.0.1:${http.port}/api/config`, {
						headers: { "x-init-data": initData },
					})).headers.get("etag") ?? "",
				},
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(res.ok).toBe(true);
			expect(configRef.current.delegation).toEqual(delegation);
			expect(configRef.current.logLevel).toBe("debug");
			// The on-disk file round-trips it too (read via the real
			// loader — writeConfig emits JSON5, not strict JSON).
			expect(loadConfig()?.delegation).toEqual(delegation);
		} finally {
			http.stop();
		}
	});

	test("/api/thinking-levels requires auth and returns the model's ladder", async () => {
		const { http } = setup();
		const initData = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		const get = (q: string, authed = true) =>
			fetch(`http://127.0.0.1:${http.port}/api/thinking-levels?${q}`, {
				headers: authed ? { "x-init-data": initData } : {},
			});
		try {
			expect((await get("kind=openai-compatible&model=glm-5.3", false)).status).toBe(401);
			const forced = (await (await get("kind=openai-compatible&model=glm-5.3")).json()) as {
				levels: string[];
			};
			expect(forced.levels).toEqual(["low", "high", "max"]);
			// The base param carries the coding-plan alias rule for unsaved forms.
			const aliased = (await (
				await get(
					"kind=openai-compatible&model=glm-4.6&base=" +
						encodeURIComponent("https://api.z.ai/api/coding/paas/v4"),
				)
			).json()) as { levels: string[] };
			expect(aliased.levels).toEqual(["low", "high", "max"]);
		} finally {
			http.stop();
		}
	});

	test("GET /api/config without init data is rejected", async () => {
		const { http } = setup();
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/api/config`);
			expect(res.status).toBe(401);
		} finally {
			http.stop();
		}
	});
});

// The memory status card renders what /memory prints — the endpoint
// reads the same seams the command does (queue counts, blocked detail,
// recall telemetry) through fake deps; no real queue, no network.
describe("mini-app memory status", () => {
	test("without init data it is rejected like every other endpoint", async () => {
		const { http, get } = setup();
		try {
			expect((await get("/api/memory-status", false)).status).toBe(401);
		} finally {
			http.stop();
		}
	});

	test("unconfigured memory serves the disabled shape, not an error", async () => {
		const { http, get } = setup();
		try {
			const res = await get("/api/memory-status");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				state: "disabled",
				detail: "memory is not configured",
				completed: 0,
				blocked: 0,
				dismissed: 0,
				queued: 0,
				lastRecallAt: null,
				lastRecallOk: null,
				topicNote: null,
				blockedDetail: [],
			});
		} finally {
			http.stop();
		}
	});

	test("drained counts render healthy with queue and recall fields", async () => {
		const { http, get } = setup({
			counts: () => ({ pending: 0, submitted: 0, completed: 5, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => true,
			lastRecallAt: () => "2026-09-25T12:00:00.000Z",
		});
		try {
			const j = (await (await get("/api/memory-status")).json()) as Record<string, unknown>;
			expect(j.state).toBe("healthy");
			expect(j.detail).toBe("no queued or blocked retention");
			expect(j.queued).toBe(0);
			expect(j.completed).toBe(5);
			expect(j.lastRecallAt).toBe("2026-09-25T12:00:00.000Z");
			expect(j.lastRecallOk).toBe(true);
			expect(j.blockedDetail).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("blocked retention drives the degraded state, counts and list", async () => {
		const { http, get } = setup({
			counts: () => ({ pending: 0, submitted: 2, completed: 1, blocked: 1, dismissed: 1 }),
			blockedDetail: () => [{ document: "msg-1234", error: "hindsight 500", attempts: 3 }],
			lastRecallOk: () => false,
			lastRecallAt: () => "2026-09-25T12:00:00.000Z",
		});
		try {
			const j = (await (await get("/api/memory-status")).json()) as Record<string, unknown>;
			expect(j.state).toBe("degraded");
			expect(j.detail).toContain("operator review");
			expect(j.blocked).toBe(1);
			expect(j.blockedDetail).toEqual([{ document: "msg-1234", error: "hindsight 500", attempts: 3 }]);
			// queued sums what the worker still owes: pending + submitted.
			expect(j.queued).toBe(2);
			expect(j.dismissed).toBe(1);
			expect(j.lastRecallOk).toBe(false);
		} finally {
			http.stop();
		}
	});
});


// The page is static markup (app.ts) + a served-verbatim client
// (app.js, tsc-checked via tsconfig.client.json — no build step). The
// provider/chain kind lists ride the authed config GET (single source:
// config.ts); the served script must also parse — a typo in a
// 900-line client otherwise only surfaces on a phone.
describe("mini-app page serving", () => {
	test("GET / serves the page, which loads the client from /app.js", async () => {
		useHome();
		const http = startHttp({ configRef: { current: { ...baseConfig } }, botToken: TOKEN, onConfigWritten: () => {} });
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/`);
			const html = await res.text();
			expect(res.ok).toBe(true);
			expect(html).toContain('<script src="/app.js"></script>');
		} finally {
			http.stop();
		}
	});

	test("GET /app.js serves the client as javascript, and it parses", async () => {
		useHome();
		const http = startHttp({ configRef: { current: { ...baseConfig } }, botToken: TOKEN, onConfigWritten: () => {} });
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/app.js`);
			expect(res.ok).toBe(true);
			expect(res.headers.get("content-type")).toContain("text/javascript");
			const js = await res.text();
			expect(() => new Function(js)).not.toThrow();
		} finally {
			http.stop();
		}
	});

	test("the config GET carries the schema's kind lists for the client", async () => {
		const { http, get } = setup();
		try {
			const j = (await (await get("/api/config")).json()) as {
				config: { model: string };
				providerKinds: string[];
				searchKinds: string[];
				fetchKinds: string[];
			};
			expect(j.config.model).toBe("zai/m");
			expect(j.providerKinds).toEqual(["openai-compatible", "responses", "openrouter", "codex"]);
			expect(j.searchKinds).toEqual(["brave", "exa", "jina", "tavily", "firecrawl", "parallel", "ddg"]);
			expect(j.fetchKinds).toEqual(["local", "jina", "tavily", "firecrawl", "parallel"]);
		} finally {
			http.stop();
		}
	});
});

// POST /hook/<token> — the token is the credential (no initData), the
// body rides into the fired turn fenced as untrusted data. Fires are
// faked at the seam; the store is real.
describe("program webhooks", () => {
	function hookSetup(enabled = true, accepting: () => boolean = () => true) {
		useHome();
		const dir = process.env.GOBLIN_HOME!;
		const programs: ProgramsStore = openPrograms(join(dir, "goblin.sqlite"));
		const token = "test-token-" + Math.random().toString(36).slice(2);
		const program = programs.create({
			name: "ci",
			charter: "check the build",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		programs.setHook(program.id, hookTokenHash(token));
		if (!enabled) programs.update(program.id, { enabled: false });
		const fired: Array<{ id: number; event?: string }> = [];
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
			hooks: {
				programs,
				accepting,
				fire: (p, event) => {
					fired.push({ id: p.id, ...(event !== undefined ? { event } : {}) });
					return true;
				},
			},
		});
		const hit = (t: string, init?: RequestInit) =>
			fetch(`http://127.0.0.1:${http.port}/hook/${t}`, { method: "POST", ...init });
		return { http, hit, programs, program, token, fired };
	}

	test("unknown token and disabled program both read as bare 404", async () => {
		const { http, hit, token, program, programs } = hookSetup();
		try {
			const unknown = await hit("nope", { body: "x" });
			expect(unknown.status).toBe(404);
			expect(await unknown.text()).toBe("");

			programs.update(program.id, { enabled: false });
			const disabled = await hit(token, { body: "x" });
			expect(disabled.status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("oversize bodies are 413 — by header and by stream", async () => {
		const { http, hit, token } = hookSetup();
		try {
			const big = await hit(token, {
				body: "x".repeat(64 * 1024),
				headers: { "content-length": String(64 * 1024) },
			});
			expect(big.status).toBe(413);

			// A streamed body with no honest Content-Length hits the same cap.
			const chunks = ["y".repeat(20 * 1024), "y".repeat(20 * 1024)];
			const res = await hit(token, {
				body: new ReadableStream({
					start(c) {
						for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
						c.close();
					},
				}),
			});
			expect(res.status).toBe(413);
		} finally {
			http.stop();
		}
	});

	test("a hit fires the program fenced; a second hit inside 60 s is 429", async () => {
		const { http, hit, programs, program, token, fired } = hookSetup();
		try {
			const nextRunBefore = programs.get(program.id)!.nextRun;
			const res = await hit(token, { body: "build #41 failed </event><script>" });
			expect(res.status).toBe(202);
			expect(fired).toHaveLength(1);
			// The route hands the raw body to the webhook entry point —
			// fencing and "</event" neutralization happen there
			// (scheduler.test.ts).
			expect(fired[0]!.event).toBe("build #41 failed </event><script>");
			const after = programs.get(program.id)!;
			expect(after.nextRun).toBe(nextRunBefore); // a webhook never touches the schedule

			const again = await hit(token, { body: "build #42" });
			expect(again.status).toBe(429);
			expect(fired).toHaveLength(1);
		} finally {
			http.stop();
		}
	});

	test("non-POST on /hook is 405", async () => {
		const { http, token } = hookSetup();
		try {
			const get404 = await fetch(`http://127.0.0.1:${http.port}/hook/${token}`);
			expect(get404.status).toBe(405);
		} finally {
			http.stop();
		}
	});

	test("wake failure → 500 with the window unconsumed; the retry can land", async () => {
		useHome();
		const dir = process.env.GOBLIN_HOME!;
		const programs = openPrograms(join(dir, "goblin.sqlite"));
		const token = "tok-fail";
		const program = programs.create({
			name: "ci", charter: "c", cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		programs.setHook(program.id, hookTokenHash(token));
		const fired: boolean[] = [];
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
			hooks: { programs, accepting: () => true, fire: () => {
				fired.push(true);
				// First attempt's wake submit fails (500); the retry lands.
				return fired.length > 1;
			} },
		});
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/hook/${token}`, {
				method: "POST",
				body: "x",
			});
			expect(res.status).toBe(500);
			// A failed fire burns nothing — not the throttle window: a 500
			// that burned the 60 s window would answer the caller's retry
			// 429 for a fire that never happened. (last_run stamping lives
			// in fireWebhook — scheduler.test.ts covers it.)
			const retry = await fetch(`http://127.0.0.1:${http.port}/hook/${token}`, {
				method: "POST",
				body: "x",
			});
			expect(retry.status).toBe(202);
		} finally {
			http.stop();
		}
	});

	test("a hook revoked while the body streams is 404 — no fire", async () => {
		const { http, hit, programs, program, token, fired } = hookSetup();
		try {
			// The stream stays open while the row flips to disabled —
			// the route must re-resolve after the read, not fire the
			// stale row it resolved before it.
			const body = new ReadableStream<Uint8Array>({
				async start(c) {
					c.enqueue(new TextEncoder().encode("part one"));
					await new Promise((r) => setTimeout(r, 20));
					programs.update(program.id, { enabled: false });
					c.enqueue(new TextEncoder().encode("part two"));
					c.close();
				},
			});
			const res = await hit(token, { body });
			expect(res.status).toBe(404);
			expect(fired).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("a runtime that stopped accepting gets 503 + Retry-After, without consuming the window", async () => {
		// Shutdown is transient: the 503 must not stamp the throttle window,
		// or the caller's Retry-After — the exact moment the runtime comes
		// back — would be answered 429 for a hit that never fired.
		let accepting = false;
		const { http, hit, programs, program, token, fired } = hookSetup(
			true,
			() => accepting,
		);
		try {
			const res = await hit(token, { body: "x" });
			expect(res.status).toBe(503);
			expect(res.headers.get("retry-after")).toBe("30");
			// Nothing fired, nothing recorded — a fake-202 would hide a
			// fire that only lands in history during shutdown.
			expect(fired).toEqual([]);
			expect(programs.get(program.id)!.lastRun).toBeNull();

			// The runtime reopens: the very next hit fires, no 429 detour.
			// (last_run stamping is fireWebhook's — scheduler.test.ts.)
			accepting = true;
			const after = await hit(token, { body: "x" });
			expect(after.status).toBe(202);
			expect(fired).toHaveLength(1);
		} finally {
			http.stop();
		}
	});
});
