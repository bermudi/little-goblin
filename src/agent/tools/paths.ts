import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

// An existing differently-normalized twin of a path (macOS stores
// filenames NFD; models and terminals usually emit NFC), or null. Shared
// by the file tools so a read, an edit, and a write all land on the same
// file instead of silently forking it under a second spelling.
export function unicodeTwin(abs: string): string | null {
	for (const norm of [abs.normalize("NFC"), abs.normalize("NFD")]) {
		if (norm !== abs && existsSync(norm)) return norm;
	}
	return null;
}

// Where a durable write (tmp + rename) must land. rename replaces the
// directory entry it names, so a leaf symlink handed straight to it is
// silently destroyed while the file the link manages keeps its old
// contents — the config forks and the dots store stops propagating.
// Per design/delegation.md's symlink ruling the write goes through the
// link to the file it manages. lstat, never stat: a dangling link is
// still a link and must fail loudly with its target named, not count
// as an absent path a write may quietly create (harness-trust.ts keeps
// the same discipline for managed harness settings).
export function writeThroughTarget(abs: string): { target: string } | { error: string } {
	try {
		if (!lstatSync(abs).isSymbolicLink()) return { target: abs };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { target: abs };
		throw err;
	}
	try {
		return { target: realpathSync(abs) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return {
			error:
				`${abs} is a dangling symlink (→ ${readlinkSync(abs)}) — write the target ` +
				`directly or repair the link; refusing to replace it`,
		};
	}
}
