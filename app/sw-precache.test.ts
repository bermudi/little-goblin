import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tmpDir } from "../src/testkit.ts";
import { injectPrecache } from "./sw-precache.ts";

const MARKER = "const SHELL = null; // replaced at build: { build, files }";

function distFixture(swSource = MARKER): string {
	const dir = tmpDir("goblin-dist-");
	writeFileSync(join(dir, "index.html"), "<html>shell</html>");
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
	writeFileSync(join(dir, "assets", "app.js.map"), "{}");
	writeFileSync(join(dir, "sw.js"), swSource);
	mkdirSync(join(dir, ".vite"));
	writeFileSync(join(dir, ".vite", "manifest.json"), "{}");
	return dir;
}

describe("injectPrecache", () => {
	test("lists every dist file as a /app/ URL, excluding sw.js, maps and .vite", () => {
		const { files } = injectPrecache(distFixture());
		expect(files).toEqual(["/app/assets/app.js", "/app/index.html"]);
	});

	test("stamps the marker exactly once and the build is 16 hex", () => {
		const dir = distFixture();
		const { build, files } = injectPrecache(dir);
		expect(build).toMatch(/^[0-9a-f]{16}$/);
		const stamped = readFileSync(join(dir, "sw.js"), "utf8");
		expect(stamped).toBe(`const SHELL = ${JSON.stringify({ build, files })};`);
	});

	test("the hash changes when any file's bytes change", () => {
		const dir = distFixture();
		const first = injectPrecache(dir).build;
		writeFileSync(join(dir, "index.html"), "<html>shell v2</html>");
		writeFileSync(join(dir, "sw.js"), MARKER);
		expect(injectPrecache(dir).build).not.toBe(first);
	});

	test("a missing marker throws", () => {
		expect(() => injectPrecache(distFixture("const SHELL = null;"))).toThrow(
			/precache marker found 0 times/,
		);
	});

	test("a duplicated marker throws", () => {
		expect(() => injectPrecache(distFixture(`${MARKER}\n${MARKER}`))).toThrow(
			/precache marker found 2 times/,
		);
	});
});
