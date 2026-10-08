import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAppDist } from "./app-dist.ts";

function makeDist(): string {
	const dist = mkdtempSync(join(tmpdir(), "goblin-app-dist-"));
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(join(dist, "index.html"), "<html><body>goblin</body></html>");
	writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log('x')");
	writeFileSync(join(dist, "assets", "index-abc123.css"), "body{}");
	return dist;
}

describe("serveAppDist", () => {
	test("missing build answers a loud 500, not an empty page", async () => {
		const res = await serveAppDist("", join(tmpdir(), "goblin-no-such-dist"));
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("app:build");
	});

	test("the root serves index.html no-store", async () => {
		const res = await serveAppDist("", makeDist());
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.text()).toContain("goblin");
	});

	test("hashed assets serve with immutable caching and the right type", async () => {
		const dist = makeDist();
		const js = await serveAppDist("assets/index-abc123.js", dist);
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toContain("text/javascript");
		expect(js.headers.get("cache-control")).toContain("immutable");
		const css = await serveAppDist("assets/index-abc123.css", dist);
		expect(css.headers.get("content-type")).toContain("text/css");
	});

	test("traversal attempts never escape the dist dir", async () => {
		const dist = makeDist();
		for (const rel of [
			"../conversation.ts",
			"..",
			"assets/../../secret",
			"a/../../../etc/passwd",
		]) {
			const res = await serveAppDist(rel, dist);
			expect(res.status).toBe(404);
		}
	});

	test("missing files and directories answer 404", async () => {
		const dist = makeDist();
		expect((await serveAppDist("nope.js", dist)).status).toBe(404);
		expect((await serveAppDist("assets", dist)).status).toBe(404);
	});
});
