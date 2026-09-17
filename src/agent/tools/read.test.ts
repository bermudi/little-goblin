import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "./read.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-read-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const opts = { toolCallId: "t1", messages: [] };

describe("read_file", () => {
	test("reads a file with line numbers", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt" }, opts)) as {
			content?: string;
			lines?: number;
			error?: string;
		};
		expect(out.error).toBeUndefined();
		expect(out.content).toBe("1\tone\n2\ttwo\n3\t\n");
		expect(out.lines).toBe(3); // trailing newline → empty third line
	});

	test("oversized file is refused before it is read", async () => {
		const dir = tmpdir_();
		// Sparse file: ftruncate sets size without writing real bytes.
		const fd = openSync(join(dir, "big.log"), "w");
		ftruncateSync(fd, 9 * 1024 * 1024);
		closeSync(fd);
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "big.log" }, opts)) as { error?: string };
		expect(out.error).toContain("file too large");
	});

	test("missing file and directory errors", async () => {
		const dir = tmpdir_();
		const t = readFileTool(dir);
		const missing = (await t.execute!({ path: "nope" }, opts)) as { error?: string };
		expect(missing.error).toContain("file not found");
		const asDir = (await t.execute!({ path: "." }, opts)) as { error?: string };
		expect(asDir.error).toContain("is a directory");
	});
});
