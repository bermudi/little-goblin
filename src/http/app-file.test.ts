// The document-reader route: conversation-scoped, realpath-contained,
// capped, denied-list enforced — exercised through the real HTTP layer.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.ts";
import { tmpDir } from "../testkit.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

const make = async () => {
	const s = setup();
	await s.call("/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id: "file-01" }),
	});
	return s;
};

const get = (s: ReturnType<typeof setup>, conv: string, path: string) =>
	s.call(`/api/app/conversations/${conv}/file?path=${encodeURIComponent(path)}`);

describe("GET /api/app/conversations/:id/file", () => {
	test("a workspace file serves its bytes with a typed body", async () => {
		const s = await make();
		try {
			mkdirSync(join(paths.workspace(), "wiki"), { recursive: true });
			writeFileSync(join(paths.workspace(), "wiki", "index.md"), "# Index\nhello");
			const res = await get(s, "file-01", "wiki/index.md");
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("# Index\nhello");
			expect(res.headers.get("content-type")).toContain("text/markdown");
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(res.headers.get("content-disposition")).toBe("attachment");
		} finally {
			s.http.stop();
		}
	});

	test("escapes, .git and auth.jsonl are refused; missing is 404", async () => {
		const s = await make();
		try {
			writeFileSync(join(s.home, "outside.txt"), "x");
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(join(paths.workspace(), "auth.jsonl"), "{}");
			mkdirSync(join(paths.workspace(), ".git"), { recursive: true });
			writeFileSync(join(paths.workspace(), ".git", "config"), "x");
			expect((await get(s, "file-01", "../outside.txt")).status).toBe(403);
			expect((await get(s, "file-01", "auth.jsonl")).status).toBe(403);
			expect((await get(s, "file-01", ".git/config")).status).toBe(403);
			expect((await get(s, "file-01", "nope.md")).status).toBe(404);
			expect((await get(s, "file-01", "")).status).toBe(422);
		} finally {
			s.http.stop();
		}
	});

	test("unknown and method-wrong requests refuse", async () => {
		const s = await make();
		try {
			expect((await get(s, "ghost-99", "x.md")).status).toBe(404);
			expect(
				(
					await s.call("/api/app/conversations/file-01/file?path=x.md", { method: "POST" })
				).status,
			).toBe(405);
		} finally {
			s.http.stop();
		}
	});

	test("a project-bound conversation reads its own dir, not the workspace's", async () => {
		const s = setup();
		try {
			// A linked project dir lives outside goblin's home.
			const projDir = join(tmpDir("goblin-proj-"), "proj");
			mkdirSync(projDir, { recursive: true });
			writeFileSync(join(projDir, "proj.md"), "project file");
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(join(paths.workspace(), "ws.md"), "workspace file");
			const project = s.projects.create({ name: "P", dir: projDir });
			await s.call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "proj-01", projectId: project.id }),
			});
			const own = await get(s, "proj-01", "proj.md");
			expect(own.status).toBe(200);
			expect(await own.text()).toBe("project file");
			// The workspace is outside this conversation's root — a
			// cross-root read is a containment refusal, not a fall-back.
			expect((await get(s, "proj-01", "ws.md")).status).toBe(404);
			expect((await get(s, "proj-01", `${paths.workspace()}/ws.md`)).status).toBe(403);
		} finally {
			s.http.stop();
		}
	});

	test("bearer auth still gates the route", async () => {
		const s = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await s.call("/api/app/conversations/file-01/file?path=x", {}, "wrong");
			expect(res.status).toBe(401);
		} finally {
			s.http.stop();
		}
	});
});
