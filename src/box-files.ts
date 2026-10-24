// The workspace file boundary, shared by the native sandbox/desktop
// tools and subagent run inboxes: imports' realpath must stay inside
// the workspace; exports land on a workspace-relative path whose
// ancestors and leaf can't aim the write outside.

import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { durableWriteBytes, durableWriteBytesExclusive } from "./durable.ts";
import { writeThroughTarget } from "./agent/tools/paths.ts";

export const BOX_FILE_MAX_BYTES = 100 * 1024 * 1024;

export type BoxPathResult = { path: string } | { error: string };

/** Why the boundary said no: "not-found" means the named thing isn't
 *  there at all; "refused" means it exists and the boundary won't serve
 *  it. Carried on the error so callers classify on structure, never by
 *  re-parsing the prose. */
export type BoxErrorCode = "not-found" | "refused";
export type BoxImportResult =
	| { path: string; bytes: number }
	| { error: string; code: BoxErrorCode };

function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(root + sep);
}

/** Collision candidate at index i: `name.ext`, `name.1.ext`, … — pure;
 *  the exclusive write below is what proves the name is free. */
function numberedCandidate(base: string, i: number): string {
	if (i === 0) return base;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	return `${stem}.${i}${ext}`;
}

/** Import side: a workspace path that exists, stays inside the
 *  workspace under realpath, and names a regular file within the cap. */
export function resolveImport(
	workspace: string,
	from: string,
	maxBytes: number = BOX_FILE_MAX_BYTES,
): BoxImportResult {
	const wsLex = resolve(workspace);
	const resolved = isAbsolute(from) ? resolve(from) : resolve(wsLex, from);
	// A lexical `..` escape is refused before the filesystem is
	// touched — realpath only runs once the path exists.
	if (!inside(wsLex, resolved)) {
		return {
			error: `refused: ${from} resolves to ${resolved}, outside the workspace — copy it into the workspace first if this is deliberate`,
			code: "refused",
		};
	}
	let real: string;
	try {
		real = realpathSync(resolved);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: `source not found: ${from}`, code: "not-found" };
		}
		throw err;
	}
	const wsReal = realpathSync(wsLex);
	if (!inside(wsReal, real)) {
		return {
			error: `refused: ${from} resolves to ${real}, outside the workspace — copy it into the workspace first if this is deliberate`,
			code: "refused",
		};
	}
	const st = statSync(real);
	if (!st.isFile()) {
		return { error: `refused: ${from} is not a regular file`, code: "refused" };
	}
	if (st.size > maxBytes) {
		return {
			error: `refused: ${from} exceeds the ${maxBytes / (1024 * 1024)} MiB cap`,
			code: "refused",
		};
	}
	return { path: real, bytes: st.size };
}

/** Validate the opened inode, not a pathname checked before an await. */
export function readImport(
	workspace: string,
	from: string,
	maxBytes: number = BOX_FILE_MAX_BYTES,
): { path: string; data: Uint8Array } | { error: string; code: BoxErrorCode } {
	const resolved = resolveImport(workspace, from, maxBytes);
	if ("error" in resolved) return resolved;
	const fd = openSync(resolved.path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const path = realpathSync(`/proc/self/fd/${fd}`);
		if (!inside(realpathSync(workspace), path)) {
			return { error: `refused: ${from} resolves outside the workspace`, code: "refused" };
		}
		const st = fstatSync(fd);
		if (!st.isFile()) {
			return { error: `refused: ${from} is not a regular file`, code: "refused" };
		}
		if (st.size > maxBytes) {
			return {
				error: `refused: ${from} exceeds the ${maxBytes / (1024 * 1024)} MiB cap`,
				code: "refused",
			};
		}
		// One extra byte detects growth without allowing an unbounded read.
		const data = Buffer.alloc(st.size + 1);
		let bytes = 0;
		while (bytes < data.length) {
			const n = readSync(fd, data, bytes, data.length - bytes, null);
			if (n === 0) break;
			bytes += n;
		}
		if (bytes > st.size) {
			return { error: `refused: ${from} grew during import; retry it`, code: "refused" };
		}
		return { path, data: data.subarray(0, bytes) };
	} finally {
		closeSync(fd);
	}
}

/** The real directory an export lands in. The nearest existing
 *  ancestor is realpath'd BEFORE any mkdir — a symlinked ancestor
 *  plus a missing tail would otherwise seed empty dirs outside the
 *  workspace — and the final dir is realpath'd back inside. */
function resolveExportDir(workspace: string, relDir: string): BoxPathResult {
	if (isAbsolute(relDir)) {
		return { error: `destination must be workspace-relative, got absolute: ${relDir}` };
	}
	const wsReal = realpathSync(workspace);
	const dest = resolve(wsReal, relDir);
	if (!inside(wsReal, dest)) {
		return { error: `refused: ${relDir} resolves to ${dest}, outside the workspace` };
	}
	let anchor = dest;
	while (anchor !== wsReal && anchor.startsWith(wsReal + sep)) {
		try {
			lstatSync(anchor);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			anchor = dirname(anchor);
		}
	}
	const realAnchor = realpathSync(anchor);
	if (!inside(wsReal, realAnchor)) {
		return {
			error: `refused: ${anchor} resolves to ${realAnchor}, outside the workspace`,
		};
	}
	mkdirSync(dest, { recursive: true });
	const realDest = realpathSync(dest);
	if (!inside(wsReal, realDest)) {
		return {
			error: `refused: ${dest} resolves to ${realDest}, outside the workspace`,
		};
	}
	return { path: realDest };
}

/** Export side: a workspace-relative destination whose directory
 *  resolves inside the workspace; the leaf goes through
 *  writeThroughTarget so a leaf symlink is written through, never
 *  silently replaced. */
export function resolveExport(workspace: string, rel: string): BoxPathResult {
	if (isAbsolute(rel)) {
		return { error: `destination must be workspace-relative, got absolute: ${rel}` };
	}
	const dir = resolveExportDir(workspace, dirname(rel));
	if ("error" in dir) return dir;
	const wsReal = realpathSync(workspace);
	const through = writeThroughTarget(join(dir.path, basename(rel)));
	if ("error" in through) return through;
	if (!inside(wsReal, through.target) || through.target === wsReal) {
		return {
			error: `refused: ${rel} is a symlink to ${through.target}, outside the workspace`,
		};
	}
	return { path: through.target };
}

/** Resolve-and-write in one step, for callers holding bytes across an
 *  await (the sandbox's container read). Containment is derived at
 *  write time and the destination's real parent dir is pinned to an
 *  open FD, so an ancestor swapped for an outside symlink while the
 *  read was in flight can't aim the write anywhere — revalidating a
 *  stale path would only narrow that window, not close it. The durable
 *  write's tmp/rename/fsync run through `/proc/self/fd/<fd>` and land
 *  in the pinned directory even if its path is moved mid-write; leaf
 *  write-through and mode preservation are unchanged. */
export function writeExportBytes(
	workspace: string,
	rel: string,
	data: Uint8Array,
	opts?: { exclusive?: boolean },
): { path: string } | { error: string; exists?: true } {
	if (data.byteLength > BOX_FILE_MAX_BYTES) {
		return {
			error: `refused: export exceeds the ${BOX_FILE_MAX_BYTES / (1024 * 1024)} MiB cap`,
		};
	}
	const dest = resolveExport(workspace, rel);
	if ("error" in dest) return dest;
	const wsReal = realpathSync(workspace);
	const parent = dirname(dest.path);
	// O_NOFOLLOW: the parent's final component must be the real dir the
	// resolver saw — a swap to a symlink is a containment verdict, and
	// the fd realpath below proves where the FD actually landed.
	let fd: number;
	try {
		fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
			return {
				error: `refused: ${rel}'s directory is no longer a contained directory (${code})`,
			};
		}
		throw err;
	}
	try {
		const realParent = realpathSync(`/proc/self/fd/${fd}`);
		if (!inside(wsReal, realParent)) {
			return {
				error: `refused: ${rel} resolves into ${realParent}, outside the workspace`,
			};
		}
		try {
			if (opts?.exclusive === true) {
				durableWriteBytesExclusive(join(`/proc/self/fd/${fd}`, basename(dest.path)), data);
			} else {
				durableWriteBytes(join(`/proc/self/fd/${fd}`, basename(dest.path)), data);
			}
		} catch (err) {
			// A create-only write losing the race is a verdict, not a
			// failure — the caller retries on the next numbered name.
			if (opts?.exclusive === true && (err as NodeJS.ErrnoException).code === "EEXIST") {
				return { error: `destination exists: ${rel}`, exists: true };
			}
			throw err;
		}
		return { path: dest.path };
	} finally {
		closeSync(fd);
	}
}

/** Write exported bytes under `<relDir>/<numbered basename>` inside the
 *  workspace; returns the workspace-relative path actually used. */
export function exportBytes(
	workspace: string,
	relDir: string,
	sourceBaseName: string,
	data: Uint8Array,
): { rel: string } | { error: string } {
	if (data.byteLength > BOX_FILE_MAX_BYTES) {
		return {
			error: `refused: export exceeds the ${BOX_FILE_MAX_BYTES / (1024 * 1024)} MiB cap`,
		};
	}
	const base = basename(sourceBaseName);
	// The probe is the exclusive write itself: two parallel exports of
	// the same basename can't pick one "free" name and rename-clobber
	// each other — EEXIST hands the loser the next numbered candidate.
	for (let i = 0; ; i++) {
		const candidate = numberedCandidate(base, i);
		const written = writeExportBytes(workspace, join(relDir, candidate), data, {
			exclusive: true,
		});
		if ("error" in written && written.exists === true) continue;
		if ("error" in written) return written;
		return { rel: join(relDir, candidate) };
	}
}

/** Write exported bytes under `<relDir>/<name>` exactly — the
 *  deterministic variant for run exports: idempotent across a
 *  restart, so a re-export lands on the same path instead of
 *  numbering a duplicate. */
export function exportNamedBytes(
	workspace: string,
	relDir: string,
	name: string,
	data: Uint8Array,
): { rel: string } | { error: string } {
	if (data.byteLength > BOX_FILE_MAX_BYTES) {
		return {
			error: `refused: export exceeds the ${BOX_FILE_MAX_BYTES / (1024 * 1024)} MiB cap`,
		};
	}
	const rel = join(relDir, basename(name));
	const written = writeExportBytes(workspace, rel, data);
	if ("error" in written) return written;
	return { rel };
}

// ---------- the app document reader ----------

// A viewer read is bounded by what the app can pull, not the 100 MiB
// transfer bound — same budget as the app attachment upload/serve caps.
export const WORKSPACE_READ_MAX_BYTES = 32 * 1024 * 1024;

// On top of the import boundary, the reader refuses two things a plain
// file-open must never render: auth.jsonl (ruled out forever by
// design/app.md → State viewer, wherever it happens to live — a linked
// project dir can sit outside $GOBLIN_HOME), and anything inside a
// .git dir, where remote URLs can carry credentials.
const READER_DENIED_BASENAMES = new Set(["auth.jsonl"]);
const READER_DENIED_COMPONENTS = new Set([".git"]);

export type WorkspaceReadResult =
	| { path: string; data: Uint8Array }
	| { error: string; code: BoxErrorCode };

/** Whether a denied read means "gone" (404) or "refused" (403) — the
 *  boundary's error codes own the classification so callers don't
 *  re-parse the prose. */
export function workspaceReadStatus(result: { code: BoxErrorCode }): number {
	return result.code === "not-found" ? 404 : 403;
}

export function readWorkspaceFile(
	workspace: string,
	from: string,
	maxBytes: number = WORKSPACE_READ_MAX_BYTES,
): WorkspaceReadResult {
	// The requested name gets an early refusal; the resolved name gets
	// the real one — a symlink called notes.md may not launder
	// auth.jsonl's bytes past the deny.
	if (READER_DENIED_BASENAMES.has(basename(from))) {
		return { error: `refused: ${basename(from)} is never served`, code: "refused" };
	}
	const r = readImport(workspace, from, maxBytes);
	if ("error" in r) return r;
	if (READER_DENIED_BASENAMES.has(basename(r.path))) {
		return {
			error: `refused: ${from} resolves to ${basename(r.path)}, which is never served`,
			code: "refused",
		};
	}
	if (r.path.split(sep).some((part) => READER_DENIED_COMPONENTS.has(part))) {
		return { error: `refused: ${from} resolves inside .git`, code: "refused" };
	}
	return r;
}
