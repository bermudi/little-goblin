import { describe, expect, test } from "bun:test";
import { setLogLevel } from "../log.ts";
import { NOTE_BODY_MAX } from "../notes.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

describe("app notes", () => {
	const postJson = (call: ReturnType<typeof setup>["call"], path: string, body: unknown) =>
		call(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const patchJson = (
		call: ReturnType<typeof setup>["call"],
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) =>
		call(path, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	const create = (call: ReturnType<typeof setup>["call"], body: unknown) =>
		postJson(call, "/api/app/notes", body);

	test("create, get with etag, list with project/q/archived filters", async () => {
		const { http, call, projects } = setup({ token: APP_TOKEN_NAME });
		try {
			const proj = projects.create({ name: "p" });
			const inProject = await create(call, {
				title: "project note",
				body: "pancakes",
				projectId: proj.id,
			});
			expect(inProject.status).toBe(201);
			const loose = await create(call, { title: "loose note", body: "waffles" });
			expect(loose.status).toBe(201);
			const looseNote = (await loose.json()) as { id: string; rev: number; body: string };
			expect(looseNote.rev).toBe(1);
			expect(loose.headers.get("etag")).toBe('"1"');

			const got = await call(`/api/app/notes/${looseNote.id}`);
			expect(got.status).toBe(200);
			expect(got.headers.get("etag")).toBe('"1"');
			expect(((await got.json()) as { body: string }).body).toBe("waffles");
			expect((await call("/api/app/notes/ghost")).status).toBe(404);

			const all = (await (await call("/api/app/notes")).json()) as {
				notes: { title: string }[];
			};
			expect(all.notes).toHaveLength(2);
			const looseOnly = (await (await call("/api/app/notes?project=loose")).json()) as {
				notes: { title: string; projectId: string | null }[];
			};
			expect(looseOnly.notes.map((n) => n.title)).toEqual(["loose note"]);
			const projOnly = (await (await call(`/api/app/notes?project=${proj.id}`)).json()) as {
				notes: { title: string }[];
			};
			expect(projOnly.notes.map((n) => n.title)).toEqual(["project note"]);
			const found = (await (await call("/api/app/notes?q=pancake")).json()) as {
				notes: { title: string }[];
			};
			expect(found.notes.map((n) => n.title)).toEqual(["project note"]);
		} finally {
			http.stop();
		}
	});

	test("the index serves past the store's 200 default and reports its own bound truthfully", async () => {
		const { http, call, notes } = setup({ token: APP_TOKEN_NAME });
		try {
			setLogLevel("error");
			const ids: string[] = [];
			for (let i = 0; i < 250; i++) ids.push(notes.create({ title: `bulk ${i}` }).id);
			setLogLevel("info");

			const read = async (path: string) =>
				(await (await call(path)).json()) as {
					notes: { id: string }[];
					truncated: boolean;
				};

			let page = await read("/api/app/notes");
			expect(page.notes).toHaveLength(250);
			expect(page.truncated).toBe(false);

			setLogLevel("error");
			for (let i = 250; i < 1000; i++) ids.push(notes.create({ title: `bulk ${i}` }).id);
			setLogLevel("info");

			page = await read("/api/app/notes");
			expect(page.notes).toHaveLength(1000);
			expect(page.truncated).toBe(false);

			setLogLevel("error");
			ids.push(notes.create({ title: "bulk 1000" }).id);
			setLogLevel("info");

			page = await read("/api/app/notes");
			expect(page.notes).toHaveLength(1000);
			expect(page.truncated).toBe(true);
			page = await read("/api/app/notes?q=bulk");
			expect(page.notes).toHaveLength(1000);
			expect(page.truncated).toBe(true);
			page = await read("/api/app/notes?q=zebra");
			expect(page.notes).toHaveLength(0);
			expect(page.truncated).toBe(false);

			setLogLevel("error");
			for (const id of ids) notes.setArchived(id, true);
			setLogLevel("info");
			page = await read("/api/app/notes");
			expect(page.notes).toHaveLength(0);
			expect(page.truncated).toBe(false);
			page = await read("/api/app/notes?archived=1");
			expect(page.notes).toHaveLength(1000);
			expect(page.truncated).toBe(true);
			page = await read("/api/app/notes?archived=1&q=bulk");
			expect(page.notes).toHaveLength(1000);
			expect(page.truncated).toBe(true);
		} finally {
			setLogLevel("info");
			http.stop();
		}
	});

	test("content writes are If-Match guarded — 428 missing, 409 stale; flags are not", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string; rev: number };

			const noMatch = await patchJson(call, `/api/app/notes/${note.id}`, { body: "v2" });
			expect(noMatch.status).toBe(428);
			const stale = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ body: "v2" },
				{ "if-match": '"99"' },
			);
			expect(stale.status).toBe(409);
			const conflict = (await stale.json()) as { note: { rev: number; body: string } };
			expect(conflict.note.rev).toBe(1);
			expect(conflict.note.body).toBe("v1");
			const ok = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ body: "v2" },
				{ "if-match": '"1"' },
			);
			expect(ok.status).toBe(200);
			expect(ok.headers.get("etag")).toBe('"2"');
			const flagged = await patchJson(call, `/api/app/notes/${note.id}`, {
				pinned: true,
				archived: true,
			});
			expect(flagged.status).toBe(200);
			const after = (await flagged.json()) as {
				pinnedAt: string | null;
				archivedAt: string | null;
				rev: number;
				stateRev: number;
			};
			expect(after.pinnedAt).not.toBeNull();
			expect(after.archivedAt).not.toBeNull();
			expect(after.rev).toBe(2);
			expect(after.stateRev).toBe(4);
			expect(
				(await patchJson(call, `/api/app/notes/${note.id}`, { frobnicate: true })).status,
			).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("a failed content write rolls back a combined patch's flags", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string; rev: number };
			store.db.run(`CREATE TRIGGER fault_on_big_body BEFORE UPDATE OF body_md ON notes
				WHEN length(new.body_md) > 1000
				BEGIN SELECT RAISE(ABORT, 'injected fault'); END`);
			const res = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ archived: true, pinned: true, body: "x".repeat(2000) },
				{ "if-match": '"1"' },
			);
			expect(res.status).toBe(500);
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				pinnedAt: string | null;
				archivedAt: string | null;
				rev: number;
				stateRev: number;
			};
			expect(after.body).toBe("v1");
			expect(after.rev).toBe(1);
			expect(after.stateRev).toBe(1);
			expect(after.pinnedAt).toBeNull();
			expect(after.archivedAt).toBeNull();
		} finally {
			http.stop();
		}
	});

	test("note body caps at NOTE_BODY_MAX on every content door", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const over = "x".repeat(1_000_001);
			const atCap = "x".repeat(1_000_000);

			const refusedCreate = await create(call, { title: "t", body: over });
			expect(refusedCreate.status).toBe(422);
			const created = await create(call, { title: "t", body: atCap });
			expect(created.status).toBe(201);
			const note = (await created.json()) as { id: string; rev: number; body: string };
			expect(note.body).toBe(atCap);

			const refusedPatch = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ body: over },
				{ "if-match": `"${note.rev}"` },
			);
			expect(refusedPatch.status).toBe(422);
			const patched = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ body: "small" },
				{ "if-match": `"${note.rev}"` },
			);
			expect(patched.status).toBe(200);

			const refusedAppend = await postJson(call, `/api/app/notes/${note.id}/append`, {
				text: over,
			});
			expect(refusedAppend.status).toBe(422);
			const refusedResult = await postJson(call, `/api/app/notes/${note.id}/append`, {
				text: atCap,
			});
			expect(refusedResult.status).toBe(422);
			const unchanged = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
			};
			expect(unchanged.body).toBe("small");
			const text = "x".repeat(1_000_000 - "small\n\n".length);
			const appended = await postJson(call, `/api/app/notes/${note.id}/append`, { text });
			expect(appended.status).toBe(200);
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
			};
			expect(after.body).toBe(`small\n\n${text}`);
			expect(after.body.length).toBe(1_000_000);
		} finally {
			http.stop();
		}
	});

	test("ordinary editor saves can rename and reduce existing oversized notes", async () => {
		const { http, call, notes, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const n = notes.create({ title: "legacy" });
			const body = "x".repeat(1_000_006);
			store.db.run("UPDATE notes SET body_md = ? WHERE id = ?", [body, n.id]);
			const path = `/api/app/notes/${n.id}`;
			const renamed = await patchJson(
				call,
				path,
				{ title: "renamed", body },
				{ "if-match": `"${n.rev}"` },
			);
			expect(renamed.status).toBe(200);
			const saved = (await renamed.json()) as { title: string; body: string; rev: number };
			expect(saved.title).toBe("renamed");
			expect(saved.body.length).toBe(body.length);
			const refused = await patchJson(
				call,
				path,
				{ body: `${body}x`, pinned: true },
				{ "if-match": `"${saved.rev}"` },
			);
			expect(refused.status).toBe(422);
			expect(notes.get(n.id)!.pinnedAt).toBeNull();
			expect(notes.get(n.id)!.rev).toBe(saved.rev);
			const reduced = await patchJson(
				call,
				path,
				{ title: saved.title, body: body.slice(1) },
				{ "if-match": `"${saved.rev}"` },
			);
			expect(reduced.status).toBe(200);
			expect(notes.get(n.id)!.body.length).toBe(1_000_005);
		} finally {
			http.stop();
		}
	});

	test("a stale combined patch refuses before any flag mutation", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string; rev: number };
			const combo = await patchJson(
				call,
				`/api/app/notes/${note.id}`,
				{ body: "v2", pinned: true, archived: true },
				{ "if-match": '"99"' },
			);
			expect(combo.status).toBe(409);
			const after = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				pinnedAt: string | null;
				archivedAt: string | null;
				rev: number;
			};
			expect(after.body).toBe("v1");
			expect(after.pinnedAt).toBeNull();
			expect(after.archivedAt).toBeNull();
			expect(after.rev).toBe(1);
		} finally {
			http.stop();
		}
	});

	test("append is unguarded; versions list/read/restore ride it", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "one" });
			const note = (await created.json()) as { id: string };
			const appended = await postJson(call, `/api/app/notes/${note.id}/append`, {
				text: "two",
			});
			expect(appended.status).toBe(200);
			const after = (await appended.json()) as { rev: number; body: string };
			expect(after.rev).toBe(2);
			expect(after.body).toBe("one\n\ntwo");

			const versions = (await (await call(`/api/app/notes/${note.id}/versions`)).json()) as {
				versions: { rev: number; source: string }[];
			};
			expect(versions.versions).toHaveLength(1);
			expect(versions.versions[0]).toMatchObject({ rev: 1, source: "append" });
			const v1 = (await (await call(`/api/app/notes/${note.id}/versions/1`)).json()) as {
				title: string;
				body: string;
			};
			expect(v1.body).toBe("one");
			expect((await call(`/api/app/notes/${note.id}/versions/9`)).status).toBe(404);

			const restored = await call(`/api/app/notes/${note.id}/versions/1/restore`, {
				method: "POST",
				headers: { "if-match": `"${after.rev}"` },
			});
			expect(restored.status).toBe(200);
			const back = (await restored.json()) as { rev: number; body: string };
			expect(back.rev).toBe(3);
			expect(back.body).toBe("one");
		} finally {
			http.stop();
		}
	});

	test("restore is a content write — If-Match is required and guards the live rev", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "one" });
			const note = (await created.json()) as { id: string };
			await postJson(call, `/api/app/notes/${note.id}/append`, { text: "two" });
			const restore = (headers: Record<string, string> = {}) =>
				call(`/api/app/notes/${note.id}/versions/1/restore`, {
					method: "POST",
					headers,
				});
			expect((await restore()).status).toBe(428);
			expect((await restore({ "if-match": "abc" })).status).toBe(428);
			const stale = await restore({ "if-match": '"1"' });
			expect(stale.status).toBe(409);
			expect(stale.headers.get("etag")).toBe('"2"');
			const conflict = (await stale.json()) as { note: { rev: number; body: string } };
			expect(conflict.note.rev).toBe(2);
			expect(conflict.note.body).toBe("one\n\ntwo");
			const gone = await call(`/api/app/notes/${note.id}/versions/9/restore`, {
				method: "POST",
				headers: { "if-match": '"2"' },
			});
			expect(gone.status).toBe(422);
			const ok = await restore({ "if-match": '"2"' });
			expect(ok.status).toBe(200);
			const back = (await ok.json()) as { rev: number; body: string; stateRev: number };
			expect(back.rev).toBe(3);
			expect(back.body).toBe("one");
			const versions = (await (await call(`/api/app/notes/${note.id}/versions`)).json()) as {
				versions: { rev: number; source: string }[];
			};
			expect(versions.versions.map((v) => v.rev)).toEqual([2, 1]);
			expect(versions.versions[0]!.source).toBe("restore");
		} finally {
			http.stop();
		}
	});

	test("an archived note refuses every content write — 422; flags still move", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "t", body: "v1" });
			const note = (await created.json()) as { id: string };
			await postJson(call, `/api/app/notes/${note.id}/append`, { text: "x" });
			expect((await patchJson(call, `/api/app/notes/${note.id}`, { archived: true })).status).toBe(
				200,
			);

			expect(
				(await patchJson(call, `/api/app/notes/${note.id}`, { body: "v2" }, { "if-match": '"2"' }))
					.status,
			).toBe(422);
			expect((await postJson(call, `/api/app/notes/${note.id}/append`, { text: "y" })).status).toBe(
				422,
			);
			expect(
				(
					await call(`/api/app/notes/${note.id}/versions/1/restore`, {
						method: "POST",
						headers: { "if-match": '"2"' },
					})
				).status,
			).toBe(422);
			const got = (await (await call(`/api/app/notes/${note.id}`)).json()) as {
				body: string;
				rev: number;
			};
			expect(got.body).toBe("v1\n\nx");
			expect(got.rev).toBe(2);
			expect((await patchJson(call, `/api/app/notes/${note.id}`, { archived: false })).status).toBe(
				200,
			);
			expect(
				(await patchJson(call, `/api/app/notes/${note.id}`, { body: "v3" }, { "if-match": '"2"' }))
					.status,
			).toBe(200);
		} finally {
			http.stop();
		}
	});

	test("body and append text cap at the wire — over-cap is a 422, not a write", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const over = "x".repeat(NOTE_BODY_MAX + 1);
			expect((await create(call, { title: "t", body: over })).status).toBe(422);
			const created = await create(call, { title: "t" });
			const note = (await created.json()) as { id: string };
			expect(
				(await patchJson(call, `/api/app/notes/${note.id}`, { body: over }, { "if-match": '"1"' }))
					.status,
			).toBe(422);
			expect(
				(await postJson(call, `/api/app/notes/${note.id}/append`, { text: over })).status,
			).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("delete is archived-only and removes versions; move re-scopes", async () => {
		const { http, call, projects } = setup({ token: APP_TOKEN_NAME });
		try {
			const proj = projects.create({ name: "p" });
			const created = await create(call, { title: "t" });
			const note = (await created.json()) as { id: string };
			await postJson(call, `/api/app/notes/${note.id}/append`, { text: "x" });
			expect((await call(`/api/app/notes/${note.id}`, { method: "DELETE" })).status).toBe(422);
			const moved = await patchJson(call, `/api/app/notes/${note.id}`, {
				projectId: proj.id,
			});
			expect(moved.status).toBe(200);
			expect(((await moved.json()) as { projectId: string | null }).projectId).toBe(proj.id);
			const unbound = await patchJson(call, `/api/app/notes/${note.id}`, {
				projectId: null,
			});
			expect(((await unbound.json()) as { projectId: string | null }).projectId).toBeNull();

			await patchJson(call, `/api/app/notes/${note.id}`, { archived: true });
			expect((await call(`/api/app/notes/${note.id}`, { method: "DELETE" })).status).toBe(200);
			expect((await call(`/api/app/notes/${note.id}`)).status).toBe(404);
			expect((await call(`/api/app/notes/${note.id}/versions`)).status).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("a data-note part is expanded server-side; unknown notes refuse before history", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await create(call, { title: "ref", body: "the real body" });
			const note = (await created.json()) as { id: string; rev: number };
			await postJson(call, "/api/app/conversations", { id: "n-attach" });

			const res = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/n-attach",
					message: {
						id: "m1",
						role: "user",
						parts: [
							{ type: "text", text: "see attached" },
							{ type: "data-note", data: { id: note.id, title: "forged", body: "forged" } },
						],
					},
				}),
			});
			expect(res.status).toBe(200);
			await res.text();
			const history = store.history("app/n-attach");
			const part = history[0]?.parts.find((p) => p.type === "data-note") as
				| { data?: { id?: string; body?: string; title?: string; rev?: number } }
				| undefined;
			expect(part?.data?.id).toBe(note.id);
			expect(part?.data?.body).toBe("the real body");
			expect(part?.data?.title).toBe("ref");
			expect(part?.data?.rev).toBe(note.rev);

			const bad = await call("/api/app/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversationId: "app/n-attach",
					message: {
						id: "m2",
						role: "user",
						parts: [{ type: "data-note", data: { id: "ghost" } }],
					},
				}),
			});
			expect(bad.status).toBe(422);
			expect(store.history("app/n-attach").find((m) => m.id === "m2")).toBeUndefined();
		} finally {
			http.stop();
		}
	});
});

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
			const forged = await call(`/api/app/notes/${note.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", "if-match": '"2"' },
				body: JSON.stringify({ body: "forged", source: "agent" }),
			});
			expect(forged.status).toBe(422);
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
