import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/conversation.ts";

// The copy phase is a raw cpSync of the state DB — safe only on a
// stopped unit (a raw copy taken across a WAL checkpoint can tear the
// database, docs/operations.md → Backups). The refusal must precede any
// copy, and only `inactive` counts as stopped: failed/activating units
// come back (Restart=on-failure) and an unreportable state proves
// nothing.
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

// systemctl: null means absent from PATH; otherwise a shell body whose
// output/exit mirrors the real is-active contract.
function fixture(systemctl: string | null, withDb = false): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-replay-test-"));
	dirs.push(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	if (systemctl !== null) {
		writeFileSync(join(bin, "systemctl"), `#!/bin/sh\n${systemctl}\n`, { mode: 0o755 });
		chmodSync(join(bin, "systemctl"), 0o755);
	}
	if (withDb) {
		const home = join(dir, "home");
		mkdirSync(join(home, "state"), { recursive: true });
		openStore(join(home, "state", "goblin.sqlite")).close();
	}
	return dir;
}

async function run(dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = Bun.spawn(
		[process.execPath, "--no-install", join(import.meta.dir, "replay-v7-history.ts")],
		{
			env: {
				PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
				HOME: dir,
				GOBLIN_HOME: join(dir, "home"),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

describe("replay-v7-history refuses a running service before copying", () => {
	test("an active unit refuses with exit 2 and never opens the database", async () => {
		const dir = fixture(`printf 'active\\n'; exit 0`);
		const { code, stderr } = await run(dir);
		expect(code).toBe(2);
		expect(stderr).toContain("goblin.service is active");
		expect(stderr).toContain("stop it first");
	});

	test("a failed unit refuses too — Restart=on-failure brings it back", async () => {
		const dir = fixture(`printf 'failed\\n'; exit 3`);
		const { code, stderr } = await run(dir);
		expect(code).toBe(2);
		expect(stderr).toContain("goblin.service is failed");
	});

	test("an unreportable state refuses — it proves nothing", async () => {
		// systemctl present but answers nothing (no user session, failed
		// manager): an empty state must not pass as "stopped".
		const dir = fixture(`exit 1`);
		const { code, stderr } = await run(dir);
		expect(code).toBe(2);
		expect(stderr).toContain("unreportable");
	});

	test("a missing systemctl refuses — the stopped state cannot be verified", async () => {
		const dir = fixture(null);
		const { code, stderr } = await run(dir);
		// Either spawnProc surfaces the ENOENT or the run completes with no
		// state at all — both are a loud refusal, never a silent proceed.
		expect(code).toBe(2);
		expect(
			stderr.includes("cannot verify goblin.service is stopped") || stderr.includes("unreportable"),
		).toBe(true);
	});

	test("an inactive unit with a real (empty) store copies and replays cleanly", async () => {
		const dir = fixture(`printf 'inactive\\n'; exit 3`, true);
		const { code, stdout } = await run(dir);
		expect(code).toBe(0);
		expect(stdout).toContain("0 conversations, 0 messages, 0 failures");
	});
});
