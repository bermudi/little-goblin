import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig, memoryConfigSchema } from "../config.ts";
import { openDelegations } from "../delegations.ts";
import { setLogFile } from "../log.ts";
import { HindsightClient } from "../memory/hindsight.ts";
import { openPrograms } from "../programs.ts";
import { SkillSources } from "../skill-provenance.ts";
import { useHome } from "../testkit.ts";
import { handleAppApi, resolveAppAuth } from "./app-channel.ts";
import { APP_TOKEN_NAME, APP_TOKEN_VALUE, setup } from "./app-testing.ts";
import { startHttp } from "./mod.ts";
import type { OperatorDeps } from "./operator.ts";
import type { MemoriesListResponse, ThreadSkillItem } from "./operator-wire.ts";

describe("app channel http", () => {
	test("boot resolution logs the auth mode — trust mode warns about funnel", () => {
		const home = useHome("goblin-app-");
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
			expect((await call("/api/app/conversations", {}, null)).status).toBe(401);
			expect((await call("/api/app/conversations")).status).toBe(200);
		} finally {
			http.stop();
		}
	});
});

function stubMemory(extra: Partial<NonNullable<OperatorDeps["memory"]>> = {}) {
	return {
		target: { baseUrl: "http://127.0.0.1:8888", bankId: "goblin" },
		counts: () => ({
			pending: 0,
			submitted: 0,
			completed: 3,
			blocked: 0,
			dismissed: 0,
			deleting: 0,
		}),
		deletingAll: () => 0,
		blockedDetail: () => [],
		lastRecallOk: () => true,
		lastRecallAt: () => "2026-10-09T00:00:00.000Z",
		...extra,
	};
}

describe("app operator surface — state viewer mounts (ruling 2026-10-11)", () => {

	test("all six tails answer through the real door wiring", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME, operator: {} });
		try {
			mkdirSync(join(home, "workspace/skills/weather"), { recursive: true });
			writeFileSync(join(home, "workspace/skills/weather/SKILL.md"), "weather body");
			mkdirSync(join(home, "workspace"), { recursive: true });
			writeFileSync(join(home, "workspace/SOUL.md"), "# soul");
			mkdirSync(join(home, "workspace/attachments"), { recursive: true });
			writeFileSync(join(home, "workspace/attachments/pic.png"), "PNG");
			mkdirSync(join(home, "state"), { recursive: true });
			writeFileSync(
				join(home, "state/goblin.log"),
				`${JSON.stringify({ ts: "t", level: "info", msg: "hey" })}\n`,
			);

			const catalogResponse = await call("/api/app/skills");
			expect(catalogResponse.status).toBe(200);
			const catalog = (await catalogResponse.json()) as {
				skills: Array<{ name: string; files: string[] }>;
			};
			const skill = catalog.skills[0]!;
			const query = new URLSearchParams({ name: skill.name, path: skill.files[0]! });
			const file = await call(`/api/app/skills/file?${query}`);
			expect(file.status).toBe(200);
			expect(((await file.json()) as { content: string }).content).toBe("weather body");
			expect((await call("/api/app/identity")).status).toBe(200);
			expect((await call("/api/app/attachments")).status).toBe(200);
			const served = await call("/api/app/attachments/file?name=pic.png");
			expect(served.status).toBe(200);
			expect(served.headers.get("content-type")).toBe("image/png");
			expect(await served.text()).toBe("PNG");
			const log = await call("/api/app/log?limit=5");
			expect(log.status).toBe(200);
			expect(((await log.json()) as { lines: unknown[] }).lines.length).toBe(1);
		} finally {
			http.stop();
		}
	});

	test("GET attachments lists for the viewer; POST still reaches the composer upload", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME, operator: {} });
		try {
			mkdirSync(join(home, "workspace/attachments"), { recursive: true });
			const list = await call("/api/app/attachments");
			expect(list.status).toBe(200);
			expect(((await list.json()) as { files: unknown[] }).files).toEqual([]);
			const post = await call("/api/app/attachments", { method: "POST" });
			expect(post.status).toBe(400);
			expect(((await post.json()) as { error: string }).error).toBe("expected multipart form");
		} finally {
			http.stop();
		}
	});

	test("the legacy attachments read-back route still serves bytes", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME, operator: {} });
		try {
			mkdirSync(join(home, "workspace/attachments"), { recursive: true });
			writeFileSync(join(home, "workspace/attachments/app-test.png"), "PNGX");
			const legacy = await call("/api/app/attachments/app-test.png");
			expect(legacy.status).toBe(200);
			expect(await legacy.text()).toBe("PNGX");
			const viewer = await call("/api/app/attachments/file?name=app-test.png");
			expect(viewer.status).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("symlink indirection cannot carry a read outside the tree", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME, operator: {} });
		try {
			writeFileSync(join(home, "secret.txt"), "top secret");
			mkdirSync(join(home, "workspace/attachments"), { recursive: true });
			mkdirSync(join(home, "workspace/skills"), { recursive: true });
			writeFileSync(join(home, "workspace/SOUL.md"), "synthetic outside marker");
			symlinkSync(join(home, "secret.txt"), join(home, "workspace/attachments/evil.png"));
			symlinkSync(join(home, "workspace"), join(home, "workspace/skills/evil"));
			expect((await call("/api/app/attachments/file?name=evil.png")).status).toBe(404);
			expect((await call("/api/app/skills/file?name=evil&path=SOUL.md")).status).toBe(404);
			const list = (await (await call("/api/app/attachments")).json()) as {
				files: Array<{ name: string }>;
			};
			expect(list.files.map((f) => f.name)).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("401 is an auth check, not proof that a state viewer tail is mounted", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME, operator: {} });
		try {
			for (const path of ["/api/app/skills", "/api/app/not-a-mounted-tail"]) {
				expect((await call(path, {}, null)).status).toBe(401);
			}
			expect((await call("/api/app/skills")).status).toBe(200);
			expect((await call("/api/app/not-a-mounted-tail")).status).toBe(404);
		} finally {
			http.stop();
		}
	});
});

describe("app operator surface", () => {
	for (const mode of ["bearer", "trust"] as const) {
		test(`secrets POST requires JSON content type before storing in ${mode} mode`, async () => {
			const stored: string[] = [];
			const { http, call } = setup({
				...(mode === "bearer" ? { token: APP_TOKEN_NAME } : {}),
				operator: {
					secrets: {
						has: () => false,
						isCommand: () => false,
						store: (name) => {
							stored.push(name);
						},
					},
				},
			});
			try {
				const body = JSON.stringify({ name: "fixture-key", value: "fixture-value" });
				const post = (contentType?: string) =>
					call(
						"/api/app/secrets",
						{
							method: "POST",
							headers: {
								origin: `http://127.0.0.1:${http.port}`,
								"sec-fetch-site": "same-origin",
								...(contentType === undefined ? {} : { "content-type": contentType }),
							},
							body: new TextEncoder().encode(body),
						},
						mode === "bearer" ? APP_TOKEN_VALUE : null,
					);
				for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
					const refused = await post(contentType);
					expect(refused.status).toBe(415);
					expect(await refused.json()).toEqual({ error: "expected application/json" });
					expect(stored).toEqual([]);
				}
				for (const contentType of ["application/json", "application/json; charset=utf-8"]) {
					const accepted = await post(contentType);
					expect(accepted.status).toBe(200);
					expect(await accepted.json()).toEqual({
						ok: true,
						name: "fixture-key",
						replaced: false,
					});
				}
				expect(stored).toEqual(["fixture-key", "fixture-key"]);
			} finally {
				http.stop();
			}
		});
	}

	test("operator routes are bearer-gated before the wire check, then 503 unwired", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/settings", {}, "wrong")).status).toBe(401);
			expect((await call("/api/app/settings")).status).toBe(503);
			expect((await call("/api/app/memory/status")).status).toBe(503);
		} finally {
			http.stop();
		}
	});

	test("settings GET carries config + kind lists + etag; POST honors If-Match end to end", async () => {
		const { http, call, configRef, configWrites } = setup({
			token: APP_TOKEN_NAME,
			operator: { beforeConfigWritten: () => {} },
		});
		try {
			const loaded = await call("/api/app/settings");
			expect(loaded.status).toBe(200);
			const etag = loaded.headers.get("etag")!;
			expect(etag).toBeTruthy();
			const body = (await loaded.json()) as {
				config: { model: string };
				providerKinds: string[];
			};
			expect(body.config.model).toBe("zai/m");
			expect(body.providerKinds).toContain("codex");

			const post = (ifMatch: string | null, payload: unknown) =>
				call("/api/app/settings", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(ifMatch !== null ? { "if-match": ifMatch } : {}),
					},
					body: JSON.stringify(payload),
				});
			expect((await post(null, { logLevel: "debug" })).status).toBe(428);
			expect((await post('"bogus"', { logLevel: "debug" })).status).toBe(409);
			expect((await post(etag, { operators: [] })).status).toBe(422);
			const sentinel = "SETTINGS_FAKE_SECRET_SENTINEL";
			const refused = await post(etag, { model: sentinel });
			expect(refused.status).toBe(422);
			expect(await refused.text()).not.toContain(sentinel);
			expect(configRef.current.operators).toEqual([42]);
			expect(
				(
					await call("/api/app/settings", {
						method: "POST",
						headers: { "if-match": etag },
						body: "{}",
					})
				).status,
			).toBe(415);

			const ok = await post(etag, { allowedUsers: [42, 7], logLevel: "debug" });
			expect(ok.status).toBe(200);
			expect(configRef.current.allowedUsers).toEqual([42, 7]);
			expect(configRef.current.logLevel).toBe("debug");
			expect(configWrites.count).toBe(1);
		} finally {
			http.stop();
		}
	});

	test("a settings save clears the bot API root with '' and keeps it when the key is absent", async () => {
		const { http, call, configRef } = setup({
			token: APP_TOKEN_NAME,
			operator: { beforeConfigWritten: () => {} },
		});
		try {
			configRef.current.telegram.apiRoot = "http://127.0.0.1:8081";
			const post = (etag: string, telegram: object) =>
				call("/api/app/settings", {
					method: "POST",
					headers: { "content-type": "application/json", "if-match": etag },
					body: JSON.stringify({ telegram }),
				});
			const etag1 = (await call("/api/app/settings")).headers.get("etag")!;
			expect((await post(etag1, { dmGapMinutes: 30 })).status).toBe(200);
			expect(loadConfig()!.telegram.apiRoot).toBe("http://127.0.0.1:8081");

			const etag2 = (await call("/api/app/settings")).headers.get("etag")!;
			expect((await post(etag2, { apiRoot: "", dmGapMinutes: 30 })).status).toBe(200);
			expect(loadConfig()!.telegram.apiRoot).toBeUndefined();
			expect(configRef.current.telegram.apiRoot).toBeUndefined();
			expect(loadConfig()!.telegram.dmGapMinutes).toBe(30);
		} finally {
			http.stop();
		}
	});

	test("memory status + documents ride the shared gates under app auth", async () => {
		const docs = {
			items: [
				{
					id: "exchange/dm:1/2/abc",
					created_at: "2026-10-01T00:00:00Z",
					updated_at: "2026-10-01T00:00:00Z",
					text_length: 120,
					memory_unit_count: 2,
					document_metadata: { conversation_id: "dm:1" },
				},
			],
			total: 1,
			limit: 25,
			offset: 0,
		};
		const client = {
			listDocuments: () => Promise.resolve(docs),
			getDocument: () =>
				Promise.resolve({
					id: "exchange/dm:1/2/abc",
					bank_id: "goblin",
					original_text: "hi",
					created_at: "2026-10-01T00:00:00Z",
					updated_at: null,
					memory_unit_count: 2,
				}),
			listMemories: () => Promise.resolve({ items: [], total: 0, limit: 200, offset: 0 }),
			operation: () => Promise.reject(new Error("unused")),
			deleteDocument: () => Promise.resolve(),
		} as unknown as HindsightClient;
		const { http, call, configRef } = setup({
			token: APP_TOKEN_NAME,
			operator: { memory: stubMemory({ client }) },
		});
		try {
			const disabled = await call("/api/app/memory/status");
			expect(disabled.status).toBe(200);
			expect(((await disabled.json()) as { state: string }).state).toBe("disabled");
			expect((await call("/api/app/memory/documents")).status).toBe(503);

			configRef.current = {
				...configRef.current,
				memory: memoryConfigSchema.parse({
					baseUrl: "http://127.0.0.1:8888",
					bankId: "goblin",
				}),
			};
			const status = (await (await call("/api/app/memory/status")).json()) as {
				state: string;
				completed: number;
			};
			expect(status.state).toBe("healthy");
			expect(status.completed).toBe(3);
			const list = (await (await call("/api/app/memory/documents")).json()) as {
				items: Array<{ id: string; conversationId: string | null }>;
				total: number;
			};
			expect(list.total).toBe(1);
			expect(list.items[0]?.id).toBe("exchange/dm:1/2/abc");
			expect(list.items[0]?.conversationId).toBe("dm:1");
			const detail = (await (
				await call("/api/app/memory/documents/exchange%2Fdm%3A1%2F2%2Fabc")
			).json()) as { document: { id: string }; originalText: string };
			expect(detail.document.id).toBe("exchange/dm:1/2/abc");
			expect(detail.originalText).toBe("hi");
		} finally {
			http.stop();
		}
	});

	for (const [conversation, collision] of [
		["app/foo_bar", "app/fooxbar"],
		["app/abc", "app/ABC"],
		["app/1", "app/12"],
		["app/parent", "app/parent/child"],
	] as const) {
		test(`thread memory filtering matches ${conversation} literally with accurate pages and totals`, async () => {
			const matching = [1, 2, 3].map((seq) => ({ id: `exchange/${conversation}/${seq}/answer` }));
			const docs = [
				matching[0]!,
				...Array.from({ length: 99 }, (_, seq) => ({ id: `exchange/${collision}/${seq}/answer` })),
				...matching.slice(1),
			];
			const scanned: number[] = [];
			let failSecondPage = false;
			const upstream = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: (req) => {
					const params = new URL(req.url).searchParams;
					const offset = Number(params.get("offset"));
					const limit = Number(params.get("limit"));
					scanned.push(offset);
					if (failSecondPage && offset > 0) return new Response("unavailable", { status: 500 });
					return Response.json({
						items: docs.slice(offset, offset + limit),
						total: docs.length,
						offset,
						limit,
					});
				},
			});
			const baseUrl = `http://127.0.0.1:${upstream.port}`;
			const client = new HindsightClient({ baseUrl, bankId: "goblin" });
			const { http, call, configRef } = setup({
				token: APP_TOKEN_NAME,
				operator: { memory: stubMemory({ client, target: { baseUrl, bankId: "goblin" } }) },
			});
			try {
				configRef.current = {
					...configRef.current,
					memory: memoryConfigSchema.parse({ baseUrl, bankId: "goblin" }),
				};
				for (const offset of [0, 1, 3]) {
					const res = await call(
						`/api/app/memory/documents?conversation=${encodeURIComponent(conversation)}&limit=1&offset=${offset}`,
					);
					expect(res.status).toBe(200);
					const body = (await res.json()) as MemoriesListResponse;
					expect(body).toMatchObject({ total: 3, offset, limit: 1 });
					expect(body.items.map((item) => item.id)).toEqual(
						matching.slice(offset, offset + 1).map((item) => item.id),
					);
				}
				expect(scanned).toEqual([0, 100, 0, 100, 0, 100]);
				failSecondPage = true;
				expect(
					(await call(`/api/app/memory/documents?conversation=${encodeURIComponent(conversation)}`))
						.status,
				).toBe(503);
			} finally {
				http.stop();
				upstream.stop();
			}
		});
	}

	test("thread panel tails: conversation filter and skills/from resolve through app auth", async () => {
		const seenQ: Array<string | undefined> = [];
		const client = {
			listDocuments: (opts: { q?: string; limit: number; offset: number }) => {
				seenQ.push(opts.q);
				return Promise.resolve({ items: [], total: 0, limit: opts.limit, offset: opts.offset });
			},
		} as unknown as HindsightClient;
		const { http, call, configRef, home } = setup({
			token: APP_TOKEN_NAME,
			operator: { memory: stubMemory({ client }) },
		});
		try {
			configRef.current = {
				...configRef.current,
				memory: memoryConfigSchema.parse({
					baseUrl: "http://127.0.0.1:8888",
					bankId: "goblin",
				}),
			};
			const filtered = await call("/api/app/memory/documents?conversation=app%2F1");
			expect(filtered.status).toBe(200);
			expect(seenQ.at(-1)).toBe("exchange/");
			const both = await call("/api/app/memory/documents?q=x&conversation=app%2F1");
			expect(both.status).toBe(422);

			const unwired = await call("/api/app/skills/from?conversation=app%2F1");
			expect(unwired.status).toBe(503);

			const db = new Database(":memory:");
			const sources = new SkillSources(db);
			const skillsDir = join(home, "workspace", "skills");
			const proposedDir = join(home, "workspace", "skills-proposed");
			mkdirSync(join(skillsDir, "herdr"), { recursive: true });
			mkdirSync(join(proposedDir, "staged-skill"), { recursive: true });
			// An update proposal on an installed skill: both dirs exist —
			// installed still wins the state word, pending carries the
			// undecided proposal.
			mkdirSync(join(proposedDir, "herdr"), { recursive: true });
			sources.record("app/1", "herdr", "reviewer", "2026-10-16T01:00:00.000Z", "r1");
			sources.record("app/1", "gone-skill", "turn", "2026-10-16T02:00:00.000Z");
			sources.record("app/1", "staged-skill", "reviewer", "2026-10-16T03:00:00.000Z", "r2");
			const wired = setup({
				token: APP_TOKEN_NAME,
				operator: {
					skillSources: {
						forConversation: (id: string) => sources.forConversation(id),
						skillsDir,
						proposedDir,
					},
				},
			});
			try {
				const missing = await wired.call("/api/app/skills/from");
				expect(missing.status).toBe(422);
				const res = await wired.call("/api/app/skills/from?conversation=app%2F1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { items: ThreadSkillItem[] };
				expect(body.items).toEqual([
					{
						skill: "staged-skill",
						state: "proposed",
						pending: true,
						kind: "reviewer",
						firstAt: "2026-10-16T03:00:00.000Z",
						lastAt: "2026-10-16T03:00:00.000Z",
					},
					{
						skill: "gone-skill",
						state: "gone",
						pending: false,
						kind: "turn",
						firstAt: "2026-10-16T02:00:00.000Z",
						lastAt: "2026-10-16T02:00:00.000Z",
					},
					{
						skill: "herdr",
						state: "installed",
						pending: true,
						kind: "reviewer",
						firstAt: "2026-10-16T01:00:00.000Z",
						lastAt: "2026-10-16T01:00:00.000Z",
					},
				]);
			} finally {
				wired.http.stop();
			}
			db.close();
		} finally {
			http.stop();
		}
	});

	test("programs, delegations and status answer the read-only lists", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME, operator: {} });
		const db = join(home, "goblin.sqlite");
		const programs = openPrograms(db);
		programs.create({
			name: "ci",
			charter: "check the build",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const delegations = openDelegations(db);
		delegations.create({
			name: "port-widget",
			harness: "codex",
			cwd: "/work",
			task: "port the widget",
			address: { chatId: 1, threadId: null },
			appConversation: "app/spun1",
		});
		const wired = setup({
			token: APP_TOKEN_NAME,
			operator: {
				programs,
				delegations,
				service: {
					version: "9.9.9-test",
					startedAt: new Date(Date.now() - 60_000).toISOString(),
					restartHints: () => ["memory"],
				},
			},
		});
		try {
			const progs = (await (await wired.call("/api/app/programs")).json()) as {
				programs: Array<{
					name: string;
					cron: string | null;
					maxLatenessMinutes: number | null;
					hasHook: boolean;
				}>;
			};
			expect(progs.programs[0]).toMatchObject({
				name: "ci",
				cron: "0 9 * * *",
				maxLatenessMinutes: null,
				hasHook: false,
			});

			const dels = (await (await wired.call("/api/app/delegations")).json()) as {
				delegations: Array<{ name: string; status: string; appConversation: string | null }>;
			};
			expect(dels.delegations[0]).toMatchObject({
				name: "port-widget",
				status: "starting",
				appConversation: "app/spun1",
			});
			expect((await call("/api/app/delegations")).status).toBe(503);

			const status = (await (await wired.call("/api/app/status")).json()) as {
				version: string;
				uptimeSec: number;
				restartHints: string[];
				memory: { state: string };
				programs: { total: number; enabled: number };
				delegations: { total: number; active: number };
			};
			expect(status.version).toBe("9.9.9-test");
			expect(status.uptimeSec).toBeGreaterThanOrEqual(59);
			expect(status.restartHints).toEqual(["memory"]);
			expect(status.memory.state).toBe("disabled");
			expect(status.programs).toEqual({ total: 1, enabled: 1 });
			expect(status.delegations).toEqual({ total: 1, active: 0 });
		} finally {
			wired.http.stop();
			http.stop();
		}
	});

	test("trust mode still refuses foreign-origin mutations on the operator routes", async () => {
		const { http } = setup({
			operator: { beforeConfigWritten: () => {} },
		});
		try {
			const res = await fetch(`http://127.0.0.1:${http.port}/api/app/settings`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example",
				},
				body: JSON.stringify({ logLevel: "debug" }),
			});
			expect(res.status).toBe(403);
		} finally {
			http.stop();
		}
	});
});
