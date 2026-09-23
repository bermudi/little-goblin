import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { startHttp } from "./mod.ts";

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

function setup() {
	useHome();
	const configRef = { current: { ...baseConfig } };
	const http = startHttp({ configRef, botToken: TOKEN, onConfigWritten: () => {} });
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
	return { configRef, http, post };
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

// The provider-kind list is served from the schema (single source in
// config.ts) — the page must carry the injected array, not a stale
// copy or an unreplaced placeholder.
describe("mini-app page serving", () => {
	test("GET / serves the schema's provider kinds, placeholder replaced", async () => {
		useHome();
		const http = startHttp({ configRef: { current: { ...baseConfig } }, botToken: TOKEN, onConfigWritten: () => {} });
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/`);
			const html = await res.text();
			expect(html).toContain('const KINDS = ["openai-compatible","openrouter","codex"];');
			expect(html).not.toContain("__PROVIDER_KINDS__");
		} finally {
			http.stop();
		}
	});
});
