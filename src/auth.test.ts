import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuth } from "./auth.ts";

let dirs: string[] = [];
let prevHome: string | undefined;

function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-auth-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("auth.jsonl", () => {
	test("ENOENT → empty store, resolve rejects", async () => {
		useHome();
		const auth = loadAuth();
		expect(auth.has("x")).toBe(false);
		await expect(auth.resolve("x")).rejects.toThrow('no secret named "x"');
	});

	test("literal values resolve", async () => {
		const dir = useHome();
		writeFileSync(join(dir, "auth.jsonl"), '{"name":"a","value":"s3cret"}\n');
		expect(await loadAuth().resolve("a")).toBe("s3cret");
	});

	test("!command resolves via stdout", async () => {
		const dir = useHome();
		writeFileSync(
			join(dir, "auth.jsonl"),
			'{"name":"b","value":"!echo resolved-value"}\n',
		);
		expect(await loadAuth().resolve("b")).toBe("resolved-value");
	});

	test("failing !command rejects with the secret name, not the value", async () => {
		const dir = useHome();
		writeFileSync(join(dir, "auth.jsonl"), '{"name":"c","value":"!exit 3"}\n');
		await expect(loadAuth().resolve("c")).rejects.toThrow('"c"');
	});

	test("malformed line fails loud with line number", () => {
		const dir = useHome();
		writeFileSync(join(dir, "auth.jsonl"), '{"name":"a","value":"x"}\nnot json\n');
		expect(() => loadAuth()).toThrow("auth.jsonl:2");
	});
});
