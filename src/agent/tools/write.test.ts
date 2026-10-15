import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileTool } from "./write.ts";
import { tmpDir } from "../../testkit.ts";

const opts = { toolCallId: "t1", messages: [], context: {} };

describe("write_file", () => {
	test("creates a new file with the requested content", async () => {
		const dir = tmpDir("goblin-write-");
		const out = (await writeFileTool(dir).execute!(
			{ path: "f.txt", content: "hello\n" },
			opts,
		)) as {
			path?: string;
			error?: string;
		};
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("hello\n");
		expect(out.path).toBe(join(dir, "f.txt"));
	});
});

describe("write_file through leaf symlinks", () => {
	// design/delegation.md: symlinked files are written through to the
	// managed target, never replaced — tmp+rename over the link path
	// silently forks the config and the dots store stops propagating.
	test("relative leaf symlink: write lands on the target, link survives", async () => {
		const dir = tmpDir("goblin-write-");
		writeFileSync(join(dir, "real.txt"), "old\n");
		symlinkSync("real.txt", join(dir, "link.txt"));
		const out = (await writeFileTool(dir).execute!(
			{ path: "link.txt", content: "new\n" },
			opts,
		)) as {
			path?: string;
			error?: string;
		};
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("new\n");
		expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(dir, "link.txt"), "utf8")).toBe("new\n");
		expect(out.path).toBe(join(dir, "real.txt"));
	});

	test("absolute leaf symlink: write lands on the target", async () => {
		const dir = tmpDir("goblin-write-");
		writeFileSync(join(dir, "real.txt"), "old\n");
		symlinkSync(join(dir, "real.txt"), join(dir, "abs-link.txt"));
		const out = (await writeFileTool(dir).execute!(
			{ path: "abs-link.txt", content: "new\n" },
			opts,
		)) as { error?: string };
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("new\n");
		expect(lstatSync(join(dir, "abs-link.txt")).isSymbolicLink()).toBe(true);
	});

	test("symlink chain resolves to the file it manages", async () => {
		const dir = tmpDir("goblin-write-");
		writeFileSync(join(dir, "real.txt"), "old\n");
		symlinkSync("real.txt", join(dir, "link1.txt"));
		symlinkSync("link1.txt", join(dir, "link2.txt"));
		const out = (await writeFileTool(dir).execute!(
			{ path: "link2.txt", content: "new\n" },
			opts,
		)) as {
			error?: string;
		};
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("new\n");
		expect(lstatSync(join(dir, "link1.txt")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "link2.txt")).isSymbolicLink()).toBe(true);
	});

	test("dangling leaf symlink fails loudly and the link is untouched", async () => {
		const dir = tmpDir("goblin-write-");
		symlinkSync("missing.txt", join(dir, "dangling.txt"));
		const out = (await writeFileTool(dir).execute!(
			{ path: "dangling.txt", content: "new\n" },
			opts,
		)) as { error?: string };
		expect(out.error).toContain("dangling");
		expect(lstatSync(join(dir, "dangling.txt")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(dir, "missing.txt"))).toBe(false);
	});
});
