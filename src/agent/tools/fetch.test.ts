// The fetch tool's contract: every kind lands in the same output
// discipline — head+tail window on line boundaries, overflow written to
// state/webcache/ with a footer naming the read_file recovery, binary
// payloads refused with the sanctioned alternatives, and provider
// failures loud. Local extraction is readability over linkedom.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStore } from "../../auth.ts";
import type { Config } from "../../config.ts";
import { extractors, fetchTool, windowText } from "./fetch.ts";

const fakeAuth: AuthStore = {
	resolve: async (name) => `key-for-${name}`,
	has: () => true,
	names: () => ["parallel"],
};

let home: string;
let servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "goblin-web-"));
	process.env.GOBLIN_HOME = home;
});
afterEach(() => {
	for (const s of servers) s.stop(true);
	servers = [];
	delete process.env.GOBLIN_HOME;
	rmSync(home, { recursive: true, force: true });
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	return server.url.toString().replace(/\/$/, "");
}

function depsWith(fetchCfg: unknown) {
	return { configRef: { current: { fetch: fetchCfg } as unknown as Config }, auth: fakeAuth };
}

const exec = (t: ReturnType<typeof fetchTool>, input: unknown) =>
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

const ARTICLE_HTML = `<!doctype html>
<html><head><title>The Title</title></head>
<body><article><h1>The Title</h1>${"<p>Sentence about the subject matter. </p>".repeat(30)}</article></body></html>`;

describe("fetch tool — local", () => {
	test("HTML extracts to readable text with title header", async () => {
		const base = serve(() => new Response(ARTICLE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));
		const out = (await exec(fetchTool(depsWith(undefined)), { url: `${base}/page` })) as string;
		expect(out).toContain("# The Title");
		expect(out).toContain(`Source: ${base}/page`);
		expect(out).toContain("Sentence about the subject matter.");
	});

	test("text/plain passes through raw", async () => {
		const base = serve(() => new Response("just plain text\n".repeat(40), { headers: { "content-type": "text/plain" } }));
		const out = (await exec(fetchTool(depsWith(undefined)), { url: `${base}/f.txt` })) as string;
		expect(out).toContain("just plain text");
	});

	test("binary payload is refused with the bash/send_file recovery", async () => {
		const base = serve(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }));
		const out = (await exec(fetchTool(depsWith(undefined)), { url: `${base}/img.png` })) as { error: string; kind: string };
		expect(out.kind).toBe("binary");
		expect(out.error).toContain("bash");
	});

	test("overflow windows head+tail and names the webcache recovery", async () => {
		const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
		const base = serve(() => new Response(long, { headers: { "content-type": "text/plain" } }));
		const out = (await exec(fetchTool(depsWith(undefined)), { url: `${base}/big` })) as string;
		expect(out).toContain("[TRUNCATED");
		expect(out).toContain("line 0 ");
		expect(out).toContain("line 399 ");
		const match = /saved to: (\S+)/.exec(out);
		expect(match).not.toBeNull();
		const file = match?.[1] ?? "";
		expect(existsSync(file)).toBe(true);
		// The cached file carries the full text, not the window.
		expect(readFileSync(file, "utf8")).toContain("line 200 ");
	});
});

describe("fetch tool — providers", () => {
	test("parallel extract: bearer auth, full_content returned", async () => {
		let sawAuth = "";
		const base = serve(async (req) => {
			sawAuth = req.headers.get("authorization") ?? "";
			return Response.json({ results: [{ title: "Page", url: "https://example.com", full_content: "A".repeat(400) }] });
		});
		const { title, text } = await extractors.parallel("https://example.com/deep", "key-for-parallel", base);
		expect(sawAuth).toBe("Bearer key-for-parallel");
		expect(title).toBe("Page");
		expect(text).toBe("A".repeat(400));
	});

	test("provider extraction failure is loud, with the vendor's error", async () => {
		const base = serve(() =>
			Response.json({ results: [], errors: [{ url: "https://example.com", error_type: "timeout" }] }),
		);
		try {
			await extractors.parallel("https://example.com", "k", base);
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("parallel");
			expect((err as Error).message).toContain("timeout");
		}
	});
});

describe("windowText", () => {
	test("under budget passes through untruncated", () => {
		expect(windowText("short", 100)).toEqual({ window: "short", truncated: false });
	});

	test("cuts on line boundaries with a visible elision", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
		const { window, truncated } = windowText(text, 400);
		expect(truncated).toBe(true);
		expect(window).toContain("line-0");
		expect(window).toContain("line-99");
		expect(window).toContain("[…]");
		expect(window).not.toContain("line-50\n");
	});
});
