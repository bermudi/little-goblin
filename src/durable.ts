// Durable whole-file writes: tmp file + fsync + rename, preserving the
// existing file's mode so a hardened 0600 never downgrades. This ritual is
// for whole-file state only — SQLite uses WAL + transactions instead.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	futimesSync,
	lstatSync,
	realpathSync,
	readlinkSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { log } from "./log.ts";

export interface DurableWriteOptions {
	/** Mode for a file that does not exist yet; an existing file keeps its own. */
	modeIfNew?: number;
	/** Timestamps stamped on the new inode before its fsync — an archive
	 *  copy keeps the original's mtime so freshness checks still read it
	 *  as old, and the stamp is durable with the data. */
	times?: { atime: Date | number; mtime: Date | number };
}

export function durableWriteFile(
	path: string,
	content: string,
	options: number | DurableWriteOptions = 0o644,
): void {
	durableWriteBuffer(path, Buffer.from(content, "utf8"), normalize(options));
}

/** The bytes twin — fetched PDFs and other binary state get the same
 *  tmp+fsync+rename ritual as every other whole-file write. */
export function durableWriteBytes(
	path: string,
	data: Uint8Array,
	options: number | DurableWriteOptions = 0o644,
): void {
	durableWriteBuffer(path, Buffer.from(data), normalize(options));
}

const unsupportedSyncDirs = new Set<string>();

/** fsync a directory so a rename/link/unlink inside it is durable, not
 *  just the data of the file it points at. Only an explicitly
 *  unsupported directory fsync may degrade; EIO and other failures leave
 *  the entry's durability unknown and propagate. */

export function fsyncDirectory(dir: string): void {
	const dfd = openSync(dir, constants.O_RDONLY);
	try {
		fsyncSync(dfd);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
		if (!unsupportedSyncDirs.has(dir)) {
			unsupportedSyncDirs.add(dir);
			log.warn("directory fsync unsupported — entry durability not guaranteed", err, {
				directory: dir,
			});
		}
	} finally {
		closeSync(dfd);
	}
}

function normalize(
	options: number | DurableWriteOptions,
): Required<Pick<DurableWriteOptions, "modeIfNew">> & DurableWriteOptions {
	if (typeof options === "number") return { modeIfNew: options };
	return { ...options, modeIfNew: options.modeIfNew ?? 0o644 };
}

function durableWriteBuffer(
	path: string,
	buf: Buffer,
	options: Required<Pick<DurableWriteOptions, "modeIfNew">> & DurableWriteOptions,
): void {
	// Resolve leaf links before choosing the tmp directory: rename must
	// replace the managed target, never the link. Dangling links fail closed.
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (linked) {
		try {
			path = realpathSync(path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			throw new Error(
				`${path} is a dangling symlink (→ ${readlinkSync(path)}) — refusing to replace it`,
				{ cause: err },
			);
		}
	}
	let mode = options.modeIfNew;
	let existed = false;
	try {
		mode = statSync(path).mode & 0o777;
		existed = true;
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
		// open() masks the mode with the umask, so a group-writable state
		// file would silently lose its bit on every rewrite — and the loss
		// sticks, because the next write reads the new mode. A fresh file
		// keeps the conventional umask semantics; preservation is exact.
		if (existed) fchmodSync(fd, mode);
		// writeSync returns bytes written — a short write (ENOSPC,
		// interruption) must not reach fsync/rename as a truncated file.
		let off = 0;
		while (off < buf.length) {
			const n = writeSync(fd, buf, off);
			if (n === 0) throw new Error(`writeSync wrote 0 bytes to ${tmp}`);
			off += n;
		}
		if (options.times !== undefined) futimesSync(fd, options.times.atime, options.times.mtime);
		fsyncSync(fd);
		closeSync(fd);
	} catch (err) {
		try {
			closeSync(fd);
		} catch {
			// already closed
		}
		discardTmp(tmp);
		throw err;
	}
	try {
		renameSync(tmp, path);
	} catch (err) {
		// The target is untouched; the tmp must not pile up next to it
		// (a program re-trying the write every tick would litter the
		// directory unbounded).
		discardTmp(tmp);
		throw err;
	}
	// fsync the directory so the rename itself is durable, not just the
	// file's data.
	try {
		fsyncDirectory(dirname(path));
	} catch (err) {
		throw new Error(
			`file replaced at ${path}, but directory sync failed; durability unknown: ${String(err)}`,
			{ cause: err },
		);
	}
}

function discardTmp(tmp: string): void {
	try {
		unlinkSync(tmp);
	} catch {
		// best-effort cleanup inside an already-failing path; a stray tmp
		// file is better than masking the real error
	}
}
