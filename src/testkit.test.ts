// Fixture hygiene: the tracked-dir cleanup must hold for every file in
// a multi-file bun test run (bun scopes module-level afterEach to the
// first-importing file — the 2026-10-22 /tmp ENOSPC incident), and the
// stale sweep must heal crash leftovers on the next run.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleFixtureDirs, tmpDir, useHome } from "./testkit.ts";

describe("stale fixture sweep", () => {
	test("removes only goblin-* dirs past the age gate", () => {
		const stale = mkdtempSync(join(tmpdir(), "goblin-sweepstale-"));
		const fresh = mkdtempSync(join(tmpdir(), "goblin-sweepfresh-"));
		const foreign = mkdtempSync(join(tmpdir(), "nogoblin-sweepstale-"));
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(stale, old, old);
		utimesSync(foreign, old, old);
		try {
			sweepStaleFixtureDirs();
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
			rmSync(foreign, { recursive: true, force: true });
		}
	});
});

describe("multi-file fixture cleanup", () => {
	// Two generated victim files run under one spawned `bun test`: file
	// b's fixtures must not outlive the process just because bun scoped
	// testkit's afterEach to file a. Before the exit backstop, b's (and
	// every later file's) dirs leaked on every multi-file run.
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
		// Relative diff, not absolute emptiness: pre-fix residue younger
		// than the sweep's age gate legitimately persists here.
		const residue = (name: string) => name.startsWith("goblin-multipass-") || name.startsWith("goblin-multihome-");
		const before = new Set(readdirSync(tmpdir()).filter(residue));
		try {
			const proc = Bun.spawn([process.execPath, "test", a, b], {
				cwd: join(import.meta.dir, ".."),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) console.error(out + err);
			expect(code).toBe(0);
			const leaked = readdirSync(tmpdir()).filter((n) => residue(n) && !before.has(n));
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
