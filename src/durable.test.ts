import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableWriteFile } from "./durable.ts";

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

		// The default is deliberately less restrictive. Replacing an existing
		// auth/config file must retain that file's mode rather than the default.
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
