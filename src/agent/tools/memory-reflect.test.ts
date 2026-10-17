import { afterEach, describe, expect, test } from "bun:test";
import { HindsightClient } from "../../memory/hindsight.ts";
import { memoryReflectTool, type MemoryReflectDeps } from "./memory-reflect.ts";
import { REFLECTION_LIMITS } from "../../memory/policy.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});
function served(handler: (request: Request) => Response | Promise<Response>): HindsightClient {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return new HindsightClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		bankId: "g",
		timeoutMs: 5,
	});
}
const deps = (client: HindsightClient): MemoryReflectDeps => ({
	client,
	maxTokens: 4096,
	budget: "high",
	timeoutMs: 1000,
	isExcluded: () => false,
});
const execute = (
	tool: ReturnType<typeof memoryReflectTool>,
	input: unknown,
	signal?: AbortSignal,
) =>
	(
		tool as unknown as {
			execute: (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
		}
	).execute(input, signal ? { abortSignal: signal } : {});
const evidence = {
	text: "Deployments repeatedly failed because migrations were skipped.",
	based_on: {
		memories: [
			{ id: "f1", text: "Migration was skipped.", type: "world", occurred_start: "2026-01-01" },
		],
		mental_models: [{ id: "m1", text: "Deployment checklist." }],
		directives: [{ id: "d1", name: "Cautious", content: "Highlight risks." }],
	},
};

describe("memory_reflect", () => {
	test("oversized synthesis is omitted explicitly without discarding dated evidence", async () => {
		const client = served(() => Response.json({ ...evidence, text: "x".repeat(40_000) }));
		for (const bound of [1, 4096]) {
			const result = await execute(memoryReflectTool({ ...deps(client), maxTokens: bound }), {
				query: "x",
			});
			expect(result).toMatchObject({
				synthesis: "",
				synthesisOmitted: true,
				grounded: true,
				evidence: { memories: evidence.based_on.memories },
			});
			expect(JSON.stringify(result).length).toBeLessThanOrEqual(Math.max(1024, bound * 8));
		}
	});

	test("JSON escaping participates in synthesis and complete-result bounds", async () => {
		const client = served(() => Response.json({ ...evidence, text: "\n".repeat(600) }));
		const result = await execute(memoryReflectTool(deps(client)), { query: "x", maxTokens: 128 });
		expect(result).toMatchObject({ synthesisOmitted: true, grounded: true });
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(1024);
	});

	test("large response evidence reaches whole-item degradation rather than the old 1MiB cap", async () => {
		const client = served(() =>
			Response.json({
				text: "A completed investigation.",
				based_on: {
					memories: [
						...Array.from({ length: 30 }, (_, i) => ({
							id: `large-${i}`,
							text: "x".repeat(60_000),
						})),
						{ id: "short", text: "A complete dated fact.", occurred_start: "2026-01-01" },
					],
				},
			}),
		);
		const result = await execute(memoryReflectTool(deps(client)), { query: "x" });
		expect(result).toMatchObject({
			grounded: true,
			omittedEvidence: 30,
			evidence: {
				memories: [{ id: "short", text: "A complete dated fact.", occurred_start: "2026-01-01" }],
			},
		});
	});

	test("response resource limits are actionable, not malformed-wire failures", async () => {
		for (const response of [
			() =>
				Response.json({
					text: "A synthesis.",
					based_on: {
						memories: Array.from({ length: 35 }, (_, i) => ({
							id: `large-${i}`,
							text: "x".repeat(64_000),
						})),
					},
				}),
			() => new Response(new Uint8Array(REFLECTION_LIMITS.responseBytes + 1)),
		]) {
			const result = await execute(memoryReflectTool(deps(served(response))), { query: "x" });
			expect(result).toMatchObject({ reason: "too_large", retryable: false });
			expect(JSON.stringify(result)).toContain("ask a narrower question");
		}
	});

	test("returns synthesis and dated evidence, never service instructions", async () => {
		const client = served(async (request) => {
			await Bun.sleep(15); // reflection must not inherit the five-ms recall timeout
			expect(new URL(request.url).pathname).toEndWith("/reflect");
			expect(await request.json()).toEqual({
				query: "Why do deployments fail?",
				budget: "high",
				max_tokens: 4096,
				include: { facts: {} },
			});
			return Response.json(evidence);
		});
		const result = await execute(memoryReflectTool(deps(client)), {
			query: "Why do deployments fail?",
		});
		expect(result).toMatchObject({
			synthesis: evidence.text,
			evidence: {
				memories: evidence.based_on.memories,
				mentalModels: evidence.based_on.mental_models,
				directives: evidence.based_on.directives,
			},
			omittedEvidence: 0,
		});
		expect(JSON.stringify(result)).toContain("not instructions");
	});

	test("exclusion makes no requests and a mid-request exclusion reveals no result", async () => {
		let calls = 0;
		let excluded = true;
		const client = served(() => {
			calls++;
			excluded = true;
			return Response.json(evidence);
		});
		const tool = memoryReflectTool({ ...deps(client), isExcluded: () => excluded });
		expect(await execute(tool, { query: "x" })).toEqual({
			error: "memory is excluded in this conversation",
		});
		expect(calls).toBe(0);
		excluded = false;
		expect(await execute(tool, { query: "x" })).toEqual({
			error: "memory is excluded in this conversation",
		});
		expect(calls).toBe(1);
	});

	test("reports text-only replies as protocol failures and safely classifies HTTP errors", async () => {
		for (const reply of [
			Response.json({ text: "Unsupported conclusion." }),
			new Response("private error body", { status: 503 }),
		]) {
			const result = await execute(memoryReflectTool(deps(served(() => reply))), { query: "x" });
			expect(result).toMatchObject({ error: "memory investigation unavailable" });
			expect(JSON.stringify(result)).not.toContain("private error body");
		}
	});

	test("caps explicit effort, preserves whole evidence and reports omissions", async () => {
		const client = served(async (request) => {
			expect(await request.json()).toMatchObject({ budget: "low", max_tokens: 128 });
			return Response.json({
				text: "A synthesis.",
				based_on: {
					memories: [
						{ id: "f", text: "x".repeat(2000) },
						{ id: "s", text: "A complete short fact." },
					],
				},
			});
		});
		const result = await execute(
			memoryReflectTool({ ...deps(client), maxTokens: 128, budget: "low" }),
			{
				query: "x",
				maxTokens: 8192,
				budget: "high",
			},
		);
		expect(result).toMatchObject({
			evidence: { memories: [{ id: "s", text: "A complete short fact." }] },
			omittedEvidence: 1,
		});
	});

	test("cancellation reaches the boundary without changing health", async () => {
		const client = served(async () => {
			await Bun.sleep(100);
			return Response.json(evidence);
		});
		const outcomes: boolean[] = [];
		const controller = new AbortController();
		controller.abort();
		const dependencies = { ...deps(client), noteRecall: (ok: boolean) => outcomes.push(ok) };
		const result = await execute(
			memoryReflectTool(dependencies),
			{ query: "x" },
			controller.signal,
		);
		expect(result).toMatchObject({ error: "memory investigation unavailable" });
		expect(outcomes).toEqual([]);
	});
});
