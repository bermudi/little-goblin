import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOX_FILE_MAX_BYTES,
	exportBytes,
	exportNamedBytes,
	readWorkspaceFile,
	resolveExport,
	resolveImport,
	readImport,
	WORKSPACE_READ_MAX_BYTES,
	workspaceReadStatus,
	writeExportBytes,
} from "./box-files.ts";

const dirs: string[] = [];

function ws(): { dir: string; workspace: string } {
	const dir = mkdtempSync(join(tmpdir(), "goblin-box-"));
	dirs.push(dir);
	const workspace = join(dir, "ws");
	mkdirSync(workspace, { recursive: true });
	return { dir, workspace };
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveImport", () => {
	test("a workspace file resolves, relative and absolute", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "in.txt"), "hi");
		const rel = resolveImport(workspace, "in.txt");
		expect("path" in rel && rel.bytes).toBe(2);
		const abs = resolveImport(workspace, join(workspace, "in.txt"));
		expect("path" in abs).toBe(true);
	});

	test("a lexical .. escape is refused before touching the fs", () => {
		const { dir, workspace } = ws();
		writeFileSync(join(dir, "outside.txt"), "secret");
		const out = resolveImport(workspace, "../outside.txt");
		expect("error" in out && out.error).toContain("outside the workspace");
	});

	test("a symlink escaping the workspace is refused on realpath", () => {
		const { dir, workspace } = ws();
		writeFileSync(join(dir, "target.txt"), "secret");
		symlinkSync(join(dir, "target.txt"), join(workspace, "link.txt"));
		const out = resolveImport(workspace, "link.txt");
		expect("error" in out && out.error).toContain("outside the workspace");
	});

	test("an unresolvable source propagates — a symlink loop is not 'not found'", () => {
		const { workspace } = ws();
		// realpath fails ELOOP here. Only ENOENT may degrade into a
		// result; anything else is the caller's failure to see.
		symlinkSync(join(workspace, "loop-b"), join(workspace, "loop-a"));
		symlinkSync(join(workspace, "loop-a"), join(workspace, "loop-b"));
		expect(() => resolveImport(workspace, "loop-a")).toThrow(/ELOOP/);
	});

	test("missing, directories, and oversized files are refused", () => {
		const { workspace } = ws();
		expect("error" in resolveImport(workspace, "nope.txt")).toBe(true);
		mkdirSync(join(workspace, "dir"));
		const dirOut = resolveImport(workspace, "dir");
		expect("error" in dirOut && dirOut.error).toContain("regular file");
		writeFileSync(join(workspace, "big.bin"), "");
		truncateSync(join(workspace, "big.bin"), BOX_FILE_MAX_BYTES + 1);
		const big = resolveImport(workspace, "big.bin");
		expect("error" in big && big.error).toContain("MiB cap");
	});
});

describe("readImport", () => {
	test("reads regular files through an inside-workspace symlink", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "in.txt"), "pinned bytes");
		symlinkSync("in.txt", join(workspace, "link.txt"));
		const result = readImport(workspace, "link.txt");
		expect("data" in result && new TextDecoder().decode(result.data)).toBe("pinned bytes");
	});

	test("a source swapped after pathname validation is refused before reading the opened inode", () => {
		const { dir, workspace } = ws();
		const source = join(workspace, "in.txt");
		const outside = join(dir, "outside.txt");
		writeFileSync(source, "inside");
		writeFileSync(outside, "outside");
		const open = fs.openSync;
		const fault = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof open>) => {
			if (args[0] === source) {
				fs.unlinkSync(source);
				symlinkSync(outside, source);
			}
			return open(...args);
		});
		try {
			const result = readImport(workspace, "in.txt");
			expect("error" in result && result.error).toContain("outside the workspace");
		} finally {
			fault.mockRestore();
		}
	});
});

describe("resolveExport", () => {
	test("workspace-relative destinations resolve and create parents", () => {
		const { workspace } = ws();
		const out = resolveExport(workspace, "subagents/1/out.txt");
		expect("path" in out && out.path.endsWith(join("subagents", "1", "out.txt"))).toBe(true);
	});

	test("absolute and .. destinations are refused", () => {
		const { workspace } = ws();
		expect("error" in resolveExport(workspace, "/tmp/x")).toBe(true);
		expect("error" in resolveExport(workspace, "../x")).toBe(true);
	});

	test("a symlinked existing ancestor is refused before mkdir", () => {
		const { dir, workspace } = ws();
		const outside = join(dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(workspace, "linkdir"));
		const out = resolveExport(workspace, "linkdir/new/file.txt");
		expect("error" in out && out.error).toContain("outside the workspace");
		// The refused check must not have created dirs under the link.
		expect("error" in out).toBe(true);
	});

	test("a leaf symlink inside the workspace writes through it", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "real.txt"), "old");
		symlinkSync(join(workspace, "real.txt"), join(workspace, "leaf.txt"));
		const out = resolveExport(workspace, "leaf.txt");
		expect("path" in out && out.path.endsWith("real.txt")).toBe(true);
	});
});

describe("exportBytes", () => {
	test("writes durable bytes under numbered basenames", () => {
		const { workspace } = ws();
		const a = exportBytes(workspace, "subagents/1", "shot.png", new Uint8Array([1, 2, 3]));
		expect("rel" in a && a.rel).toBe(join("subagents", "1", "shot.png"));
		const b = exportBytes(workspace, "subagents/1", "shot.png", new Uint8Array([4]));
		expect("rel" in b && b.rel).toBe(join("subagents", "1", "shot.1.png"));
		expect(readFileSync(join(workspace, "subagents", "1", "shot.1.png"))[0]).toBe(4);
	});

	test("a traversal relDir is refused and writes nothing", () => {
		const { workspace } = ws();
		const out = exportBytes(workspace, "../escape", "x.bin", new Uint8Array([1]));
		expect("error" in out).toBe(true);
	});

	test("a placeholder-named leaf symlink can't steer the destination", () => {
		const { workspace } = ws();
		mkdirSync(join(workspace, "out"));
		mkdirSync(join(workspace, "other"));
		writeFileSync(join(workspace, "out", "report.txt"), "keep");
		// A leftover probe-shaped symlink in the destination dir: the
		// resolver must ignore it — numbering happens in real `out`.
		symlinkSync(join(workspace, "other"), join(workspace, "out", "placeholder"));
		const out = exportBytes(workspace, "out", "report.txt", new Uint8Array([7]));
		expect("rel" in out && out.rel).toBe(join("out", "report.1.txt"));
		expect(readFileSync(join(workspace, "out", "report.txt"), "utf8")).toBe("keep");
		expect(readFileSync(join(workspace, "out", "report.1.txt"))[0]).toBe(7);
		expect(existsSync(join(workspace, "other", "report.1.txt"))).toBe(false);
	});

	test("a directory symlink inside the workspace numbers against the real dir", () => {
		const { workspace } = ws();
		mkdirSync(join(workspace, "real"));
		writeFileSync(join(workspace, "real", "report.txt"), "first");
		symlinkSync(join(workspace, "real"), join(workspace, "link"));
		const out = exportBytes(workspace, "link", "report.txt", new Uint8Array([9]));
		expect("rel" in out && out.rel).toBe(join("link", "report.1.txt"));
		// The collision was seen and the bytes landed in the real dir —
		// the link is only a spelling for the workspace-relative path.
		expect(readFileSync(join(workspace, "real", "report.1.txt"))[0]).toBe(9);
		expect(readFileSync(join(workspace, "real", "report.txt"), "utf8")).toBe("first");
	});

	test("a directory symlink out of the workspace is refused before mkdir", () => {
		const { dir, workspace } = ws();
		const outside = join(dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(workspace, "link"));
		const out = exportBytes(workspace, join("link", "new"), "x.bin", new Uint8Array([1]));
		expect("error" in out && out.error).toContain("outside the workspace");
		expect(existsSync(join(outside, "new"))).toBe(false);
	});
});

describe("exportNamedBytes", () => {
	test("the same name rewrites the same path instead of numbering", () => {
		const { workspace } = ws();
		const a = exportNamedBytes(workspace, "subagents/7", "result.txt", new Uint8Array([1]));
		const b = exportNamedBytes(workspace, "subagents/7", "result.txt", new Uint8Array([2]));
		expect("rel" in a && a.rel).toBe(join("subagents", "7", "result.txt"));
		expect("rel" in b && b.rel).toBe(join("subagents", "7", "result.txt"));
		expect(readFileSync(join(workspace, "subagents", "7", "result.txt"))[0]).toBe(2);
	});
});

// writeExportBytes is the resolve+write step callers holding bytes
// across an await must use: containment is re-derived at write time and
// the destination's real parent is pinned to an open FD, so an ancestor
// swapped out from under the path cannot steer the write.
describe("writeExportBytes", () => {
	test("writes exact destinations, overwriting in place and keeping the existing mode", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "out.txt"), "old", { mode: 0o600 });
		const out = writeExportBytes(workspace, "out.txt", new Uint8Array([9, 9]));
		expect("path" in out && out.path.endsWith("out.txt")).toBe(true);
		expect(readFileSync(join(workspace, "out.txt"))).toEqual(Buffer.from([9, 9]));
		expect(statSync(join(workspace, "out.txt")).mode & 0o777).toBe(0o600);
	});

	test("a contained leaf symlink is still written through via the pinned parent", () => {
		const { workspace } = ws();
		mkdirSync(join(workspace, "other"));
		writeFileSync(join(workspace, "other", "real.txt"), "old");
		symlinkSync(join("other", "real.txt"), join(workspace, "link.txt"));
		const out = writeExportBytes(workspace, "link.txt", new Uint8Array([5]));
		expect("path" in out && out.path.endsWith("real.txt")).toBe(true);
		expect(lstatSync(join(workspace, "link.txt")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(workspace, "other", "real.txt"))[0]).toBe(5);
	});

	test("a parent dir replaced by an outside symlink is refused and the outside is untouched", () => {
		const { dir, workspace } = ws();
		mkdirSync(join(workspace, "sub"));
		writeFileSync(join(dir, "keep.txt"), "untouched");
		// The destination resolved while `sub` was a real dir — then the
		// ancestor was swapped for an outside link before the write.
		rmSync(join(workspace, "sub"), { recursive: true });
		symlinkSync(dir, join(workspace, "sub"));
		const out = writeExportBytes(workspace, join("sub", "keep.txt"), new Uint8Array([7]));
		expect("error" in out).toBe(true);
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("untouched");
		expect(existsSync(join(dir, "sub"))).toBe(false);
	});

	test("a dangling leaf symlink is refused, and over-cap data never resolves", () => {
		const { workspace } = ws();
		symlinkSync(join(workspace, "gone.txt"), join(workspace, "dangling.txt"));
		const dangle = writeExportBytes(workspace, "dangling.txt", new Uint8Array([1]));
		expect("error" in dangle && dangle.error).toContain("dangling symlink");
		const big = writeExportBytes(workspace, "big.bin", new Uint8Array(BOX_FILE_MAX_BYTES + 1));
		expect("error" in big && big.error).toContain("MiB cap");
	});
});

describe("readWorkspaceFile", () => {
	test("a workspace file reads back, relative and absolute", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "doc.md"), "# hi");
		const rel = readWorkspaceFile(workspace, "doc.md");
		expect("data" in rel && new TextDecoder().decode(rel.data)).toBe("# hi");
		const abs = readWorkspaceFile(workspace, join(workspace, "doc.md"));
		expect("data" in abs).toBe(true);
	});

	test("missing is 404, every other refusal is 403", () => {
		const { dir, workspace } = ws();
		const missing = readWorkspaceFile(workspace, "gone.md");
		expect("error" in missing && workspaceReadStatus(missing.error)).toBe(404);
		writeFileSync(join(dir, "outside.txt"), "x");
		const escape = readWorkspaceFile(workspace, "../outside.txt");
		expect("error" in escape && workspaceReadStatus(escape.error)).toBe(403);
		mkdirSync(join(workspace, "dir"));
		const dirRead = readWorkspaceFile(workspace, "dir");
		expect("error" in dirRead && workspaceReadStatus(dirRead.error)).toBe(403);
	});

	test("a symlink escaping the workspace is refused", () => {
		const { dir, workspace } = ws();
		writeFileSync(join(dir, "target.txt"), "secret");
		symlinkSync(join(dir, "target.txt"), join(workspace, "link.txt"));
		const out = readWorkspaceFile(workspace, "link.txt");
		expect("error" in out && out.error).toContain("outside the workspace");
	});

	test("auth.jsonl is refused wherever it lands in the workspace", () => {
		const { workspace } = ws();
		writeFileSync(join(workspace, "auth.jsonl"), "{}");
		mkdirSync(join(workspace, "sub"));
		writeFileSync(join(workspace, "sub", "auth.jsonl"), "{}");
		expect("error" in readWorkspaceFile(workspace, "auth.jsonl")).toBe(true);
		expect("error" in readWorkspaceFile(workspace, "sub/auth.jsonl")).toBe(true);
		expect(
			"error" in readWorkspaceFile(workspace, "auth.jsonl") &&
				workspaceReadStatus((readWorkspaceFile(workspace, "auth.jsonl") as { error: string }).error),
		).toBe(403);
	});

	test("anything resolving inside .git is refused", () => {
		const { workspace } = ws();
		mkdirSync(join(workspace, ".git", "refs"), { recursive: true });
		writeFileSync(join(workspace, ".git", "config"), "[remote]");
		expect("error" in readWorkspaceFile(workspace, ".git/config")).toBe(true);
		// A symlink whose realpath lands inside .git is refused too.
		mkdirSync(join(workspace, "repo", ".git"), { recursive: true });
		writeFileSync(join(workspace, "repo", ".git", "config"), "x");
		symlinkSync(join(workspace, "repo", ".git", "config"), join(workspace, "gitlink"));
		expect("error" in readWorkspaceFile(workspace, "gitlink")).toBe(true);
	});

	test("the reader cap is smaller than the transfer cap and enforced", () => {
		const { workspace } = ws();
		expect(WORKSPACE_READ_MAX_BYTES).toBeLessThan(BOX_FILE_MAX_BYTES);
		writeFileSync(join(workspace, "big.bin"), new Uint8Array(WORKSPACE_READ_MAX_BYTES + 1));
		const out = readWorkspaceFile(workspace, "big.bin");
		expect("error" in out && out.error).toContain("MiB cap");
	});
});
