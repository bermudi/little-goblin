// The file sink's failure policy is a real boundary: logging must never
// throw, permanent target breakage silences the sink for the run, and a
// re-attached target starts fresh. (ENOSPC-style transient degradation
// can't be triggered portably in a test — errno coverage is by code
// review; the state machine around it is what's guarded here.)

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, setLogFile } from "./log.ts";

let dirs: string[] = [];
function tmpHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-log-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	setLogFile(null);
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function lines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("file sink", () => {
	test("attached sink receives every emitted line", () => {
		const dir = tmpHome();
		const target = join(dir, "goblin.log");
		setLogFile(target);
		log.info("hello", { a: 1 });
		const [first] = lines(target);
		expect(first).toMatchObject({ level: "info", msg: "hello", a: 1 });
	});

	test("missing parent directory is created on first write", () => {
		const dir = tmpHome();
		const target = join(dir, "state", "nested", "goblin.log");
		setLogFile(target);
		log.info("creates parents");
		expect(existsSync(target)).toBe(true);
	});

	test("a permanently broken target kills the sink for the run — and never throws", () => {
		const dir = tmpHome();
		// A regular file where a directory would need to be: every open
		// of the target fails ENOTDIR — permanent by policy.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const target = join(blocker, "goblin.log");
		setLogFile(target);
		expect(() => log.info("first")).not.toThrow();
		expect(() => log.warn("second")).not.toThrow();
		expect(existsSync(target)).toBe(false);
	});

	test("attaching a new target revives a dead sink", () => {
		const dir = tmpHome();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		setLogFile(join(blocker, "goblin.log"));
		log.info("dies here");
		const fresh = join(dir, "goblin.log");
		setLogFile(fresh);
		log.info("lives again");
		const msgs = lines(fresh).map((l) => l.msg);
		expect(msgs).toContain("lives again");
	});
});
