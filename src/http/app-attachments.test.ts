import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { APP_TOKEN_NAME, setup } from "./app-test-util.ts";

describe("app channel http", () => {
	test("multipart upload lands durably in workspace/attachments", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([1, 2, 3, 4, 5]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				ref: { path: string; mediaType: string; filename: string; size: number };
			};
			expect(body.ref.filename).toBe("shot.png");
			expect(body.ref.mediaType).toBe("image/png");
			expect(body.ref.size).toBe(5);
			expect(body.ref.path).toContain(join(home, "workspace", "attachments"));
			expect(readFileSync(body.ref.path)).toEqual(Buffer.from(bytes));
		} finally {
			http.stop();
		}
	});

	test("GET attachments/<name> serves stored bytes, confined to the dir", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const bytes = new Uint8Array([137, 80, 78, 71, 13]);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: "image/png" }), "shot.png");
			const up = await call("/api/app/attachments", { method: "POST", body: form });
			const { ref } = (await up.json()) as { ref: { path: string } };
			const name = ref.path.split("/").pop()!;

			const res = await call(`/api/app/attachments/${encodeURIComponent(name)}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			// Operator content serves inert: no shared caches, no sniffing,
			// a navigated document lands sandboxed.
			expect(res.headers.get("cache-control")).toContain("private");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("content-security-policy")).toBe("sandbox");
			expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(bytes));

			// A path segment is a basename, not a route out of the dir —
			// traversal and dotfile temps refuse before touching disk.
			for (const bad of ["..%2F..%2Fconfig.json", ".deadbeef.tmp", "sub%2Ff.png"]) {
				expect((await call(`/api/app/attachments/${bad}`)).status).toBe(400);
			}
			expect((await call("/api/app/attachments/nope.png")).status).toBe(404);
			// Bearer-less in token mode is refused like every other route.
			expect((await call(`/api/app/attachments/${name}`, {}, null)).status).toBe(401);
		} finally {
			http.stop();
		}
	});

	test("an upload with no file part is a clean 400, nothing written", async () => {
		const { http, call, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const form = new FormData();
			form.append("note", "no file here");
			const res = await call("/api/app/attachments", { method: "POST", body: form });
			expect(res.status).toBe(400);
			const attDir = join(home, "workspace", "attachments");
			const stat = statSync(attDir, { throwIfNoEntry: false });
			expect(stat === undefined || readdirSync(attDir).length === 0).toBe(true);
		} finally {
			http.stop();
		}
	});
});
