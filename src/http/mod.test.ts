import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, MemoryConfig } from "../config.ts";
import { memoryConfigSchema } from "../config.ts";
import { startHttp, type HttpDeps } from "./mod.ts";

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
	const post = (body: unknown) =>
		fetch(`http://127.0.0.1:${http.port}/api/config`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-init-data": initData },
			body: JSON.stringify(body),
		});
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
				pending: 0,
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
			expect(j.pending).toBe(0);
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

// The page's client-side zod parse fetches the vendored ESM tree from
// the process's own node_modules — the route must serve it, and only
// it.
describe("vendored zod", () => {
	test("serves zod's published esm entry as javascript", async () => {
		const { http } = setup();
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/vendor/zod/v4/index.js`);
			expect(res.ok).toBe(true);
			expect(res.headers.get("content-type")).toContain("text/javascript");
			expect(await res.text()).toContain("export");
		} finally {
			http.stop();
		}
	});

	test("is confined to js files inside the package", async () => {
		const { http } = setup();
		try {
			const base = `http://127.0.0.1:${http.port}`;
			expect((await fetch(`${base}/vendor/zod/package.json`)).status).toBe(404);
			expect((await fetch(`${base}/vendor/zod/v4/index.cjs`)).status).toBe(404);
			expect((await fetch(`${base}/vendor/zod/v4/no-such-file.js`)).status).toBe(404);
			// Encoded traversal stays a literal pathname segment and fails
		// the charset guard; URL parsing collapses plain ../.
			expect((await fetch(`${base}/vendor/zod/%2e%2e/goblin.json5`)).status).toBe(404);
		} finally {
			http.stop();
		}
	});
});

// The provider/chain kind lists are served from the schema (single
// source in config.ts) — the page must carry the injected arrays, not
// stale copies or unreplaced placeholders. The inline script must also
// parse — a template-literal typo in a 1000-line page string otherwise
// only surfaces on a phone.
describe("mini-app page serving", () => {
	test("GET / serves the schema's kind lists, placeholders replaced", async () => {
		useHome();
		const http = startHttp({ configRef: { current: { ...baseConfig } }, botToken: TOKEN, onConfigWritten: () => {} });
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/`);
			const html = await res.text();
			expect(html).toContain('const KINDS = ["openai-compatible","openrouter","codex"];');
			expect(html).toContain(
				'const SEARCH_KINDS = ["brave","exa","jina","tavily","firecrawl","parallel","ddg"];',
			);
			expect(html).toContain('const FETCH_KINDS = ["local","jina","tavily","firecrawl","parallel"];');
			expect(html).not.toContain("__PROVIDER_KINDS__");
			expect(html).not.toContain("__SEARCH_KINDS__");
			expect(html).not.toContain("__FETCH_KINDS__");
		} finally {
			http.stop();
		}
	});

	test("the page's inline script parses", async () => {
		useHome();
		const http = startHttp({ configRef: { current: { ...baseConfig } }, botToken: TOKEN, onConfigWritten: () => {} });
		try {
			const html = await (await fetch(`http://127.0.0.1:${http.port}/`)).text();
			const start = html.lastIndexOf("<script>");
			const end = html.lastIndexOf("</script>");
			expect(start).toBeGreaterThan(0);
			expect(end).toBeGreaterThan(start);
			expect(() => new Function(html.slice(start + "<script>".length, end))).not.toThrow();
		} finally {
			http.stop();
		}
	});
});
