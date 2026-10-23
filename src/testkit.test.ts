// Fixture hygiene: the tracked-dir cleanup must hold for every file in
// a multi-file bun test run (bun scopes module-level afterEach to the
// first-importing file — the 2026-10-22 /tmp ENOSPC incident), and the
// stale sweep must heal crash leftovers on the next run while never
// taking a live process's root or a foreign directory.

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleFixtureDirs, tmpDir, useHome } from "./testkit.ts";

async function deadPid(): Promise<number> {
	const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited;
	return proc.pid;
}

function stage(): { root: string; cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "goblin-sweepstage-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const fixtureName = (pid: number) => `goblin-test-fixtures-${pid}-a1b2c3`;
const aged = (dir: string) => {
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	utimesSync(dir, old, old);
};

describe("stale fixture sweep", () => {
	test("removes a stale root whose owner PID is dead", async () => {
		const { root, cleanup } = stage();
		try {
			const dir = join(root, fixtureName(await deadPid()));
			mkdirSync(dir);
			writeFileSync(join(dir, "left.txt"), "x");
			aged(dir);
			sweepStaleFixtureDirs(root);
			expect(existsSync(dir)).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("preserves a stale root whose owner PID is alive", async () => {
		const { root, cleanup } = stage();
		try {
			const dir = join(root, fixtureName(process.pid));
			mkdirSync(dir);
			aged(dir);
			sweepStaleFixtureDirs(root);
			expect(existsSync(dir)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("preserves a fresh root even when its owner PID is dead", async () => {
		const { root, cleanup } = stage();
		try {
			const dir = join(root, fixtureName(await deadPid()));
			mkdirSync(dir);
			sweepStaleFixtureDirs(root);
			expect(existsSync(dir)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("preserves old goblin-* dirs and malformed fixture names", async () => {
		const { root, cleanup } = stage();
		try {
			const legacy = join(root, "goblin-tr-abcdef");
			mkdirSync(legacy);
			writeFileSync(join(legacy, "input.txt"), "x");
			const foreign = join(root, "nogoblin-sweepstale-");
			mkdirSync(foreign);
			const malformed = [
				"goblin-test-fixtures-0-a1b2c3",
				"goblin-test-fixtures-x-a1b2c3",
				"goblin-test-fixtures-12-a1b2c",
				"goblin-test-fixtures-12",
				"goblin-test-fixtures-012-a1b2c3",
			];
			for (const name of malformed) {
				const dir = join(root, name);
				mkdirSync(dir);
				aged(dir);
			}
			aged(legacy);
			aged(foreign);
			sweepStaleFixtureDirs(root);
			expect(existsSync(legacy)).toBe(true);
			expect(existsSync(join(legacy, "input.txt"))).toBe(true);
			expect(existsSync(foreign)).toBe(true);
			for (const name of malformed) expect(existsSync(join(root, name))).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("preserves a symlinked root — never follows it to the target", async () => {
		const { root, cleanup } = stage();
		try {
			const target = join(root, "target-dir");
			mkdirSync(target);
			writeFileSync(join(target, "keep.txt"), "x");
			const link = join(root, fixtureName(await deadPid()));
			symlinkSync(target, link);
			aged(target);
			sweepStaleFixtureDirs(root);
			expect(existsSync(link)).toBe(true);
			expect(existsSync(join(target, "keep.txt"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("multi-file fixture cleanup", () => {
	// Two generated victim files run under one spawned `bun test`: file
	// b's fixtures must not outlive the process just because bun scoped
	// testkit's afterEach to file a. Bun never fires process-exit
	// handlers under `bun test`, so the emptied-root release rides that
	// shared afterEach — before it, b's (and every later file's) dirs
	// leaked on every multi-file run.
	test("a two-file run leaves no fixture dirs behind", async () => {
		const stage = tmpDir("goblin-multitest-");
		const kit = join(import.meta.dir, "testkit.ts");
		const victim = (prefix: string) =>
			[
				'import { test } from "bun:test";',
				`import { tmpDir, useHome } from ${JSON.stringify(kit)};`,
				'test("victim", () => {',
				`	useHome("goblin-multihome-");`,
				`	tmpDir("${prefix}-");`,
				"});",
				"",
			].join("\n");
		const a = join(stage, "a.test.ts");
		const b = join(stage, "b.test.ts");
		writeFileSync(a, victim("goblin-multipass-a"));
		writeFileSync(b, victim("goblin-multipass-b"));
		// Whole-root check, not a relative diff: the child's own fixture
		// root must be gone entirely — a still-present root means children
		// leaked (the afterEach release drops it only once empty).
		try {
			const proc = Bun.spawn([process.execPath, "test", a, b], {
				cwd: join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			});
			const childPid = proc.pid;
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) console.error(out + err);
			expect(code).toBe(0);
			const leaked = readdirSync(tmpdir()).filter((n) =>
				n.startsWith(`goblin-test-fixtures-${childPid}-`),
			);
			expect(leaked).toEqual([]);
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});

	test("a fresh dir created mid-run survives the import-time sweep", () => {
		// The sweep is import-time with a 60min gate: dirs created
		// mid-run are young, so a later import (a module-cache no-op)
		// must never take them.
		const dir = useHome("goblin-midrun-");
		expect(existsSync(dir)).toBe(true);
	});
});
