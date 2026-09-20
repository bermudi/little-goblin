import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileTool, readTextFile } from "./read.ts";

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

	test("byte-cap truncation emits complete lines plus a continuation notice", async () => {
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
			lines?: number;
		};
		expect(out.shown!).toBeLessThan(3000);
		expect(out.lines!).toBe(3000);
		// Every emitted line is complete and numbered — never a partial line.
		const emitted = out.content!.split("\n").filter((l) => /^\d+\t/.test(l));
		expect(emitted.length).toBe(out.shown!);
		// The notice names the exact resumption offset.
		expect(out.content).toMatch(/\[Showing lines 1–\d+ of 3000 \(64KB limit\)\. Use offset=\d+ to continue\.\]/);
		const next = Number(out.content!.match(/Use offset=(\d+)/)![1]);
		// Following the notice resumes exactly where the cap stopped.
		const page2 = (await t.execute!({ path: "f.txt", offset: next }, opts)) as { content?: string };
		expect(page2.content!.startsWith(`${next}\tline-${next - 1}-`)).toBe(true);
	});

	test("an offset past EOF is an error carrying the real line count", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "a\nb\n");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt", offset: 99 }, opts)) as { error?: string };
		expect(out.error).toContain("offset 99 is beyond end of file (3 lines)");
	});

	test("a single line bigger than the cap gets a bash fallback, not a marker", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "min.txt"), `x`.repeat(100 * 1024)); // one 100KB line
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "min.txt" }, opts)) as {
			content?: string;
			shown?: number;
		};
		expect(out.shown).toBe(0);
		expect(out.content).toContain("exceeds the 64KB read_file cap");
		expect(out.content).toContain("sed -n '1p'");
	});

	test("a user limit that stops early says how many lines remain", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"));
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt", offset: 2, limit: 3 }, opts)) as {
			content?: string;
			shown?: number;
		};
		expect(out.content!.startsWith("2\tl1\n3\tl2\n4\tl3\n")).toBe(true);
		expect(out.content).toContain("[6 more lines in file. Use offset=5 to continue.]");
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

describe("read_file special files", () => {
	test("a FIFO is refused, not blocked on forever", () => {
		const dir = tmpdir_();
		const fifo = join(dir, "pipe");
		execFileSync("mkfifo", [fifo]);
		const out = readTextFile(fifo, fifo);
		expect("error" in out).toBe(true);
		expect((out as { error: string }).error).toContain("refusing to read special file");
	});
});

describe("read_file line clamping", () => {
	test("jumbo lines are clamped with a truncation marker", async () => {
		const dir = tmpdir_();
		writeFileSync(
			join(dir, "wide.txt"),
			Array.from({ length: 30 }, (_, i) => `${i}:` + "x".repeat(3000)).join("\n"),
		);
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "wide.txt" }, opts)) as {
			content?: string;
			shown?: number;
		};
		expect(out.shown).toBe(30); // clamped lines fit the window — all shown
		const emitted = out.content!.split("\n").filter((l) => /^\d+\t/.test(l));
		expect(emitted.length).toBe(30);
		expect(out.content).toContain("chars truncated — see the full line with bash");
		for (const line of emitted) {
			expect(line.length).toBeLessThan(2200); // clamp + marker + number prefix
		}
		// Unclamped, 30 × ~3006 bytes would dwarf the clamped total.
		expect(out.content!.length).toBeLessThan(30 * 2500);
	});
});

describe("read_file negative offsets", () => {
	test("offset=-5 shows exactly the last 5 lines with real line numbers", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"));
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt", offset: -5 }, opts)) as { content?: string };
		expect(out.content).toBe("26\tl25\n27\tl26\n28\tl27\n29\tl28\n30\tl29\n");
	});

	test("a negative offset beyond the file clamps to the whole file, no error", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.txt"), "a\nb\nc\n");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.txt", offset: -500 }, opts)) as {
			content?: string;
			error?: string;
			lines?: number;
			shown?: number;
		};
		expect(out.error).toBeUndefined();
		expect(out.content!.startsWith("1\ta\n")).toBe(true);
		expect(out.lines).toBe(4);
		expect(out.shown).toBe(4);
	});
});

describe("read_file empty files", () => {
	test("a 0-byte file gets the empty note instead of a blank numbered line", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "empty.txt"), "");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "empty.txt" }, opts)) as {
			content?: string;
			lines?: number;
			shown?: number;
		};
		expect(out.content).toBe("[file is empty — 0 bytes]");
		expect(out.lines).toBe(0);
		expect(out.shown).toBe(0);
	});

	test("a whitespace-only file is not empty and keeps numbering", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "ws.txt"), " \n\t\n");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "ws.txt" }, opts)) as { content?: string; lines?: number };
		expect(out.lines).toBe(3);
		expect(out.content!.startsWith("1\t \n")).toBe(true);
	});
});

describe("read_file did-you-mean", () => {
	test("a near-miss gets a suggestion", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "AGENTS.md"), "x");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "AGENT.md" }, opts)) as { error?: string };
		expect(out.error).toContain("file not found: AGENT.md");
		expect(out.error).toContain("did you mean: AGENTS.md");
	});

	test("a totally unrelated miss gets no suggestion", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "AGENTS.md"), "x");
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "zzzzzzzzz" }, opts)) as { error?: string };
		expect(out.error).toBe("file not found: zzzzzzzzz");
	});
});

describe("read_file images", () => {
	test("a PNG gets a structured image note with dimensions", async () => {
		const dir = tmpdir_();
		// Hand-crafted PNG header: signature + IHDR chunk with 8x4 dims.
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from([0x00, 0x00, 0x00, 0x0d]),
			Buffer.from("IHDR", "latin1"),
			Buffer.from([0, 0, 0, 8, 0, 0, 0, 4, 8, 6, 0, 0, 0]),
		]);
		writeFileSync(join(dir, "img.png"), png);
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "img.png" }, opts)) as {
			content?: string;
			lines?: number;
			shown?: number;
		};
		expect(out.lines).toBe(0);
		expect(out.content).toContain("[image file image/png 8x4");
		expect(out.content).toContain(`${png.length} bytes`);
		expect(out.content).toContain("cannot show images");
	});

	test("a non-image binary still errors plainly", async () => {
		const dir = tmpdir_();
		writeFileSync(join(dir, "f.bin"), Buffer.from([0xff, 0x00, 0xfe, 0x62]));
		const t = readFileTool(dir);
		const out = (await t.execute!({ path: "f.bin" }, opts)) as { error?: string };
		expect(out.error).toContain("binary file");
	});
});
