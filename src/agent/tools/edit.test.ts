import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool } from "./edit.ts";

let dirs: string[] = [];
function tmpdir_(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-edit-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const opts = { toolCallId: "t1", messages: [] };

describe("edit_file", () => {
	test("new_string is literal — $&, $1, $` are not interpolated", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "hello world\n");
		const t = editFileTool(dir);
		const out = (await t.execute!(
			{ path: "f.txt", old_string: "world", new_string: "cost is $& plus $1" },
			opts,
		)) as { path?: string; error?: string };
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("hello cost is $& plus $1\n");
	});

	test("unique match required unless replace_all", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "x x\n");
		const t = editFileTool(dir);
		const dup = (await t.execute!(
			{ path: "f.txt", old_string: "x", new_string: "y" },
			opts,
		)) as { error?: string };
		expect(dup.error).toContain("2 times");
		const all = (await t.execute!(
			{ path: "f.txt", old_string: "x", new_string: "y", replace_all: true },
			opts,
		)) as { error?: string };
		expect(all.error).toBeUndefined();
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("y y\n");
	});

	test("oversized file is refused before it is read", async () => {
		const dir = tmpdir_();
		const fd = openSync(join(dir, "big.log"), "w");
		ftruncateSync(fd, 9 * 1024 * 1024);
		closeSync(fd);
		const t = editFileTool(dir);
		const out = (await t.execute!(
			{ path: "big.log", old_string: "x", new_string: "y" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("file too large");
	});

	test("binary file is refused, not mangled by a utf8 round-trip", async () => {
		const dir = tmpdir_();
		const bytes = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]);
		writeFileSync(join(dir, "b.bin"), bytes);
		const t = editFileTool(dir);
		const out = (await t.execute!(
			{ path: "b.bin", old_string: "x", new_string: "y" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("binary file");
		expect(readFileSync(join(dir, "b.bin"))).toEqual(bytes); // untouched
	});
});
