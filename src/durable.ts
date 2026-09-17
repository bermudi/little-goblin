// Durable whole-file writes: tmp file + fsync + rename, preserving the
// existing file's mode so a hardened 0600 never downgrades. This ritual is
// for whole-file state only — SQLite uses WAL + transactions instead.

import { constants } from "node:fs";
import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function durableWriteFile(path: string, content: string, modeIfNew = 0o644): void {
	let mode = modeIfNew;
	try {
		mode = statSync(path).mode & 0o777;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		writeSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
	} catch (err) {
		try {
			closeSync(fd);
		} catch {
			// already closed
		}
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup; a stray tmp file is better than a corrupt target
		}
		throw err;
	}
	renameSync(tmp, path);
}
