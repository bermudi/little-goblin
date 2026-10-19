// Preserving the existing file's mode so a hardened 0600 never
// downgrades. This ritual is for whole-file state only — SQLite uses
// WAL + transactions instead.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	futimesSync,
	linkSync,
	lstatSync,
	realpathSync,
	readlinkSync,
	openSync,
	readSync,
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
	/** Stamped before fsync so freshness checks still read it as old —
	 *  the stamp is durable with the data. */
	times?: { atime: Date | number; mtime: Date | number };
	/** link(2), not rename(2) — EEXIST where rename would silently replace. */
	exclusive?: boolean;
}

export function durableWriteFile(
	path: string,
	content: string,
	options: number | DurableWriteOptions = 0o644,
): void {
	durableWriteBuffer(path, Buffer.from(content, "utf8"), normalize(options));
}

/** Binary state gets the same tmp+fsync+rename ritual. */
export function durableWriteBytes(
	path: string,
	data: Uint8Array,
	options: number | DurableWriteOptions = 0o644,
): void {
	durableWriteBuffer(path, Buffer.from(data), normalize(options));
}

/** Create-only: link(2) instead of rename(2) — EEXIST where rename
 *  would silently replace; collision-numbering callers retry on it. */
export function durableWriteBytesExclusive(
	path: string,
	data: Uint8Array,
	modeIfNew = 0o644,
): void {
	durableWriteBuffer(path, Buffer.from(data), { modeIfNew, exclusive: true });
}

// 1 MiB per readSync/writeSync hop — big enough that a multi-MB copy
// stays a handful of syscalls, small enough that the copy's heap
// footprint is the chunk, never the file.
const COPY_CHUNK_BYTES = 1024 * 1024;

/** Same ritual without holding the whole source in memory — a runaway
 *  source costs latency, not the heap. src and dest may be the same
 *  path; the rename still lands a fresh inode. */
export function durableCopyFile(
	src: string,
	dest: string,
	options: Pick<DurableWriteOptions, "times"> = {},
): void {
	dest = resolveLeaf(dest);
	const mode = statSync(src).mode & 0o777;
	const tmp = join(
		dirname(dest),
		`.${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
	);
	const inFd = openSync(src, constants.O_RDONLY);
	const outFd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
	try {
		// open() masks the mode with the umask; a copy must preserve the
		// source's exactly (the archive is the only copy of the result).
		fchmodSync(outFd, mode);
		const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
		let read: number;
		while ((read = readSync(inFd, chunk, 0, COPY_CHUNK_BYTES, null)) > 0) {
			let off = 0;
			while (off < read) {
				const n = writeSync(outFd, chunk, off, read - off);
				if (n === 0) throw new Error(`writeSync wrote 0 bytes to ${tmp}`);
				off += n;
			}
		}
		if (options.times !== undefined) {
			futimesSync(outFd, options.times.atime, options.times.mtime);
		}
		fsyncSync(outFd);
		closeSync(outFd);
		closeSync(inFd);
	} catch (err) {
		try {
			closeSync(outFd);
		} catch {
			// already closed
		}
		try {
			closeSync(inFd);
		} catch {
			// already closed
		}
		discardTmp(tmp);
		throw err;
	}
	try {
		renameSync(tmp, dest);
	} catch (err) {
		discardTmp(tmp);
		throw err;
	}
	try {
		fsyncDirectory(dirname(dest));
	} catch (err) {
		throw new Error(
			`file replaced at ${dest}, but directory sync failed; durability unknown: ${String(err)}`,
			{ cause: err },
		);
	}
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

// Resolve leaf links before choosing the tmp directory: rename must
// replace the managed target, never the link. Dangling links fail closed.
function resolveLeaf(path: string): string {
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (!linked) return path;
	try {
		return realpathSync(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		throw new Error(
			`${path} is a dangling symlink (→ ${readlinkSync(path)}) — refusing to replace it`,
			{ cause: err },
		);
	}
}

function durableWriteBuffer(
	path: string,
	buf: Buffer,
	options: Required<Pick<DurableWriteOptions, "modeIfNew">> & DurableWriteOptions,
): void {
	path = resolveLeaf(path);
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
	if (options.exclusive === true) {
		// link(2) is create-only — a taken name fails EEXIST and the
		// incumbent survives, where rename(2) would clobber it. Same
		// filesystem as tmp (same dir), so it never crosses devices.
		try {
			linkSync(tmp, path);
		} catch (err) {
			discardTmp(tmp);
			throw err;
		}
		unlinkSync(tmp);
	} else {
		try {
			renameSync(tmp, path);
		} catch (err) {
			// The target is untouched; the tmp must not pile up next to it
			// (a program re-trying the write every tick would litter the
			// directory unbounded).
			discardTmp(tmp);
			throw err;
		}
	}
	// fsync the directory so the rename/link itself is durable, not just
	// the file's data.
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
