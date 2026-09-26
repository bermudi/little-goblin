import { afterEach, describe, expect, test } from "bun:test";
import { JevClient, JevError, JEV_MODEL } from "./jev.ts";

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
	model: "typesafe/jev-1.13-20260917",
	answers: { correction: { type: "noul", noul: 0.91 } },
	usage: { input_tokens: 287, output_tokens: 20, cost: 0.000012054 },
	id: "gen-dec-1790013977-LxrJdV3aOEliWmRmdmh9",
	provider: "TypeSafe",
};

describe("JevClient", () => {
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
		expect(seen!.body).toEqual({ model: JEV_MODEL, state: "some state", questions: { correction: question } });
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
});
