// The file sink's failure policy is a real boundary: logging must never
// throw, permanent target breakage silences the sink for the run, and a
// re-attached target starts fresh. The transient path (ENOSPC-style)
// needs a fake writer — the real filesystem can't be asked to fail that
// way portably — via setLogWriter, same pattern as codex/auth.ts's fetchImpl.

import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, setLogFile, setLogWriter } from "./log.ts";

let dirs: string[] = [];
function tmpHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-log-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	setLogFile(null);
	setLogWriter(null);
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function lines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function errno(code: string, msg: string): NodeJS.ErrnoException {
	const err = new Error(msg) as NodeJS.ErrnoException;
	err.code = code;
	return err;
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

	test("a transient error degrades the sink — later writes recover, the file keeps filling", () => {
		const dir = tmpHome();
		const target = join(dir, "goblin.log");
		setLogFile(target);
		let fail = true;
		setLogWriter((path, line) => {
			if (fail) {
				fail = false;
				throw errno("ENOSPC", "ENOSPC: no space left on device");
			}
			appendFileSync(path, line);
		});
		// First line: lost to the full disk (stdout only), sink stays alive.
		expect(() => log.info("lost to the full disk")).not.toThrow();
		// Second line: disk freed — it lands, and the sink recovers.
		log.info("recovered line");
		expect(lines(target).map((l) => l.msg)).toEqual(["recovered line"]);
		// And the sink is not dead: a third line still lands.
		log.info("still alive");
		expect(lines(target).map((l) => l.msg)).toEqual(["recovered line", "still alive"]);
	});

	test("an ENOENT recreate whose retry hits a transient error degrades, not dies", () => {
		const dir = tmpHome();
		const target = join(dir, "state", "goblin.log");
		setLogFile(target);
		let calls = 0;
		setLogWriter((path, line) => {
			calls++;
			// First append: the state dir is missing. After mkdirSync, the
			// retry append hits the full disk — transient, must not kill.
			if (calls === 1) throw errno("ENOENT", "ENOENT: no such file or directory");
			if (calls === 2) throw errno("ENOSPC", "ENOSPC: no space left on device");
			appendFileSync(path, line);
		});
		log.info("first");
		// The sink survived the compound failure: later writes land.
		log.info("second");
		log.info("third");
		expect(calls).toBe(4);
		expect(lines(target).map((l) => l.msg)).toEqual(["second", "third"]);
	});
});
