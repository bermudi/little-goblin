import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { APP_TOKEN_NAME, setup } from "./app-test-util.ts";

describe("app projects", () => {
	const postJson = (call: ReturnType<typeof setup>["call"], path: string, body: unknown) =>
		call(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const patchJson = (call: ReturnType<typeof setup>["call"], path: string, body: unknown) =>
		call(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	test("create, get, list, patch — and the wire carries no home", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const created = await postJson(call, "/api/app/projects", {
				name: "Side Project",
				instructions: "be terse",
			});
			expect(created.status).toBe(201);
			const project = (await created.json()) as Record<string, unknown>;
			expect(project).toMatchObject({
				name: "Side Project",
				slug: "side-project",
				managed: true,
				instructions: "be terse",
				memory: "shared",
				archivedAt: null,
			});
			// Goblin-owned scratch never leaves the server.
			expect("home" in project).toBe(false);

			const id = project.id as string;
			expect((await call(`/api/app/projects/${id}`)).status).toBe(200);
			const list = (await (await call("/api/app/projects")).json()) as {
				projects: { id: string }[];
			};
			expect(list.projects.map((p) => p.id)).toEqual([id]);

			const patched = await patchJson(call, `/api/app/projects/${id}`, {
				name: "Renamed",
				archived: true,
			});
			expect(patched.status).toBe(200);
			const after = (await patched.json()) as {
				name: string;
				slug: string;
				archivedAt: string | null;
			};
			expect(after.name).toBe("Renamed");
			// The slug is frozen — a rename never moves the home.
			expect(after.slug).toBe("side-project");
			expect(after.archivedAt).not.toBeNull();
		} finally {
			http.stop();
		}
	});

	test("unknown projects 404; validation and linked-dir refusals 422; dir is immutable", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/projects/ghost")).status).toBe(404);
			expect((await patchJson(call, "/api/app/projects/ghost", { name: "x" })).status).toBe(404);

			expect((await postJson(call, "/api/app/projects", { name: "  " })).status).toBe(422);
			expect(
				(await postJson(call, "/api/app/projects", { name: "x", dir: "relative/dir" })).status,
			).toBe(422);
			expect((await patchJson(call, "/api/app/projects/ghost", {})).status).toBe(404);

			const created = await postJson(call, "/api/app/projects", { name: "p" });
			const { id } = (await created.json()) as { id: string };
			const immutable = await patchJson(call, `/api/app/projects/${id}`, {
				dir: "/elsewhere",
			});
			expect(immutable.status).toBe(422);
			expect(((await immutable.json()) as { error: string }).error).toContain("immutable");
			expect((await patchJson(call, `/api/app/projects/${id}`, {})).status).toBe(422);
		} finally {
			http.stop();
		}
	});

	test("a conversation created with projectId binds; summaries carry it; reposts conflict", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const project = (await (await postJson(call, "/api/app/projects", { name: "p" })).json()) as {
				id: string;
			};

			const created = await postJson(call, "/api/app/conversations", {
				id: "bound-01",
				projectId: project.id,
			});
			expect(created.status).toBe(201);
			expect(store.get("app/bound-01")?.projectId).toBe(project.id);

			const list = (await (await call("/api/app/conversations")).json()) as {
				conversations: { id: string; projectId: string | null }[];
			};
			expect(list.conversations.find((c) => c.id === "app/bound-01")?.projectId).toBe(project.id);

			// Reposting the same id + project is idempotent; a different
			// project — or no project — conflicts.
			expect(
				(
					await postJson(call, "/api/app/conversations", {
						id: "bound-01",
						projectId: project.id,
					})
				).status,
			).toBe(201);
			const other = (await (
				await postJson(call, "/api/app/projects", { name: "other" })
			).json()) as { id: string };
			const mismatch = await postJson(call, "/api/app/conversations", {
				id: "bound-01",
				projectId: other.id,
			});
			expect(mismatch.status).toBe(409);
			expect(((await mismatch.json()) as { error: string }).error).toContain(
				"binding is fixed at creation",
			);
			expect((await postJson(call, "/api/app/conversations", { id: "bound-01" })).status).toBe(409);

			// An existing unbound row can't be bound after the fact either.
			await postJson(call, "/api/app/conversations", { id: "loose-01" });
			expect(
				(
					await postJson(call, "/api/app/conversations", {
						id: "loose-01",
						projectId: project.id,
					})
				).status,
			).toBe(409);
		} finally {
			http.stop();
		}
	});

	test("unknown and archived projects refuse new chats — 404 and 422", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect(
				(
					await postJson(call, "/api/app/conversations", {
						id: "x-1",
						projectId: "no-such-project",
					})
				).status,
			).toBe(404);

			const project = (await (await postJson(call, "/api/app/projects", { name: "p" })).json()) as {
				id: string;
			};
			await patchJson(call, `/api/app/projects/${project.id}`, { archived: true });
			const res = await postJson(call, "/api/app/conversations", {
				id: "x-2",
				projectId: project.id,
			});
			expect(res.status).toBe(422);
			expect(((await res.json()) as { error: string }).error).toContain("archived");
		} finally {
			http.stop();
		}
	});

	test("a memory-off project stamps new conversations excluded", async () => {
		const { http, call, store } = setup({ token: APP_TOKEN_NAME });
		try {
			const project = (await (
				await postJson(call, "/api/app/projects", { name: "vault", memory: "off" })
			).json()) as { id: string };
			await postJson(call, "/api/app/conversations", { id: "v-1", projectId: project.id });
			expect(store.get("app/v-1")?.memoryExcluded).toBe(true);
			// A plain chat stays eligible.
			await postJson(call, "/api/app/conversations", { id: "v-2" });
			expect(store.get("app/v-2")?.memoryExcluded).toBe(false);
		} finally {
			http.stop();
		}
	});

	test("a project conversation's tools resolve the project dir; a vanished dir fails the turn", async () => {
		const workdirs: string[] = [];
		const { http, call } = setup({ token: APP_TOKEN_NAME, workdirs });
		try {
			const project = (await (await postJson(call, "/api/app/projects", { name: "p" })).json()) as {
				id: string;
				dir: string;
			};
			await postJson(call, "/api/app/conversations", { id: "w-1", projectId: project.id });
			await postJson(call, "/api/app/conversations", { id: "w-2" });

			const chat = (id: string) =>
				call("/api/app/chat", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversationId: `app/${id}`,
						message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
					}),
				});

			const bound = await chat("w-1");
			expect(bound.status).toBe(200);
			await bound.text();
			expect(workdirs.at(-1)).toBe(project.dir);
			const loose = await chat("w-2");
			expect(loose.status).toBe(200);
			await loose.text();
			expect(workdirs.at(-1)).toBe(join(process.env.GOBLIN_HOME!, "workspace"));

			// The dir vanishes — the turn fails at admission, and the
			// error chunk names the missing path.
			rmSync(project.dir, { recursive: true, force: true });
			const gone = await chat("w-1");
			expect(gone.status).toBe(200);
			const body = await gone.text();
			expect(body).toContain('"type":"error"');
			expect(body).toContain(project.dir.replaceAll("\\", "\\\\"));
		} finally {
			http.stop();
		}
	});
});
