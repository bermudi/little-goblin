import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

// macOS stores filenames NFD; models and terminals emit NFC. Match the twin so
// read/edit/write land on one file.
export function unicodeTwin(abs: string): string | null {
	for (const norm of [abs.normalize("NFC"), abs.normalize("NFD")]) {
		if (norm !== abs && existsSync(norm)) return norm;
	}
	return null;
}

// rename() replaces the directory entry, silently destroying a leaf symlink
// (the managed file keeps old contents). Write through the link; lstat so a
// dangling link fails loud instead of being "created".
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
