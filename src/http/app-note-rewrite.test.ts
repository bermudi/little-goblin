import { describe, expect, test } from "bun:test";

import { APP_TOKEN_NAME, setup } from "./app-test-util.ts";

describe("app note rewrite", () => {
	const postRewrite = (
		call: ReturnType<typeof setup>["call"],
		id: string,
		body: unknown,
		init: RequestInit = {},
	) =>
		call(`/api/app/notes/${id}/rewrite`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
			body: JSON.stringify(body),
			...init,
		});
	const create = (call: ReturnType<typeof setup>["call"], body: unknown) =>
		call("/api/app/notes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const goodBody = { selection: "some *text*", instruction: "fix it" };

	test("the route rides the shared gates — auth, origin, JSON, method", async () => {
		// Bearer mode: no token, no route.
		const a = setup({
			token: APP_TOKEN_NAME,
			rewriteNote: () => Promise.resolve("x"),
		});
		try {
			const denied = await a.call(
				"/api/app/notes/n/rewrite",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(goodBody),
				},
				null,
			);
			expect(denied.status).toBe(401);
		} finally {
			a.http.stop();
		}
		// Trust mode: a foreign-origin browser mutation refuses before
		// the route; the JSON gate precedes the body parse; GET 405s.
		const b = setup({ rewriteNote: () => Promise.resolve("x") });
		try {
			const foreign = await b.call(
				"/api/app/notes/n/rewrite",
				{
					method: "POST",
					headers: { origin: "http://attacker.local:1234", "content-type": "application/json" },
					body: JSON.stringify(goodBody),
				},
				null,
			);
			expect(foreign.status).toBe(403);
			const plain = await b.call(
				"/api/app/notes/n/rewrite",
				{
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "x",
				},
				null,
			);
			expect(plain.status).toBe(415);
			expect((await b.call("/api/app/notes/n/rewrite", {}, null)).status).toBe(405);
		} finally {
			b.http.stop();
		}
	});

	test("an unwired seam is 503 — no generation at all", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string };
			const res = await postRewrite(call, note.id, goodBody);
			expect(res.status).toBe(503);
		} finally {
			http.stop();
		}
	});

	test("missing and archived notes refuse before the model is asked", async () => {
		const calls: string[] = [];
		const { http, call, notes } = setup({
			token: APP_TOKEN_NAME,
			rewriteNote: (id) => {
				calls.push(id);
				return Promise.resolve("x");
			},
		});
		try {
			expect((await postRewrite(call, "ghost", goodBody)).status).toBe(404);
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string };
			notes.setArchived(note.id, true);
			expect((await postRewrite(call, note.id, goodBody)).status).toBe(422);
			expect(calls).toHaveLength(0);
		} finally {
			http.stop();
		}
	});

	test("strict input: empty, whitespace, oversized and unknown keys refuse", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			rewriteNote: () => Promise.resolve("x"),
		});
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string };
			const cases: unknown[] = [
				{ selection: "", instruction: "x" },
				{ selection: "   \n ", instruction: "x" },
				{ selection: "x".repeat(50_001), instruction: "x" },
				{ selection: "x", instruction: "" },
				{ selection: "x", instruction: "   " },
				{ selection: "x", instruction: "y".repeat(2_001) },
				{ ...goodBody, frobnicate: true },
			];
			for (const body of cases) {
				expect((await postRewrite(call, note.id, body)).status).toBe(422);
			}
			// Bad JSON follows the shared convention.
			const badJson = await call(`/api/app/notes/${note.id}/rewrite`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{nope",
			});
			expect(badJson.status).toBe(400);
		} finally {
			http.stop();
		}
	});

	test("generation writes nothing — body, rev and versions unchanged", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			rewriteNote: (_id, input) => {
				// The request reaches the seam validated and intact.
				expect(input).toEqual(goodBody);
				return Promise.resolve("a **better** take");
			},
		});
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string; rev: number };
			const res = await postRewrite(call, note.id, goodBody);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { replacement: string }).replacement).toBe("a **better** take");
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				rev: number;
			};
			expect(after.body).toBe("v1");
			expect(after.rev).toBe(note.rev);
			const versions = (await (await call(`/api/app/notes/${note.id}/versions`)).json()) as {
				versions: unknown[];
			};
			expect(versions.versions).toHaveLength(0);
		} finally {
			http.stop();
		}
	});

	test("a seam failure reaches the logged 500; the note is untouched", async () => {
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			rewriteNote: () => Promise.reject(new Error("model blew up")),
		});
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string; rev: number };
			expect((await postRewrite(call, note.id, goodBody)).status).toBe(500);
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				rev: number;
			};
			expect(after.body).toBe("v1");
			expect(after.rev).toBe(note.rev);
		} finally {
			http.stop();
		}
	});

	test("PATCH source 'rewrite' records the pre-state; 'agent' refuses", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "one" });
			const note = (await created.json()) as { id: string };
			const accepted = await call(`/api/app/notes/${note.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "if-match": '"1"' },
				body: JSON.stringify({ body: "one — rewritten", source: "rewrite" }),
			});
			expect(accepted.status).toBe(200);
			const versions = (await (await call(`/api/app/notes/${note.id}/versions`)).json()) as {
				versions: { rev: number; source: string }[];
			};
			expect(versions.versions).toHaveLength(1);
			expect(versions.versions[0]).toMatchObject({ rev: 1, source: "rewrite" });
			// The internal agent source is not client-selectable.
			const forged = await call(`/api/app/notes/${note.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "if-match": '"2"' },
				body: JSON.stringify({ body: "forged", source: "agent" }),
			});
			expect(forged.status).toBe(422);
			// Source alone is not a content write.
			const bare = await call(`/api/app/notes/${note.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "rewrite" }),
			});
			expect(bare.status).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("a stale rewrite acceptance conflicts and leaves the note alone", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "one" });
			const note = (await created.json()) as { id: string };
			const stale = await call(`/api/app/notes/${note.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "if-match": '"99"' },
				body: JSON.stringify({ body: "stale apply", source: "rewrite" }),
			});
			expect(stale.status).toBe(409);
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				rev: number;
			};
			expect(after.body).toBe("one");
			expect(after.rev).toBe(1);
			const versions = (await (await call(`/api/app/notes/${note.id}/versions`)).json()) as {
				versions: unknown[];
			};
			expect(versions.versions).toHaveLength(0);
		} finally {
			http.stop();
		}
	});
});
