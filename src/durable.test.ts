import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	lstatSync,
	symlinkSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableCopyFile, durableWriteBytes, durableWriteFile } from "./durable.ts";

const dirs: string[] = [];

function useDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-durable-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("durableWriteFile", () => {
	test("creates a whole file with the requested mode", () => {
		const dir = useDir();
		const path = join(dir, "new");

		durableWriteFile(path, "complete payload\n", 0o600);

		expect(readFileSync(path, "utf8")).toBe("complete payload\n");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["new"]);
	});

	test("atomically replaces the contents while preserving a hardened mode", () => {
		const dir = useDir();
		const path = join(dir, "existing");
		writeFileSync(path, "old");
		chmodSync(path, 0o600);

		// Replacing an existing auth/config file must retain that file's
		// mode rather than the default.
		durableWriteFile(path, "new");

		expect(readFileSync(path, "utf8")).toBe("new");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["existing"]);
	});

	test("propagates setup failures without changing an existing target", () => {
		const dir = useDir();
		const path = join(dir, "target");
		writeFileSync(path, "still intact");

		// A missing parent fails before a temporary file can be opened.
		expect(() => durableWriteFile(join(dir, "missing", "target"), "new")).toThrow();

		expect(readFileSync(path, "utf8")).toBe("still intact");
		expect(readdirSync(dir).sort()).toEqual(["target"]);
	});
});

describe("durableWriteFile — mode and tmp hygiene", () => {
	test("preserves a group-writable mode the umask would otherwise strip", () => {
		const dir = useDir();
		const path = join(dir, "shared");
		writeFileSync(path, "old");
		chmodSync(path, 0o664);
		const prior = process.umask(0o022);
		try {
			durableWriteFile(path, "new");
		} finally {
			process.umask(prior);
		}
		expect(readFileSync(path, "utf8")).toBe("new");
		// open(O_CREAT, 0o664) under umask 022 yields 0o644 — "preserving the
		// existing mode" has to mean the exact bits, not the masked ones.
		expect(statSync(path).mode & 0o777).toBe(0o664);
	});

	test("a failed rename leaves no tmp file behind", () => {
		const dir = useDir();
		// A directory squatting on the target name makes rename fail (EISDIR)
		// after the tmp was fully written.
		const path = join(dir, "target");
		mkdirSync(path);
		expect(() => durableWriteFile(path, "payload")).toThrow();
		expect(readdirSync(dir)).toEqual(["target"]);
	});

	test("times stamp the new inode and survive the write", () => {
		const dir = useDir();
		const path = join(dir, "archive");
		writeFileSync(path, "old");
		const mtime = new Date("2020-01-02T03:04:05Z");
		durableWriteBytes(path, Buffer.from("copy"), { times: { atime: mtime, mtime } });
		expect(readFileSync(path, "utf8")).toBe("copy");
		expect(statSync(path).mtimeMs).toBe(mtime.getTime());
	});
});

describe("durable writes through managed symlinks", () => {
	for (const binary of [false, true]) {
		test(`${binary ? "bytes" : "text"} reach a chained relative target without replacing links`, () => {
			const dir = useDir();
			const managed = join(dir, "managed");
			mkdirSync(managed);
			const target = join(managed, "state");
			writeFileSync(target, "old", { mode: 0o600 });
			symlinkSync("managed/state", join(dir, "middle"));
			const link = join(dir, "link");
			symlinkSync("middle", link);
			if (binary) durableWriteBytes(link, Buffer.from("new"));
			else durableWriteFile(link, "new");
			expect(readFileSync(target, "utf8")).toBe("new");
			expect(statSync(target).mode & 0o777).toBe(0o600);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(lstatSync(join(dir, "middle")).isSymbolicLink()).toBe(true);
			expect(readdirSync(managed)).toEqual(["state"]);
		});
	}
	test("dangling and cyclic links fail without replacing them or leaving tmp files", () => {
		const dir = useDir();
		symlinkSync("absent", join(dir, "dangling"));
		symlinkSync("cycle", join(dir, "cycle"));
		expect(() => durableWriteFile(join(dir, "dangling"), "new")).toThrow("dangling symlink");
		expect(() => durableWriteBytes(join(dir, "cycle"), Buffer.from("new"))).toThrow();
		expect(lstatSync(join(dir, "dangling")).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "cycle")).isSymbolicLink()).toBe(true);
		expect(readdirSync(dir).sort()).toEqual(["cycle", "dangling"]);
	});
});

describe("durableCopyFile", () => {
	test("copies byte-exact across the chunk boundary and lands a fresh inode", () => {
		const dir = useDir();
		const path = join(dir, "report");
		// Two full chunks plus an odd tail, patterned so a short
		// read/write off-by-one shifts the bytes and fails the compare.
		const payload = Buffer.from("0123456789".repeat(220_000));
		writeFileSync(path, payload);
		const before = statSync(path).ino;

		durableCopyFile(path, path);

		expect(readFileSync(path).equals(payload)).toBe(true);
		// The self-copy exists to break inode sharing with writers still
		// holding the old file open — same path, new inode, every time.
		expect(statSync(path).ino).not.toBe(before);
		expect(readdirSync(dir)).toEqual(["report"]);
	});

	test("preserves the source mode exactly, even bits the umask would strip", () => {
		const dir = useDir();
		const src = join(dir, "src");
		const dest = join(dir, "dest");
		writeFileSync(src, "payload");
		chmodSync(src, 0o664);
		const prior = process.umask(0o022);
		try {
			durableCopyFile(src, dest);
		} finally {
			process.umask(prior);
		}
		expect(readFileSync(dest, "utf8")).toBe("payload");
		expect(statSync(dest).mode & 0o777).toBe(0o664);
	});

	test("times stamp the copy so freshness checks read it as the original", () => {
		const dir = useDir();
		const src = join(dir, "src");
		const dest = join(dir, "dest");
		writeFileSync(src, "old result");
		const mtime = new Date("2020-01-02T03:04:05Z");
		durableCopyFile(src, dest, { times: { atime: mtime, mtime } });
		expect(statSync(dest).mtimeMs).toBe(mtime.getTime());
	});

	test("a missing source propagates ENOENT without leaving a tmp file", () => {
		const dir = useDir();
		expect(() => durableCopyFile(join(dir, "absent"), join(dir, "dest"))).toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("reaches a chained relative link target without replacing links", () => {
		const dir = useDir();
		const managed = join(dir, "managed");
		mkdirSync(managed);
		const target = join(managed, "state");
		writeFileSync(target, "old", { mode: 0o600 });
		symlinkSync("managed/state", join(dir, "middle"));
		const link = join(dir, "link");
		symlinkSync("middle", link);
		durableCopyFile(target, link);
		expect(readFileSync(target, "utf8")).toBe("old");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(dir, "middle")).isSymbolicLink()).toBe(true);
		expect(readdirSync(managed)).toEqual(["state"]);
	});
});
