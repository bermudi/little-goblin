import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, MemoryConfig } from "../config.ts";
import { loadConfig, memoryConfigSchema } from "../config.ts";
import { setLogFile } from "../log.ts";
import { startHttp, type HttpDeps } from "./mod.ts";
import { hookTokenHash } from "../agent/tools/program.ts";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { appAddress, openStore, prepareAppSettingsForConfig } from "../conversation.ts";

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
	telegram: { dmGapMinutes: 45 },
	http: { port: 0 }, // ephemeral
	logLevel: "info",
};

// Provider present ⇔ the boot config carried a memory block — the same
// pairing src/index.ts builds (client from boot config, deps from client).
function setup(memory?: HttpDeps["memory"], beforeConfigWritten?: HttpDeps["beforeConfigWritten"]) {
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
		...(beforeConfigWritten ? { beforeConfigWritten } : {}),
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
			headers: {
				"content-type": "application/json",
				"x-init-data": initData,
				"if-match": loaded.headers.get("etag") ?? "",
			},
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
	test("an unexpected handler throw is a logged 500, not a framework error page", async () => {
		useHome();
		const logFile = join(process.env.GOBLIN_HOME!, "goblin.log");
		setLogFile(logFile);
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
			appApi: async () => {
				throw new Error("handler exploded");
			},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/api/app/anything`);
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ error: "internal" });
			// The trap's whole point: the failure lands in goblin.log with
			// the request's shape — a framework-default 500 on stderr
			// cannot be correlated with a screenshot of the symptom.
			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as { level: string; msg: string; path?: string });
			const trap = lines.find((l) => l.msg === "http request failed");
			expect(trap?.level).toBe("error");
			expect(trap?.path).toBe("/api/app/anything");
		} finally {
			http.stop();
			setLogFile(null);
		}
	});
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

	test("app-default edits pin legacy Telegram settings, then Telegram edits stay independent", async () => {
		const { configRef, http, post } = setup();
		try {
			expect((await post({ model: "zai/app-new", thinking: "low" })).status).toBe(200);
			expect(configRef.current.telegram.model).toBe("zai/m");
			expect(configRef.current.telegram.thinking).toBe("medium");
			expect(
				(await post({ telegram: { model: "zai/telegram-new", thinking: "high" } })).status,
			).toBe(200);
			expect(configRef.current.model).toBe("zai/app-new");
			expect(configRef.current.thinking).toBe("low");
			expect(configRef.current.telegram.dmGapMinutes).toBe(45);
			const saved = loadConfig()!;
			expect(saved.telegram.model).toBe("zai/telegram-new");
			expect(saved.telegram.thinking).toBe("high");
		} finally {
			http.stop();
		}
	});

	test("a Telegram model naming an unknown provider is rejected without writing", async () => {
		const { configRef, http, post } = setup();
		try {
			expect((await post({ telegram: { model: "missing/m" } })).status).toBe(422);
			expect(configRef.current.model).toBe("zai/m");
			expect(loadConfig()).toBeNull();
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
				method: "POST",
				headers: headers(a.headers.get("etag")!),
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(saved.ok).toBe(true);
			const stale = await fetch(url, {
				method: "POST",
				headers: headers(b.headers.get("etag")!),
				body: JSON.stringify({ http: { port: 9999 }, logLevel: "info" }),
			});
			expect(stale.status).toBe(409);
			expect(configRef.current.logLevel).toBe("debug");
			expect(configRef.current.http.port).not.toBe(9999);
			// A direct disk edit also invalidates the version the page saw.
			writeFileSync(
				join(process.env.GOBLIN_HOME!, "goblin.json5"),
				JSON.stringify({ ...configRef.current, logLevel: "warn" }),
			);
			const edited = await fetch(url, {
				method: "POST",
				headers: headers(saved.headers.get("etag")!),
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

	test("a post-write apply failure reports that the settings were saved, not invalid", async () => {
		useHome();
		const configRef = { current: { ...baseConfig } };
		const http = startHttp({
			configRef,
			botToken: TOKEN,
			onConfigWritten: () => {
				throw new Error("apply failed");
			},
		});
		const auth = makeInitData({
			auth_date: String(Math.floor(Date.now() / 1000)),
			user: JSON.stringify({ id: 42 }),
		});
		try {
			const url = `http://127.0.0.1:${http.port}/api/config`;
			const loaded = await fetch(url, { headers: { "x-init-data": auth } });
			const saved = await fetch(url, {
				method: "POST",
				headers: {
					"x-init-data": auth,
					"content-type": "application/json",
					"if-match": loaded.headers.get("etag")!,
				},
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(saved.status).toBe(500);
			expect(((await saved.json()) as { error: string }).error).toContain("were saved");
			expect(loadConfig()?.logLevel).toBe("debug");
		} finally {
			http.stop();
		}
	});

	test("a save never drops config blocks the page can't express (delegation)", async () => {
		useHome();
		const delegation = {
			machines: { g7: { machine: "g7", root: "~/build" } },
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
					"content-type": "application/json",
					"x-init-data": initData,
					"if-match":
						(
							await fetch(`http://127.0.0.1:${http.port}/api/config`, {
								headers: { "x-init-data": initData },
							})
						).headers.get("etag") ?? "",
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
	test("a changed memory destination never displays the boot target's status", async () => {
		const mem: NonNullable<HttpDeps["memory"]> = {
			target: { baseUrl: "http://127.0.0.1:8888", bankId: "goblin" },
			counts: () => ({ pending: 2, submitted: 0, completed: 1, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => true,
			lastRecallAt: () => null,
		};
		const { http, get, configRef } = setup(mem);
		try {
			configRef.current = {
				...configRef.current,
				memory: { ...configRef.current.memory!, bankId: "elsewhere" },
			};
			const status = (await (await get("/api/memory-status")).json()) as {
				detail: string;
				queued: number;
			};
			expect(status.detail).toContain("restart");
			expect(status.queued).toBe(0);
		} finally {
			http.stop();
		}
	});
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
			expect(j.blockedDetail).toEqual([
				{ document: "msg-1234", error: "hindsight 500", attempts: 3 },
			]);
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
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
		});
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/`);
			const html = await res.text();
			expect(res.ok).toBe(true);
			expect(html).toContain('<script src="/app.js"></script>');
			expect(html).toContain("Shared by all Telegram conversations.");
			expect(html).toContain("New app conversations only.");
			expect(html).toContain('id="telegramModelBtn"');
			expect(html).toContain('id="telegramThinkingSeg"');
		} finally {
			http.stop();
		}
	});

	test("GET /app.js serves the client as javascript, and it parses", async () => {
		useHome();
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
		});
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
			expect(j.searchKinds).toEqual([
				"brave",
				"exa",
				"jina",
				"tavily",
				"firecrawl",
				"parallel",
				"ddg",
			]);
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
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		programs.setHook(program.id, hookTokenHash(token));
		const fired: boolean[] = [];
		const http = startHttp({
			configRef: { current: { ...baseConfig } },
			botToken: TOKEN,
			onConfigWritten: () => {},
			hooks: {
				programs,
				accepting: () => true,
				fire: () => {
					fired.push(true);
					// First attempt's wake submit fails (500); the retry lands.
					return fired.length > 1;
				},
			},
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
		const { http, hit, programs, program, token, fired } = hookSetup(true, () => accepting);
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

// ---------- memories browser ----------
import {
	HindsightError,
	type HindsightClient,
	type MemoryDocPage,
	type MemoryDocSummary,
	type MemoryFact,
	type StoredMemoryDocument,
} from "../hindsight.ts";
import type { MemoryContexts } from "../memory.ts";
import type { MemoryQueue } from "../memory-queue.ts";

function stubClient(): HindsightClient {
	return {
		listDocuments: () => Promise.reject(new Error("not stubbed")),
		listMemories: () => Promise.reject(new Error("not stubbed")),
		getDocument: () => Promise.reject(new Error("not stubbed")),
		operation: () => Promise.reject(new Error("not stubbed")),
		deleteDocument: () => Promise.reject(new Error("not stubbed")),
	} as unknown as HindsightClient;
}

describe("mini-app memories browser", () => {
	test("list requires init data, honors the boot-target gate, and serves pages", async () => {
		const page: MemoryDocPage<MemoryDocSummary> = {
			items: [
				{
					id: "exchange/topic:1:2/3/abc",
					created_at: "2026-09-30T01:14:46.511505+00:00",
					updated_at: "2026-09-30T01:14:46.511505+00:00",
					text_length: 2453,
					memory_unit_count: 3,
					document_metadata: { conversation_id: "topic:1:2" },
				},
			],
			total: 37,
			limit: 25,
			offset: 0,
		};
		const calls: string[] = [];
		const client = stubClient();
		client.listDocuments = (o) => {
			calls.push(`q=${"q" in o ? o.q : null} ${o.limit}@${o.offset}`);
			return Promise.resolve(page);
		};
		const mem: NonNullable<HttpDeps["memory"]> = {
			target: { baseUrl: "http://127.0.0.1:8888", bankId: "goblin" },
			counts: () => ({ pending: 0, submitted: 0, completed: 0, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => null,
			lastRecallAt: () => null,
			client,
		};
		const { http, get, configRef } = setup(mem);
		try {
			expect((await get("/api/memory/documents", false)).status).toBe(401);
			// Same authed path; gate passes (config matches boot target).
			const ok = await get("/api/memory/documents?limit=25&offset=0");
			expect(ok.status).toBe(200);
			const body = (await ok.json()) as {
				total: number;
				items: Array<{ conversationId: string | null }>;
			};
			expect(body.total).toBe(37);
			expect(body.items[0]?.conversationId).toBe("topic:1:2");
			expect(calls[0]).toBe("q=null 25@0");
			// q filter rides through.
			await get("/api/memory/documents?q=topic%3A1&limit=10&offset=5");
			expect(calls[1]).toBe("q=topic:1 10@5");
			// Re-pointed config degrades to the reason, never reads the stale bank.
			configRef.current = {
				...configRef.current,
				memory: { ...configRef.current.memory!, bankId: "elsewhere" },
			};
			const stale = await get("/api/memory/documents");
			expect(stale.status).toBe(503);
			expect(((await stale.json()) as { error: string }).error).toContain("restart");
		} finally {
			http.stop();
		}
	});

	test("bad page params are a 422, and upstream failures map to the chat command's line", async () => {
		const client = stubClient();
		const { http, get } = setup({
			counts: () => ({ pending: 0, submitted: 0, completed: 0, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => null,
			lastRecallAt: () => null,
			client,
		});
		try {
			expect((await get("/api/memory/documents?limit=0")).status).toBe(422);
			expect((await get("/api/memory/documents?limit=abc")).status).toBe(422);
			expect((await get("/api/memory/documents?offset=-1")).status).toBe(422);
			client.listDocuments = () => Promise.reject(new HindsightError("http", 500));
			const res = await get("/api/memory/documents");
			expect(res.status).toBe(503);
			expect(((await res.json()) as { error: string }).error).toContain("memory unavailable");
		} finally {
			http.stop();
		}
	});

	test("document detail serves original text and facts; unknown ids 404", async () => {
		const doc: StoredMemoryDocument = {
			id: "exchange/topic:1:2/3/abc",
			bank_id: "goblin",
			original_text: "Operator: hi\nGoblin: hello",
			created_at: "2026-09-30T01:14:46.511505+00:00",
			updated_at: "2026-09-30T01:14:46.511505+00:00",
			memory_unit_count: 2,
		};
		const facts: MemoryDocPage<MemoryFact> = {
			items: [
				{
					id: "f1",
					text: "The operator says hello.",
					fact_type: "experience",
					document_id: doc.id,
					state: "invalidated",
					date: null,
					mentioned_at: "2026-09-30T01:14:28Z",
					occurred_start: null,
					occurred_end: null,
					entities: null,
					context: null,
				},
			],
			total: 1,
			limit: 200,
			offset: 0,
		};
		const client = stubClient();
		client.getDocument = (id) => Promise.resolve(id === doc.id ? doc : null);
		client.listMemories = () => Promise.resolve(facts);
		const { http, get } = setup({
			counts: () => ({ pending: 0, submitted: 0, completed: 0, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => null,
			lastRecallAt: () => null,
			client,
		});
		try {
			const res = await get("/api/memory/documents/exchange%2Ftopic%3A1%3A2%2F3%2Fabc");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				document: { id: string; factCount: number };
				originalText: string | null;
				facts: Array<{ state: string | null }>;
			};
			expect(body.document.id).toBe(doc.id);
			expect(body.originalText).toBe(doc.original_text);
			expect(body.facts[0]?.state).toBe("invalidated");
			expect((await get("/api/memory/documents/exchange%2Fmissing")).status).toBe(404);
			// Malformed percent-encoding must land on the same 404 contract —
			// decodeURIComponent throws URIError on these, which used to
			// escape the handler as a generic 500.
			expect((await get("/api/memory/documents/%E0%A4%A")).status).toBe(404);
			expect((await get("/api/memory/documents/%")).status).toBe(404);
		} finally {
			http.stop();
		}
	});

	test("forget runs the shared protocol and reports the outcome; status-only wiring refuses", async () => {
		const deleted: string[] = [];
		const suppressed: string[] = [];
		const cancelled: string[] = [];
		const client = stubClient();
		client.deleteDocument = (id) => {
			deleted.push(id);
			return Promise.resolve();
		};
		const contexts = {
			suppress: (id: string) => suppressed.push(id),
			deleteByDocument: (id: string) => {
				cancelled.push(id);
				return 2;
			},
		} as unknown as MemoryContexts;
		const queue = {
			documentDestinations: () => [],
			cancelDocument: (id: string) => {
				cancelled.push(`cancel:${id}`);
				return 1;
			},
		} as unknown as MemoryQueue;
		const paused: boolean[] = [];
		const mem: NonNullable<HttpDeps["memory"]> = {
			counts: () => ({ pending: 0, submitted: 0, completed: 0, blocked: 0, dismissed: 0 }),
			blockedDetail: () => [],
			lastRecallOk: () => null,
			lastRecallAt: () => null,
			client,
			contexts,
			queue,
			withWorkerPaused: async (fn) => {
				paused.push(true);
				return fn();
			},
		};
		const { http, get } = setup(mem);
		const del = (path: string, authed = true) =>
			fetch(`http://127.0.0.1:${http.port}${path}`, {
				method: "DELETE",
				headers: authed
					? {
							"x-init-data": makeInitData({
								auth_date: String(Math.floor(Date.now() / 1000)),
								user: JSON.stringify({ id: 42 }),
							}),
						}
					: {},
			});
		try {
			const res = await del("/api/memory/documents/exchange%2Ftopic%3A1%3A2%2F3%2Fabc");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean; cancelled: number; redacted: number };
			expect(body).toEqual({ ok: true, cancelled: 1, redacted: 2 });
			expect(deleted).toEqual(["exchange/topic:1:2/3/abc"]);
			expect(suppressed).toEqual(["exchange/topic:1:2/3/abc"]);
			expect(paused).toEqual([true]);
			// Status-only wiring (no forget seams) refuses loudly, not 500.
			const { http: http2, get: get2 } = setup({
				counts: () => ({ pending: 0, submitted: 0, completed: 0, blocked: 0, dismissed: 0 }),
				blockedDetail: () => [],
				lastRecallOk: () => null,
				lastRecallAt: () => null,
			});
			try {
				const refused = await get2("/api/memory/documents/exchange%2Fmissing");
				expect(refused.status).toBe(503);
				expect(((await refused.json()) as { error: string }).error).toContain("not wired");
			} finally {
				http2.stop();
			}
		} finally {
			http.stop();
		}
	});
});

// The spin-off deep link (design/app.md → Spin-off → Links):
// /app/c/<appId> serves the same client shell as /app/ — same
// no-store, same fail-loud-500 when the build is missing — and an id
// that fails the appIdSchema shape is a 404, never an error page.
describe("app deep link (Spin-off)", () => {
	// The dist dir is build output — absent on a checkout before
	// `bun run app:build`, which is exactly the loud-500 path.
	const distExists = existsSync(join(import.meta.dir, "..", "..", "app", "dist"));

	// #105: /app is the shell itself, never a redirect — `url.origin`
	// is the Host the backend saw, and any door that rewrites Host to
	// the loopback target (nginx default, some tailscale serve configs)
	// turned {publicUrl}/app into a bounce to a dead
	// http://127.0.0.1:PORT/.
	test("the /app convenience route serves the client shell directly, no redirect", async () => {
		const { http } = setup();
		try {
			// redirect: manual — a followed 302 would mask the bounce the
			// test exists to catch.
			const res = await fetch(`http://127.0.0.1:${http.port}/app`, { redirect: "manual" });
			// What the deep-link routes do: the shell or the loud 500 —
			// never a 30x that re-derives the origin.
			expect([200, 500]).toContain(res.status);
			expect(res.headers.get("location")).toBeNull();
			if (res.status === 200) {
				expect(res.headers.get("content-type")).toContain("text/html");
				expect(res.headers.get("cache-control")).toBe("no-store");
				expect(await res.text()).toContain("<html");
			} else {
				expect(((await res.json()) as { error: string }).error).toContain("app client not built");
			}
		} finally {
			http.stop();
		}
	});

	test("a valid id serves the client shell", async () => {
		const { http, get } = setup();
		try {
			const res = await get("/app/c/spun-1_valid");
			if (distExists) {
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toContain("text/html");
				expect(res.headers.get("cache-control")).toBe("no-store");
				expect(await res.text()).toContain("<html");
			} else {
				// Same fail-loud contract as /app/ — never a silent page.
				expect(res.status).toBe(500);
				expect(((await res.json()) as { error: string }).error).toContain("app client not built");
			}
		} finally {
			http.stop();
		}
	});

	test("malformed ids are 404 — the schema shape is the whole gate", async () => {
		const { http, get } = setup();
		try {
			// Leading punctuation fails the first-char rule.
			expect((await get("/app/c/-bad")).status).toBe(404);
			// A decoded space is not in the charset.
			expect((await get("/app/c/not%20valid")).status).toBe(404);
			// The empty segment and an over-long id fail the same way.
			expect((await get("/app/c/")).status).toBe(404);
			expect((await get(`/app/c/${"x".repeat(65)}`)).status).toBe(404);
			// An extra path segment isn't part of the id.
			expect((await get("/app/c/valid/extra")).status).toBe(404);
		} finally {
			http.stop();
		}
	});
});

test("mini-app default saves freeze untouched legacy app settings before updating defaults", async () => {
	const store = openStore(":memory:");
	const legacy = store.resolve(appAddress("untouched"), "/work");
	const { http, post, configRef } = setup(undefined, (previous) => {
		for (const conv of store.listAppConversations()) store.initializeAppSettings(conv.id, previous);
	});
	try {
		expect((await post({ model: "zai/future", thinking: "low", publicUrl: "" })).status).toBe(200);
		expect(store.get(legacy.id)).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect(configRef.current.model).toBe("zai/future");
		expect(configRef.current.telegram.model).toBe("zai/m");
	} finally {
		http.stop();
		store.close();
	}
});

test("provider removal refuses to strand app selections, lists affected ids, and writes nothing", async () => {
	const store = openStore(":memory:");
	const legacy = store.resolve(appAddress("legacy-provider"), "/work");
	const pinned = store.resolve(appAddress("pinned-provider"), "/work", {
		model: "zai/personal",
		thinking: "high",
	});
	const { http, post, configRef } = setup(undefined, (previous, next) =>
		prepareAppSettingsForConfig(store, previous, next),
	);
	try {
		const proposed = {
			providers: { replacement: { kind: "codex" } },
			model: "replacement/chat",
			telegram: { model: "replacement/chat" },
		};
		const refused = await post(proposed);
		expect(refused.status).toBe(422);
		const detail = await refused.text();
		expect(detail).toContain(legacy.id);
		expect(detail).toContain(pinned.id);
		expect(loadConfig()).toBeNull();
		expect(store.get(legacy.id)!.model).toBeNull();
		expect(configRef.current.model).toBe("zai/m");
		// Move both selections first; the same provider removal can save.
		store.setMeta(legacy.id, { model: "replacement/chat", thinking: "low" });
		store.setMeta(pinned.id, { model: "replacement/chat", thinking: "high" });
		expect((await post(proposed)).status).toBe(200);
	} finally {
		http.stop();
		store.close();
	}
});
