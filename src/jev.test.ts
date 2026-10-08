import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { JevClient, JevError, JEV_FALLBACK_MODEL, JEV_MODEL } from "./jev.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function served(handler: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

const question = {
	type: "noul" as const,
	instructions: "Did the operator correct something?",
	criteria: { true: "a correction", false: "no correction" },
};

// Recorded response shape (OpenRouter Decisions docs, 2026-09-21): the
// alpha wire shape pinned — a drift here fails loud, not silently.
const RECORDED = {
	model: "respan/span-01-lite",
	answers: { correction: { type: "noul", noul: 0.91 } },
	usage: { input_tokens: 287, output_tokens: 20, cost: 0.000012054 },
	id: "gen-dec-1790013977-LxrJdV3aOEliWmRmdmh9",
	provider: "TypeSafe",
};

describe("JevClient", () => {
	test("default and backup are explicitly typesafe/jev-1.13", () => {
		expect(JEV_MODEL).toBe("typesafe/jev-1.13");
		expect(JEV_FALLBACK_MODEL).toBe("typesafe/jev-1.13");
	});

	test("posts model/state/questions and parses the documented response", async () => {
		let seen: { url: string; auth: string | null; body: unknown } | null = null;
		const baseUrl = served(async (request) => {
			seen = {
				url: request.url,
				auth: request.headers.get("authorization"),
				body: (await request.json()) as unknown,
			};
			return Response.json(RECORDED);
		});
		const client = new JevClient({ baseUrl, auth: async () => "key" });
		const out = await client.decide("some state", { correction: question });
		expect(seen!.url.endsWith("/api/alpha/decisions")).toBe(true);
		expect(seen!.auth).toBe("Bearer key");
		expect(seen!.body).toEqual({
			model: JEV_MODEL,
			state: "some state",
			questions: { correction: question },
		});
		expect(out).toEqual({ answers: { correction: 0.91 }, inputTokens: 287, cost: 0.000012054 });
	});

	test("a missing answer is a protocol error", async () => {
		const baseUrl = served(() => Response.json({ ...RECORDED, answers: {} }));
		const client = new JevClient({ baseUrl, auth: async () => "key" });
		const err = await client.decide("s", { correction: question }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JevError);
		expect((err as JevError).kind).toBe("protocol");
	});

	test("usage may be absent — tokens and cost read null", async () => {
		const { usage: _dropped, ...bare } = RECORDED;
		const baseUrl = served(() => Response.json(bare));
		const client = new JevClient({ baseUrl, auth: async () => "key" });
		const out = await client.decide("s", { correction: question });
		expect(out).toEqual({ answers: { correction: 0.91 }, inputTokens: null, cost: null });
	});

	test("HTTP failures carry the status, auth failures their kind", async () => {
		const failing = served(() => new Response("bad", { status: 500 }));
		const http = await new JevClient({ baseUrl: failing, auth: async () => "key" })
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect(http).toBeInstanceOf(JevError);
		expect((http as JevError).kind).toBe("http");
		expect((http as JevError).status).toBe(500);
		const auth = await new JevClient({
			baseUrl: failing,
			auth: async () => {
				throw new Error("no key");
			},
		})
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect((auth as JevError).kind).toBe("auth");
	});

	test("a wedged server times out instead of hanging the gate", async () => {
		const baseUrl = served(() => new Promise<Response>(() => {}));
		const client = new JevClient({ baseUrl, auth: async () => "key", timeoutMs: 50 });
		const err = await client.decide("s", { correction: question }).catch((e: unknown) => e);
		expect((err as JevError).kind).toBe("timeout");
	});

	test("a wedged auth resolver is bounded by the same deadline", async () => {
		const client = new JevClient({ auth: () => new Promise<string>(() => {}), timeoutMs: 25 });
		const err = await client.decide("s", { correction: question }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JevError);
		expect((err as JevError).kind).toBe("timeout");
	});

	test("a failing response stream is a Jev transport error, not a raw exception", async () => {
		const baseUrl = served(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"answers":'));
							setTimeout(() => controller.error(new Error("stream broke")), 5);
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const err = await new JevClient({ baseUrl, auth: async () => "key" })
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JevError);
		expect((err as JevError).kind).toBe("transport");
	});

	test("configured primary failure retries the identical payload once with backup and one auth resolution", async () => {
		const requests: { model: string; state: unknown; questions: unknown; auth: string | null }[] =
			[];
		const baseUrl = served(async (request) => {
			const body = z
				.object({
					model: z.string(),
					state: z.unknown(),
					questions: z.unknown(),
				})
				.parse(await request.json());
			requests.push({ ...body, auth: request.headers.get("authorization") });
			return body.model === JEV_FALLBACK_MODEL
				? Response.json(RECORDED)
				: new Response("primary unavailable", { status: 503 });
		});
		let resolutions = 0;
		const client = new JevClient({
			baseUrl,
			model: "inception/mercury-decide:free",
			auth: async () => {
				resolutions++;
				return "key";
			},
		});
		expect((await client.decide("state", { correction: question })).answers.correction).toBe(0.91);
		expect(requests).toEqual([
			{
				model: "inception/mercury-decide:free",
				state: "state",
				questions: { correction: question },
				auth: "Bearer key",
			},
			{
				model: JEV_FALLBACK_MODEL,
				state: "state",
				questions: { correction: question },
				auth: "Bearer key",
			},
		]);
		expect(resolutions).toBe(1);
	});

	test("a valid zero probability is not retried", async () => {
		let calls = 0;
		const baseUrl = served(() => {
			calls++;
			return Response.json({ answers: { correction: { type: "noul", noul: 0 } } });
		});
		const decision = await new JevClient({
			baseUrl,
			model: "primary",
			auth: async () => "key",
		}).decide("s", { correction: question });
		expect(decision.answers.correction).toBe(0);
		expect(calls).toBe(1);
	});

	for (const status of [400, 404, 429, 500, 503]) {
		test(`HTTP ${status} on configured primary falls back`, async () => {
			let calls = 0;
			const baseUrl = served(() =>
				++calls === 1 ? new Response("synthetic failure", { status }) : Response.json(RECORDED),
			);
			const decision = await new JevClient({
				baseUrl,
				model: "primary",
				auth: async () => "key",
			}).decide("s", { correction: question });
			expect(decision.answers.correction).toBe(0.91);
			expect(calls).toBe(2);
		});
	}

	for (const [name, body] of [
		["invalid JSON", "not json"],
		["missing answer", JSON.stringify({ answers: {} })],
		[
			"out-of-range probability",
			JSON.stringify({ answers: { correction: { type: "noul", noul: 2 } } }),
		],
	]) {
		test(`${name} on configured primary falls back`, async () => {
			let calls = 0;
			const baseUrl = served(() => (++calls === 1 ? new Response(body) : Response.json(RECORDED)));
			const decision = await new JevClient({
				baseUrl,
				model: "primary",
				auth: async () => "key",
			}).decide("s", { correction: question });
			expect(decision.answers.correction).toBe(0.91);
			expect(calls).toBe(2);
		});
	}

	test("a failed default model is not retried against itself", async () => {
		let calls = 0;
		const baseUrl = served(() => {
			calls++;
			return new Response("failed", { status: 503 });
		});
		const err = await new JevClient({ baseUrl, auth: async () => "key" })
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JevError);
		expect((err as JevError).status).toBe(503);
		expect(calls).toBe(1);
	});

	for (const status of [401, 403]) {
		test(`HTTP ${status} does not retry the same credential`, async () => {
			let calls = 0;
			const baseUrl = served(() => {
				calls++;
				return new Response("denied", { status });
			});
			const err = await new JevClient({ baseUrl, model: "primary", auth: async () => "key" })
				.decide("s", { correction: question })
				.catch((e: unknown) => e);
			expect((err as JevError).status).toBe(status);
			expect(calls).toBe(1);
		});
	}

	test("auth failure makes no request and never resolves auth again for backup", async () => {
		let calls = 0;
		let resolutions = 0;
		const baseUrl = served(() => {
			calls++;
			return Response.json(RECORDED);
		});
		const err = await new JevClient({
			baseUrl,
			model: "primary",
			auth: async () => {
				resolutions++;
				throw new Error("synthetic credential detail");
			},
		})
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect((err as JevError).kind).toBe("auth");
		expect((err as JevError).message).not.toContain("credential detail");
		expect(resolutions).toBe(1);
		expect(calls).toBe(0);
	});

	test("exhausted backup preserves a typed sanitized failure", async () => {
		let calls = 0;
		const baseUrl = served(() => {
			calls++;
			return new Response("synthetic private response body", { status: 503 });
		});
		const err = await new JevClient({ baseUrl, model: "primary", auth: async () => "key" })
			.decide("s", { correction: question })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JevError);
		expect((err as JevError).kind).toBe("http");
		expect((err as JevError).status).toBe(503);
		expect((err as JevError).message).not.toContain("private response body");
		expect(calls).toBe(2);
	});

	test("a hung primary leaves time for backup within the caller's total deadline", async () => {
		let calls = 0;
		const baseUrl = served(() =>
			++calls === 1 ? new Promise<Response>(() => {}) : Response.json(RECORDED),
		);
		const started = performance.now();
		const decision = await new JevClient({
			baseUrl,
			model: "primary",
			auth: async () => "key",
		}).decide("s", { correction: question }, { timeoutMs: 200 });
		expect(decision.answers.correction).toBe(0.91);
		expect(calls).toBe(2);
		expect(performance.now() - started).toBeLessThan(400);
	});

	test("two hung attempts share one caller deadline rather than each getting a full timeout", async () => {
		let calls = 0;
		const baseUrl = served(() => {
			calls++;
			return new Promise<Response>(() => {});
		});
		const started = performance.now();
		const err = await new JevClient({ baseUrl, model: "primary", auth: async () => "key" })
			.decide("s", { correction: question }, { timeoutMs: 200 })
			.catch((e: unknown) => e);
		expect((err as JevError).kind).toBe("timeout");
		expect(calls).toBe(2);
		expect(performance.now() - started).toBeLessThan(400);
	});

	test("request input is snapshotted before auth and serialized once", async () => {
		const states: unknown[] = [];
		let calls = 0;
		let serializations = 0;
		const state = {
			next: "original",
			toJSON() {
				serializations++;
				return { next: this.next };
			},
		};
		const baseUrl = served(async (request) => {
			const body = z.object({ state: z.unknown() }).parse(await request.json());
			states.push(body.state);
			return ++calls === 1 ? new Response("failed", { status: 503 }) : Response.json(RECORDED);
		});
		await new JevClient({
			baseUrl,
			model: "primary",
			auth: async () => {
				state.next = "mutated";
				return "key";
			},
		}).decide(state, { correction: question });
		expect(states).toEqual([{ next: "original" }, { next: "original" }]);
		expect(serializations).toBe(1);
	});
});
