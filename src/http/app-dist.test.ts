import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { acceptsEncoding, serveAppDist } from "./app-dist.ts";

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

describe("serveAppDist compression", () => {
	const big = "export const x = 1;\n".repeat(4000);

	function distWith(js: string): string {
		const dist = makeDist();
		writeFileSync(join(dist, "assets", "index-abc123.js"), js);
		return dist;
	}

	test("brotli is preferred when the client accepts it", async () => {
		const dist = distWith(big);
		const res = await serveAppDist("assets/index-abc123.js", dist, "gzip, deflate, br");
		expect(res.headers.get("content-encoding")).toBe("br");
		expect(res.headers.get("vary")).toBe("accept-encoding");
		expect(res.headers.get("cache-control")).toContain("immutable");
		const sent = new Uint8Array(await res.arrayBuffer());
		expect(sent.length).toBeLessThan(big.length / 10);
		expect(brotliDecompressSync(sent).toString("utf8")).toBe(big);
	});

	test("gzip when brotli is not accepted", async () => {
		const dist = distWith(big);
		const res = await serveAppDist("assets/index-abc123.js", dist, "gzip");
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString("utf8")).toBe(big);
	});

	test("identity when no encoding is accepted, but Vary still names the header", async () => {
		const dist = distWith(big);
		for (const header of [null, "identity", "br;q=0, gzip;q=0", "*"]) {
			const res = await serveAppDist("assets/index-abc123.js", dist, header);
			expect(res.headers.get("content-encoding")).toBeNull();
			expect(res.headers.get("vary")).toBe("accept-encoding");
			expect(await res.text()).toBe(big);
		}
	});

	test("q=0 on brotli falls through to gzip", async () => {
		const dist = distWith(big);
		const res = await serveAppDist("assets/index-abc123.js", dist, "br;q=0, gzip");
		expect(res.headers.get("content-encoding")).toBe("gzip");
	});

	test("binary formats are never re-encoded", async () => {
		const dist = makeDist();
		writeFileSync(join(dist, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const res = await serveAppDist("icon.png", dist, "br, gzip");
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("vary")).toBeNull();
	});

	test("a rebuilt file is recompressed, not served from the old cache", async () => {
		const dist = distWith(big);
		const first = await serveAppDist("assets/index-abc123.js", dist, "br");
		await first.arrayBuffer();
		const next = `${big}export const y = 2;\n`;
		writeFileSync(join(dist, "assets", "index-abc123.js"), next);
		const second = await serveAppDist("assets/index-abc123.js", dist, "br");
		const body = brotliDecompressSync(new Uint8Array(await second.arrayBuffer())).toString("utf8");
		expect(body).toBe(next);
	});

	test("acceptsEncoding parses q-values and ignores other codings", () => {
		expect(acceptsEncoding("br", "br")).toBe(true);
		expect(acceptsEncoding("BR ; q=0.5", "br")).toBe(true);
		expect(acceptsEncoding("brotli", "br")).toBe(false);
		expect(acceptsEncoding("br;q=0", "br")).toBe(false);
		expect(acceptsEncoding("x-gzip", "gzip")).toBe(false);
		expect(acceptsEncoding(null, "gzip")).toBe(false);
	});
});
