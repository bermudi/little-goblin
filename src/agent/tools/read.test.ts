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

	test("byte-cap truncation reports shown honestly", async () => {
		const dir = tmpdir_();
		// ~126KB across 3000 lines — blows past the 64KB output cap.
		writeFileSync(
			join(dir, "f.txt"),
			Array.from({ length: 3000 }, (_, i) => `line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).join("\n"),
		);
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt" }, opts)) as {
			content?: string;
			shown?: number;
		};
		expect(out.content).toContain("truncated");
		// shown counts the lines actually emitted — the marker line isn't one.
		expect(out.shown).toBe(out.content!.split("\n").length - 1);
		expect(out.shown!).toBeLessThan(3000);
	});

	test("a NUL past the first 8KB still marks the file binary", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.bin"), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.bin" }, opts)) as { error?: string };
		expect(out.error).toContain("binary file");
	});

	test("invalid utf-8 is refused, not lossily decoded", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.bin"), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.bin" }, opts)) as { error?: string };
		expect(out.error).toContain("binary file");
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
