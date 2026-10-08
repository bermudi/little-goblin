import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
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

const opts = { toolCallId: "t1", messages: [], context: {} };

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
		const dup = (await t.execute!({ path: "f.txt", old_string: "x", new_string: "y" }, opts)) as {
			error?: string;
		};
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
		const out = (await t.execute!({ path: "big.log", old_string: "x", new_string: "y" }, opts)) as {
			error?: string;
		};
		expect(out.error).toContain("file too large");
	});

	test("binary file is refused, not mangled by a utf8 round-trip", async () => {
		const dir = tmpdir_();
		const bytes = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]);
		writeFileSync(join(dir, "b.bin"), bytes);
		const t = editFileTool(dir);
		const out = (await t.execute!({ path: "b.bin", old_string: "x", new_string: "y" }, opts)) as {
			error?: string;
		};
		expect(out.error).toContain("binary file");
		expect(readFileSync(join(dir, "b.bin"))).toEqual(bytes); // untouched
	});

	test("a no-match returns an error and leaves the file untouched", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "original content\n");
		const t = editFileTool(dir);
		const out = (await t.execute!(
			{ path: "f.txt", old_string: "not in file", new_string: "replacement" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("not found");
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("original content\n");
	});
});

describe("edit_file through leaf symlinks", () => {
	// design/delegation.md: symlinked files are written through to the
	// managed target, never replaced — tmp+rename over the link path
	// silently forks the config and the dots store stops propagating.
	test("relative leaf symlink: edit lands on the target, link survives", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "real.txt"), "one\ntwo\n");
		symlinkSync("real.txt", join(dir, "link.txt"));
		const out = (await editFileTool(dir).execute!(
			{ path: "link.txt", old_string: "two", new_string: "TWO" },
			opts,
		)) as { path?: string; error?: string; replaced?: number };
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("one\nTWO\n");
		expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(dir, "link.txt"), "utf8")).toBe("one\nTWO\n");
		expect(out.path).toBe(join(dir, "real.txt"));
	});

	test("absolute leaf symlink: edit lands on the target", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "real.txt"), "alpha\n");
		symlinkSync(join(dir, "real.txt"), join(dir, "abs-link.txt"));
		const out = (await editFileTool(dir).execute!(
			{ path: "abs-link.txt", old_string: "alpha", new_string: "beta" },
			opts,
		)) as { error?: string };
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("beta\n");
		expect(lstatSync(join(dir, "abs-link.txt")).isSymbolicLink()).toBe(true);
	});

	test("symlink chain resolves to the file it manages", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "real.txt"), "x\n");
		symlinkSync("real.txt", join(dir, "link1.txt"));
		symlinkSync("link1.txt", join(dir, "link2.txt"));
		const out = (await editFileTool(dir).execute!(
			{ path: "link2.txt", old_string: "x", new_string: "y" },
			opts,
		)) as { error?: string };
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("y\n");
		expect(lstatSync(join(dir, "link1.txt")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "link2.txt")).isSymbolicLink()).toBe(true);
	});

	test("dangling leaf symlink fails loudly and the link is untouched", async () => {
		const dir = tmpdir_();
		symlinkSync("missing.txt", join(dir, "dangling.txt"));
		const out = (await editFileTool(dir).execute!(
			{ path: "dangling.txt", old_string: "x", new_string: "y" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("dangling");
		expect(lstatSync(join(dir, "dangling.txt")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(dir, "missing.txt"))).toBe(false);
	});
});
