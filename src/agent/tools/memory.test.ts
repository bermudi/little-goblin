import { afterEach, describe, expect, test } from "bun:test";
import { HindsightClient } from "../../hindsight.ts";
import { memorySearchTool } from "./memory.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function served(handler: (request: Request) => Response | Promise<Response>): HindsightClient {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return new HindsightClient({ baseUrl: `http://127.0.0.1:${server.port}`, bankId: "g" });
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
	test("returns dated evidence with source references", async () => {
		const client = served(() => Response.json({ results: [{
			id: "fact-1", text: "Prefers quiet mornings.", type: "world",
			document_id: "exchange/dm:1/1/a", occurred_start: "2026-01-01",
		}] }));
		const out = (await exec(memorySearchTool(deps(client)), { query: "mornings" })) as {
			memory: string;
			sources: { fact: string; document: string | null; date: string | null }[];
		};
		expect(out.memory).toContain("Prefers quiet mornings.");
		expect(out.memory).toContain("take precedence");
		expect(out.sources).toEqual([{ fact: "fact-1", document: "exchange/dm:1/1/a", date: "2026-01-01" }]);
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
		const out = (await exec(memorySearchTool(deps(client, true)), { query: "x" })) as { error: string };
		expect(out).toEqual({ error: "memory is excluded in this conversation" });
		expect(calls).toBe(0);
	});
});
