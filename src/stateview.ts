// Read-only views over $GOBLIN_HOME state for the operator surface
// (design/app.md → Operator console): skills, attachments, identity
// files, and the log tail. The viewer's wall is two layers — the router
// zod-validates every name it accepts, and the containment check here
// re-verifies, in realpath space, that a resolved path stays under the
// directory it was addressed against: lexical traversal and symlink
// indirection (a linked file or a linked parent directory) both fail
// the prefix check. The viewer serves real files under the tree, never
// links — symlinked skill dirs don't list and can't be read; the agent
// catalog's sanctioned link-following (design/skills.md) is untouched.
// Nothing here writes; ENOENT degrades to null/[] so a missing
// directory renders as empty instead of failing the whole view, while
// every other error propagates.

import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	type Dirent,
} from "node:fs";
import { join, sep } from "node:path";

// ---------- skills ----------

/** One installed (or proposed) skill: its files, ready to be read. */
export interface OperatorSkillItem {
	name: string;
	/** Files relative to the skill dir, sorted — SKILL.md first. */
	files: string[];
	sizeBytes: number;
	/** SKILL.md's mtime when present, else the dir's own. */
	updatedAt: string | null;
}

export interface SkillsResponse {
	skills: OperatorSkillItem[];
	proposed: OperatorSkillItem[];
}

export interface SkillFileResponse {
	path: string;
	content: string;
}

// Skills are small by nature; a file above this is a mistake worth
// surfacing, not content to stream.
const TEXT_VIEW_CAP = 2 * 1024 * 1024;

// Skill dirs hold a handful of files; the bounds keep a pathological
// tree from turning one catalog read into a walk.
const MAX_SKILL_FILES = 200;
const MAX_SKILL_DEPTH = 3;

function listFilesUnder(dir: string, rel: string, depth: number, out: string[]): void {
	if (out.length >= MAX_SKILL_FILES || depth > MAX_SKILL_DEPTH) return;
	let entries: Dirent[];
	try {
		entries = readdirSync(join(dir, rel), { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
	for (const entry of entries) {
		if (out.length >= MAX_SKILL_FILES) return;
		const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) listFilesUnder(dir, relPath, depth + 1, out);
		else if (entry.isFile()) out.push(relPath);
	}
}

export function listSkillDir(dir: string): OperatorSkillItem[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const items: OperatorSkillItem[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillDir = join(dir, entry.name);
		const files: string[] = [];
		listFilesUnder(skillDir, "", 1, files);
		// SKILL.md leads so a viewer can default to it.
		files.sort((a, b) => {
			if (a === "SKILL.md") return -1;
			if (b === "SKILL.md") return 1;
			return a.localeCompare(b);
		});
		let sizeBytes = 0;
		for (const f of files) {
			try {
				sizeBytes += statSync(join(skillDir, f)).size;
			} catch (e) {
				// A vanished file raced the walk — count what's still
				// there. Anything else (a locked-down dir, say) is a real
				// read failure, not an empty catalog.
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
		}
		let updatedAt: string | null = null;
		try {
			updatedAt = statSync(join(skillDir, "SKILL.md")).mtime.toISOString();
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			try {
				updatedAt = statSync(skillDir).mtime.toISOString();
			} catch (e2) {
				// Dir vanished mid-walk — skip it.
				if ((e2 as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw e2;
			}
		}
		items.push({ name: entry.name, files, sizeBytes, updatedAt });
	}
	items.sort((a, b) => a.name.localeCompare(b.name));
	return items;
}

export function listSkills(skillsDir: string, proposedDir: string): SkillsResponse {
	return { skills: listSkillDir(skillsDir), proposed: listSkillDir(proposedDir) };
}

// The containment check every read funnels through, enforced in
// realpath space: a symlink at any component resolves to its target,
// and a target outside the base fails the prefix check — zod's regex
// at the router is the first gate, this is the one that actually holds.
// ENOENT on either side is null (a missing base renders empty); a
// symlink loop or other filesystem error propagates.
function contained(base: string, rel: string): string | null {
	let baseRes: string;
	let full: string;
	try {
		baseRes = realpathSync(base);
		full = realpathSync(join(base, rel));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	if (full !== baseRes && !full.startsWith(baseRes + sep)) return null;
	return full;
}

/**
 * Read one file under `base`, addressing it with a `/`-relative path.
 * Returns null when the file or the base directory is missing; throws
 * when the file exceeds the view cap, so an oversized target surfaces
 * instead of silently truncating.
 */
export function readStateFile(base: string, rel: string): string | null {
	const full = contained(base, rel);
	if (full === null) return null;
	let st;
	try {
		st = statSync(full);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	if (!st.isFile()) return null;
	if (st.size > TEXT_VIEW_CAP) {
		throw new Error(`file too large to view (${st.size} bytes): ${rel}`);
	}
	try {
		return readFileSync(full, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export function readSkillFile(
	skillsDir: string,
	proposedDir: string,
	origin: "skills" | "proposed",
	name: string,
	rel: string,
): SkillFileResponse | null {
	const base = origin === "skills" ? skillsDir : proposedDir;
	if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
	// Match the catalog: a linked skill directory is not a viewer skill.
	// Checking only the file would let a link redefine its trusted base.
	try {
		if (!lstatSync(join(base, name)).isDirectory()) return null;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const skillDir = contained(base, name);
	if (skillDir === null) return null;
	const content = readStateFile(skillDir, rel);
	if (content === null) return null;
	return { path: `${name}/${rel}`, content };
}

// ---------- attachments ----------

export interface OperatorAttachmentItem {
	name: string;
	sizeBytes: number;
	updatedAt: string;
}

export interface AttachmentsResponse {
	files: OperatorAttachmentItem[];
}

export function listAttachments(dir: string): AttachmentsResponse {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { files: [] };
		throw e;
	}
	const files: OperatorAttachmentItem[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const st = statSync(join(dir, entry.name));
		files.push({ name: entry.name, sizeBytes: st.size, updatedAt: st.mtime.toISOString() });
	}
	files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return { files };
}

/**
 * Resolve an attachment name to a servable path, or null when the name
 * is not a plain file directly inside `dir`.
 */
export function attachmentPath(dir: string, name: string): string | null {
	if (name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
	const full = contained(dir, name);
	if (full === null) return null;
	try {
		if (!statSync(full).isFile()) return null;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	return full;
}

/** Content-type for serving an attachment — conservative, extension-based.
 * svg is deliberately absent: inert inside an <img>, but a top-level
 * navigation would run SVG scripts in the app origin — it downloads. */
export function attachmentContentType(name: string): string {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		ogg: "audio/ogg",
		oga: "audio/ogg",
		opus: "audio/ogg",
		mp3: "audio/mpeg",
		wav: "audio/wav",
		mp4: "video/mp4",
		webm: "video/webm",
		pdf: "application/pdf",
		zip: "application/zip",
		txt: "text/plain; charset=utf-8",
		md: "text/plain; charset=utf-8",
		json: "application/json",
	};
	return map[ext] ?? "application/octet-stream";
}

/** Thrown when an attachment exceeds the serve cap — the route maps it
 * to 413; nothing else catches it. */
export class AttachmentTooLargeError extends Error {}

export interface AttachmentBytes {
	bytes: Buffer;
	contentType: string;
}

/** Read one attachment for serving — through attachmentPath's wall, with
 * a hard size cap: serving is a whole-file read, and an unbounded one
 * would let a single request buffer arbitrary bytes into the process. */
export function readAttachmentBytes(
	dir: string,
	name: string,
	capBytes: number,
): AttachmentBytes | null {
	const full = attachmentPath(dir, name);
	if (full === null) return null;
	const st = statSync(full);
	if (st.size > capBytes) {
		throw new AttachmentTooLargeError(`attachment too large to serve (${st.size} bytes)`);
	}
	return { bytes: readFileSync(full), contentType: attachmentContentType(name) };
}

// ---------- identity files ----------

export interface IdentityFile {
	name: string;
	content: string | null;
}

export interface IdentityResponse {
	files: IdentityFile[];
}

export function identityFiles(workspaceDir: string): IdentityResponse {
	const names = ["SOUL.md", "USER.md", "AGENTS.md"];
	return {
		files: names.map((name) => ({ name, content: readStateFile(workspaceDir, name) })),
	};
}

// ---------- log tail ----------

export interface LogTailItem {
	ts: string | null;
	level: string;
	msg: string;
	/** The raw JSONL line, for anything the parsed view leaves out. */
	line: string;
}

export interface LogTailResponse {
	lines: LogTailItem[];
	/** True when content existed beyond the scan window or the limit. */
	truncated: boolean;
	scannedBytes: number;
}

export interface LogTailOptions {
	limit: number;
	/** Exact level match; null/undefined keeps every level. */
	level?: string | null;
	/** Substring match against the raw line. */
	q?: string | null;
	/** Scan window from the end of the file; default 512 KiB. */
	windowBytes?: number;
}

const DEFAULT_LOG_WINDOW = 512 * 1024;

/**
 * The last `limit` matching lines of the JSONL log, oldest first. The
 * scan reads at most `windowBytes` from the end; a first line with no
 * leading newline boundary inside the window is dropped as partial and
 * reported via `truncated`, never guessed at — and a line that fails to
 * parse (a torn write) is likewise dropped content, reported the same way.
 */
export function tailLog(logFile: string, opts: LogTailOptions): LogTailResponse {
	const windowBytes = opts.windowBytes ?? DEFAULT_LOG_WINDOW;
	let size: number;
	try {
		size = statSync(logFile).size;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return { lines: [], truncated: false, scannedBytes: 0 };
		}
		throw e;
	}
	const start = Math.max(0, size - windowBytes);
	const len = size - start;
	const buf = Buffer.alloc(len);
	const fd = openSync(logFile, "r");
	let read: number;
	try {
		read = readSync(fd, buf, 0, len, start);
	} finally {
		closeSync(fd);
	}
	// A short read means the file shrank under stat — the slice is no
	// longer the true tail, so report truncation rather than guess.
	const windowCut = start > 0 || read < len;
	const rawLines = buf.subarray(0, read).toString("utf8").split("\n");
	// The window's first slice is mid-line unless the window starts at
	// byte 0 or happened to cut exactly on the newline.
	if (windowCut && rawLines.length > 0) rawLines.shift();

	const q = opts.q ?? null;
	const level = opts.level ?? null;
	const matching: LogTailItem[] = [];
	// Parsing comes before the q/level filters: a line that cannot be
	// read is dropped content wherever it lands, while a filtered-out
	// record is intentional selection — only the former is truncation.
	let discarded = 0;
	for (const line of rawLines) {
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// A torn write can leave a half line; skip it, it counts as
			// truncation so the view never silently hides content.
			discarded++;
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) {
			discarded++;
			continue;
		}
		if (q !== null && !line.includes(q)) continue;
		const rec = parsed as Record<string, unknown>;
		if (level !== null && rec["level"] !== level) continue;
		matching.push({
			ts: typeof rec["ts"] === "string" ? rec["ts"] : null,
			level: typeof rec["level"] === "string" ? rec["level"] : "?",
			msg: typeof rec["msg"] === "string" ? rec["msg"] : "",
			line,
		});
	}
	const limit = Math.max(1, opts.limit);
	const lines = matching.slice(-limit);
	return {
		lines,
		truncated: windowCut || discarded > 0 || matching.length > limit,
		scannedBytes: len,
	};
}
