// The workspace file boundary, shared by the native sandbox/desktop
// tools and subagent run inboxes (design/subagents.md → Files in and
// out): imports start at a workspace path whose realpath stays inside
// the workspace, exports land on a workspace-relative path whose
// ancestors and leaf can't aim the write outside. Host reads/writes
// are deliberate acts — these are the only gates.

import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { durableWriteBytes } from "./durable.ts";
import { writeThroughTarget } from "./agent/tools/paths.ts";

export const BOX_FILE_MAX_BYTES = 100 * 1024 * 1024;

export type BoxPathResult = { path: string } | { error: string };
export type BoxImportResult = { path: string; bytes: number } | { error: string };

function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(root + sep);
}

/** Unique non-clobbering basename: `name.ext`, `name.1.ext`, … */
function numberedName(dir: string, base: string): string {
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 0; ; i++) {
		const candidate = i === 0 ? base : `${stem}.${i}${ext}`;
		if (!existsSync(join(dir, candidate))) return candidate;
	}
}

/** Import side: a workspace path that exists, stays inside the
 *  workspace under realpath, and names a regular file within the cap. */
export function resolveImport(workspace: string, from: string): BoxImportResult {
	const wsLex = resolve(workspace);
	const resolved = isAbsolute(from) ? resolve(from) : resolve(wsLex, from);
	// A lexical `..` escape is refused before the filesystem is
	// touched — realpath only runs once the path exists.
	if (!inside(wsLex, resolved)) {
		return {
			error: `refused: ${from} resolves to ${resolved}, outside the workspace — copy it into the workspace first if this is deliberate`,
		};
	}
	let real: string;
	try {
		real = realpathSync(resolved);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: `source not found: ${from}` };
		}
		throw err;
	}
	const wsReal = realpathSync(wsLex);
	if (!inside(wsReal, real)) {
		return {
			error: `refused: ${from} resolves to ${real}, outside the workspace — copy it into the workspace first if this is deliberate`,
		};
	}
	const st = statSync(real);
	if (!st.isFile()) {
		return { error: `refused: ${from} is not a regular file` };
	}
	if (st.size > BOX_FILE_MAX_BYTES) {
		return {
			error: `refused: ${from} exceeds the ${BOX_FILE_MAX_BYTES / (1024 * 1024)} MiB cap`,
		};
	}
	return { path: real, bytes: st.size };
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
	// The real destination dir anchors collision numbering — a leaf
	// symlink elsewhere in relDir must not steer the check.
	const dir = resolveExportDir(workspace, relDir);
	if ("error" in dir) return dir;
	const base = numberedName(dir.path, basename(sourceBaseName));
	const dest = resolveExport(workspace, join(relDir, base));
	if ("error" in dest) return dest;
	durableWriteBytes(dest.path, data);
	return { rel: join(relDir, base) };
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
	const dest = resolveExport(workspace, join(relDir, basename(name)));
	if ("error" in dest) return dest;
	durableWriteBytes(dest.path, data);
	return { rel: join(relDir, basename(name)) };
}
