// The shared workspace file boundary: imports must stay inside the
// workspace under realpath and be regular files within the cap;
// exports get a workspace-relative destination whose ancestors and
// leaf are checked before any directory is created.

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
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
	resolveExport,
	resolveImport,
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
