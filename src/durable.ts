// Durable whole-file writes: tmp file + fsync + rename, preserving the
// existing file's mode so a hardened 0600 never downgrades. This ritual is
// for whole-file state only — SQLite uses WAL + transactions instead.

import { randomBytes } from "node:crypto";
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
	durableWriteBuffer(path, Buffer.from(content, "utf8"), modeIfNew);
}

/** The bytes twin — fetched PDFs and other binary state get the same
 *  tmp+fsync+rename ritual as every other whole-file write. */
export function durableWriteBytes(path: string, data: Uint8Array, modeIfNew = 0o644): void {
	durableWriteBuffer(path, Buffer.from(data), modeIfNew);
}

function durableWriteBuffer(path: string, buf: Buffer, modeIfNew: number): void {
	let mode = modeIfNew;
	try {
		mode = statSync(path).mode & 0o777;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	// Random suffix: parallel writes to the same directory in the same
	// millisecond (e.g. two tool calls in one step) must not collide.
	const tmp = join(
		dirname(path),
		`.${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
	);
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		// writeSync returns bytes written — a short write (ENOSPC,
		// interruption) must not reach fsync/rename as a truncated file.
		let off = 0;
		while (off < buf.length) {
			const n = writeSync(fd, buf, off);
			if (n === 0) throw new Error(`writeSync wrote 0 bytes to ${tmp}`);
			off += n;
		}
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
	// fsync the directory so the rename itself is durable, not just the
	// file's data. Best-effort: not every filesystem permits dir fsync,
	// and the payload is already safe.
	try {
		const dfd = openSync(dirname(path), constants.O_RDONLY);
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		// directory fsync unsupported — the data is already durable
	}
}
