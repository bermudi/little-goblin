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

import { accessSync, constants, statfsSync, statSync } from "node:fs";

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
