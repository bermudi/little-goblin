// Test scratch lives in RAM. The suite opens thousands of throwaway
// SQLite stores, and every commit fsyncs: on a disk-backed /tmp
// (bermudi-g7 moved /tmp to a btrfs subvolume, 2026-11-02) a full run
// went from under 10 minutes to 33, with timing-sensitive tests timing
// out under IO stalls. On tmpfs the same fsyncs are nearly free, and
// the code under test is unchanged — durability paths still run.
//
// First in bunfig.toml's [test] preload, before any module can read
// os.tmpdir(): it reads TMPDIR on every call, so this one assignment
// covers testkit fixtures, the 90-odd files that mkdtemp under
// tmpdir() directly, SQLite's own temp files, and spawned children.
//
// An explicit TMPDIR always wins. RAM is used only when /dev/shm is a
// writable directory with headroom; otherwise the run stays where it
// was — slower, never broken.

import { accessSync, constants, mkdtempSync, rmSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHM = "/dev/shm";
/** Below this much free tmpfs space, stay on disk rather than squeeze RAM. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;

function shmUsable(): boolean {
	try {
		if (!statSync(SHM).isDirectory()) return false;
		accessSync(SHM, constants.W_OK);
		const fs = statfsSync(SHM);
		return fs.bavail * fs.bsize >= MIN_FREE_BYTES;
	} catch (err) {
		// No /dev/shm (macOS) or no access: the default tmpdir stands.
		// Anything else is unexpected and fails the run loudly.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return false;
		throw err;
	}
}

if (process.env.TMPDIR === undefined && shmUsable()) {
	process.env.TMPDIR = SHM;
}

// A test that forgets useHome() must not write into the operator's real
// ~/goblin: scheduler/responsibility tests did, leaving ~960 empty
// projects/rig-N dirs (2026-10-19 → 11-06). Default GOBLIN_HOME to a
// throwaway dir for the whole run; useHome() still overrides per test and
// restores to this value, never to the real home. An explicit GOBLIN_HOME wins.
// Named like a testkit fixture root so its import-time sweep reclaims it once
// this pid is dead (the exit hook alone does not fire under bun test).
if (process.env.GOBLIN_HOME === undefined) {
	const sandbox = mkdtempSync(join(tmpdir(), `goblin-test-fixtures-${process.pid}-`));
	process.env.GOBLIN_HOME = sandbox;
	process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));
}
