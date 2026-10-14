import { afterEach, describe, expect, test } from "bun:test";
import { HindsightClient } from "../../hindsight.ts";
import { memorySearchTool } from "./memory.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function served(
	handler: (request: Request) => Response | Promise<Response>,
	timeoutMs = 30_000,
): HindsightClient {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return new HindsightClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		bankId: "g",
		timeoutMs,
	});
}

const exec = (t: ReturnType<typeof memorySearchTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

const deps = (client: HindsightClient, excluded = false) => ({
	client,
	maxTokens: 256,
	budget: "low" as const,
	isExcluded: () => excluded,
	noteRecall: (_ok: boolean) => {},
});

describe("memory_search tool", () => {
	test("deliberate search does not inherit the automatic-recall timeout", async () => {
		const client = served(async () => {
			await Bun.sleep(30);
			return Response.json({ results: [] });
		}, 5);
		const result = await exec(memorySearchTool(deps(client)), { query: "x" });
		expect(result).toMatchObject({ sources: [] });
		await expect(client.recall("x")).rejects.toMatchObject({ kind: "timeout" });
	});

	test("the deliberate-search deadline remains enforced independently", async () => {
		const client = served(async () => {
			await Bun.sleep(100);
			return Response.json({ results: [] });
		});
		const result = await exec(memorySearchTool({ ...deps(client), timeoutMs: 5 }), { query: "x" });
		expect(result).toMatchObject({ error: "memory unavailable", retryable: true });
	});

	test("the complete output budget includes provenance for selected facts only", async () => {
		const client = served(() =>
			Response.json({
				results: Array.from({ length: 1000 }, (_, i) => ({
					id: `${i}`.padEnd(256, "f"),
					text: "A fact.",
					document_id: `${i}`.padEnd(256, "d"),
				})),
			}),
		);
		const result = await exec(memorySearchTool(deps(client)), { query: "x", maxTokens: 128 });
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(128 * 4);
		expect(result).toMatchObject({ sources: [], omitted: 1000 });
	});

	test("search cancellation leaves memory health unchanged", async () => {
		const outcomes: boolean[] = [];
		const client = served(() => Response.json({ results: [] }));
		const controller = new AbortController();
		controller.abort();
		const tool = memorySearchTool({ ...deps(client), noteRecall: (ok) => outcomes.push(ok) });
		await (
			tool as unknown as {
				execute: (input: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;
			}
		).execute({ query: "x" }, { abortSignal: controller.signal });
		expect(outcomes).toEqual([]);
	});

	test("returns dated evidence with source references", async () => {
		const client = served(() =>
			Response.json({
				results: [
					{
						id: "fact-1",
						text: "Prefers quiet mornings.",
						type: "world",
						document_id: "exchange/dm:1/1/a",
						occurred_start: "2026-01-01",
					},
				],
			}),
		);
		const out = (await exec(memorySearchTool(deps(client)), { query: "mornings" })) as {
			memory: string;
			sources: { fact: string; document: string | null; date: string | null }[];
		};
		expect(out.memory).toContain("Prefers quiet mornings.");
		expect(out.memory).toContain("take precedence");
		expect(out.sources).toEqual([
			{ fact: "fact-1", document: "exchange/dm:1/1/a", date: "2026-01-01" },
		]);
	});

	test("empty results are evidence of absence, outages are errors", async () => {
		const empty = served(() => Response.json({ results: [] }));
		const out = (await exec(memorySearchTool(deps(empty)), { query: "x" })) as { memory: string };
		expect(out.memory).toContain("no relevant memories");
		const down = served(() => new Response("down", { status: 503 }));
		const err = (await exec(memorySearchTool(deps(down)), { query: "x" })) as {
			error: string;
			retryable: boolean;
		};
		expect(err).toEqual({ error: "memory unavailable", retryable: true });
	});

	test("excluded topics recall nothing by any path", async () => {
		let calls = 0;
		const client = served(() => {
			calls++;
			return Response.json({ results: [] });
		});
		const out = (await exec(memorySearchTool(deps(client, true)), { query: "x" })) as {
			error: string;
		};
		expect(out).toEqual({ error: "memory is excluded in this conversation" });
		expect(calls).toBe(0);
	});

	test("a supplied budget may narrow the configured effort, never widen past it", async () => {
		const budgets: (string | undefined)[] = [];
		const client = served(async (request) => {
			budgets.push(((await request.json()) as { budget?: string }).budget);
			return Response.json({ results: [] });
		});
		const capped = memorySearchTool(deps(client)); // configured "low"
		const wide = memorySearchTool({ ...deps(client), budget: "high" as const });
		await exec(capped, { query: "x", budget: "high" }); // widened — clamped to "low"
		await exec(capped, { query: "x" }); // absent — configured value preserved
		await exec(wide, { query: "x", budget: "mid" }); // narrowed — passes through
		expect(budgets).toEqual(["low", "low", "mid"]);
	});
});
