// The search tool's contract: providers are bound behind one tool, the
// resolved key reaches the provider's auth header and nothing else, and
// failures carry provider + status — never the key. Output rendering is
// deterministic and bounded.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import { setLogFile } from "../../log.ts";
import { bindSearch, searchTool, type SearchKind } from "./search.ts";
import { renderHits, type SearchHit } from "./web.ts";

const fakeAuth: AuthStore = {
	resolve: async (name) => `key-for-${name}`,
	has: () => true,
	names: () => ["brave", "parallel"],
};

let servers: ReturnType<typeof Bun.serve>[] = [];
let logDir: string | null = null;
afterEach(() => {
	for (const s of servers) s.stop(true);
	servers = [];
	setLogFile(null);
	if (logDir !== null) rmSync(logDir, { recursive: true, force: true });
	logDir = null;
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return server.url.toString().replace(/\/$/, "");
}

function depsWith(search: unknown) {
	return {
		configRef: { current: { search } as unknown as Config },
		auth: fakeAuth,
	};
}

const exec = (t: ReturnType<typeof searchTool>, input: unknown) =>
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("search tool", () => {
	test("brave: key rides the subscription header, results render numbered", async () => {
		let sawToken = "";
		const base = serve((req) => {
			sawToken = req.headers.get("x-subscription-token") ?? "";
			return Response.json({
				web: { results: [{ title: "Brave Result", url: "https://example.com/a", description: "the snippet" }] },
			});
		});
		const run = bindSearch({ kind: "brave", auth: "brave" }, fakeAuth);
		const { hits, status } = await run({ query: "test", count: 5, baseUrl: base });
		expect(sawToken).toBe("key-for-brave");
		expect(status).toBe(200);
		expect(hits).toEqual([{ title: "Brave Result", url: "https://example.com/a", snippet: "the snippet" }]);
		expect(renderHits(hits)).toBe("1. Brave Result — https://example.com/a\n   the snippet");
	});

	test("parallel: excerpts join into the snippet, bearer auth", async () => {
		let sawAuth = "";
		let sawBody = "";
		const base = serve(async (req) => {
			sawAuth = req.headers.get("authorization") ?? "";
			sawBody = await new Response(req.body).text();
			return Response.json({
				results: [{ title: "Par", url: "https://example.com/p", excerpts: ["one", "two"] }],
			});
		});
		const run = bindSearch({ kind: "parallel", auth: "parallel" }, fakeAuth);
		const { hits } = await run({ query: "objective", count: 3, baseUrl: base });
		expect(sawAuth).toBe("Bearer key-for-parallel");
		expect(JSON.parse(sawBody)).toEqual({
			search_queries: ["objective"],
			objective: "objective",
			max_results: 3,
		});
		expect(hits).toEqual([{ title: "Par", url: "https://example.com/p", snippet: "one two" }]);
	});

	test("provider HTTP failure names provider+status, never the key", async () => {
		const base = serve(() => new Response("quota exceeded, upgrade plan", { status: 402 }));
		const run = bindSearch({ kind: "tavily", auth: "tavily" }, fakeAuth);
		try {
			await run({ query: "x", count: 5, baseUrl: base });
			expect.unreachable();
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("tavily");
			expect(msg).toContain("402");
			expect(msg).not.toContain("key-for-tavily");
		}
	});

	test("ddg: parses the unofficial html markup and unwraps redirect hrefs", async () => {
		const base = serve(() =>
			new Response(
				[
					`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://real.example/x")}&rut=abc">Real&nbsp;Title</a>`,
					`<a class="result__snippet">the &amp;snippet</a>`,
				].join("\n"),
				{ headers: { "content-type": "text/html" } },
			),
		);
		const run = bindSearch({ kind: "ddg" }, fakeAuth);
		const { hits } = await run({ query: "q", count: 5, baseUrl: base });
		expect(hits).toEqual([{ title: "Real Title", url: "https://real.example/x", snippet: "the &snippet" }]);
	});

	test("unconfigured search returns the config pointer", async () => {
		const out = (await exec(searchTool(depsWith(undefined)), { query: "x", count: 5 })) as {
			error: string;
			kind: string;
		};
		expect(out.kind).toBe("unconfigured");
		expect(out.error).toContain("goblin.json5");
	});

	test("a failed search rethrows and gets its own log line — an outage is not a silence", async () => {
		// The tool hardwires the production base (the baseUrl door sits one
		// layer down, on bindSearch), so the network-free seam for the
		// tool-level catch is a failing auth resolve — same path, same
		// warn-and-rethrow contract as a provider outage.
		logDir = mkdtempSync(join(tmpdir(), "goblin-searchlog-"));
		const target = join(logDir, "goblin.log");
		setLogFile(target);
		const boomAuth: AuthStore = {
			resolve: async () => {
				throw new Error("auth command failed");
			},
			has: () => true,
			names: () => ["brave"],
		};
		const tool = searchTool({ configRef: { current: { search: { kind: "brave", auth: "brave" } } as unknown as Config }, auth: boomAuth });
		try {
			await exec(tool, { query: "outage probe", count: 5 });
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("auth command failed");
		}
		const entry = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
		expect(entry).toMatchObject({
			level: "warn",
			msg: "web search failed",
			provider: "brave",
			query: "outage probe",
		});
		expect(String(entry.error)).toContain("auth command failed");
		expect(JSON.stringify(entry)).not.toContain("key-for-brave");
	});
});

describe("renderHits", () => {
	test("clamps long titles and collapses snippet whitespace", () => {
		const hit: SearchHit = {
			title: "T".repeat(300),
			url: "https://example.com",
			snippet: "a\n\n   b\t\tc",
		};
		const out = renderHits([hit]);
		expect(out).toContain("…");
		expect([...out].length).toBeLessThan(600);
		expect(out).toContain("a b c");
	});

	test("empty result set is an explicit no-results, not an error", () => {
		expect(renderHits([])).toBe("No results.");
	});
});
