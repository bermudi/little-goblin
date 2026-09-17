import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
