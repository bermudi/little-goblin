// The viewer's wall is two layers — the router zod-validates every name,
// and the containment check re-verifies in realpath space: lexical
// traversal and symlink indirection (a linked file or a linked parent
// dir) both fail the prefix check. The viewer serves real files, never
// links — symlinked skill dirs don't list and can't be read; the agent
// catalog's sanctioned link-following is untouched. ENOENT degrades to
// null/[]; every other error propagates.

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
	type Stats,
} from "node:fs";
import { join, sep } from "node:path";
import { loadCatalog } from "./agent/skills.ts";

// ---------- skills ----------

export interface OperatorSkillItem {
	name: string;
	/** Files relative to the skill dir, sorted — SKILL.md first. */
	files: string[];
	sizeBytes: number;
	/** SKILL.md's mtime when present, else the dir's own. */
	updatedAt: string | null;
	/** The walk hit a cap — files/sizeBytes are a floor, not the whole tree. */
	truncated: boolean;
}

export interface SkillsResponse {
	skills: OperatorSkillItem[];
	proposed: OperatorSkillItem[];
	/** The invocation picker's view: valid catalog entries, manual-only included. */
	catalog: PickerSkillItem[];
}

// One picker row (ruling 2026-10-21): what an explicit invocation needs
// to be an informed choice — the body size especially, since skills run
// to six figures of bytes.
export interface PickerSkillItem {
	name: string;
	description: string;
	/** disable-model-invocation — unadvertised to the model, invocable by name. */
	manualOnly: boolean;
	/** SKILL.md's byte size — the injection cost of one invocation. */
	bodyBytes: number;
}

// Catalog entries + a stat — the picker is the one skills surface that
// must include manual-only entries (design/skills.md → Skill
// invocation). Malformed dirs the catalog skipped simply don't appear.
export function listPickerSkills(skillsDir: string): PickerSkillItem[] {
	const catalog = loadCatalog(skillsDir);
	const items: PickerSkillItem[] = [];
	for (const e of catalog.entries) {
		let bodyBytes: number;
		try {
			bodyBytes = statSync(join(skillsDir, e.name, "SKILL.md")).size;
		} catch (err) {
			// ENOENT raced the scan — the skill is gone, not zero-sized.
			// Anything else is a real read failure, not an empty row.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		items.push({
			name: e.name,
			description: e.description,
			manualOnly: e.manualOnly === true,
			bodyBytes,
		});
	}
	return items;
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

// A dir beyond MAX_SKILL_DEPTH is never opened — its contents count as
// skipped whether or not any exist.
function listFilesUnder(dir: string, rel: string, depth: number, out: string[]): boolean {
	if (out.length >= MAX_SKILL_FILES || depth > MAX_SKILL_DEPTH) return true;
	let entries: Dirent[];
	try {
		entries = readdirSync(join(dir, rel), { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
	let truncated = false;
	for (const entry of entries) {
		if (out.length >= MAX_SKILL_FILES) return true;
		const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
		if (entry.isDirectory()) truncated = listFilesUnder(dir, relPath, depth + 1, out) || truncated;
		else if (entry.isFile()) out.push(relPath);
	}
	return truncated;
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
		const truncated = listFilesUnder(skillDir, "", 1, files);
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
				// ENOENT raced the walk; anything else is a real read
				// failure, not an empty catalog.
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
				// Dir vanished mid-walk — list it without a timestamp.
				if ((e2 as NodeJS.ErrnoException).code !== "ENOENT") throw e2;
			}
		}
		items.push({ name: entry.name, files, sizeBytes, updatedAt, truncated });
	}
	items.sort((a, b) => a.name.localeCompare(b.name));
	return items;
}

export function listSkills(skillsDir: string, proposedDir: string): SkillsResponse {
	return {
		skills: listSkillDir(skillsDir),
		proposed: listSkillDir(proposedDir),
		catalog: listPickerSkills(skillsDir),
	};
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

// Oversized files throw — surface, never silently truncate.
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
		// persistAttachment stages uploads as dotfile temps that a later
		// rename settles — an in-flight temp is not an attachment.
		if (entry.name.startsWith(".")) continue;
		let st: Stats;
		try {
			st = statSync(join(dir, entry.name));
		} catch (e) {
			// Vanished between readdir and stat — absent, like a missing dir.
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw e;
		}
		files.push({ name: entry.name, sizeBytes: st.size, updatedAt: st.mtime.toISOString() });
	}
	files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return { files };
}

export function attachmentPath(dir: string, name: string): string | null {
	// Leading-dot names are persistAttachment's upload temps — never
	// servable, the same rule the composer read-back enforces.
	if (name.includes("/") || name.includes("\\") || name.startsWith(".")) return null;
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

// svg is deliberately absent: a top-level navigation would run SVG
// scripts in the app origin — it downloads instead.
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

// The route maps it to 413; nothing else catches it.
export class AttachmentTooLargeError extends Error {}

export interface AttachmentBytes {
	bytes: Buffer;
	contentType: string;
}

// Serving is a whole-file read — an unbounded one would let a single
// request buffer arbitrary bytes into the process.
export function readAttachmentBytes(
	dir: string,
	name: string,
	capBytes: number,
): AttachmentBytes | null {
	const full = attachmentPath(dir, name);
	if (full === null) return null;
	try {
		const st = statSync(full);
		if (st.size > capBytes) {
			throw new AttachmentTooLargeError(`attachment too large to serve (${st.size} bytes)`);
		}
		return { bytes: readFileSync(full), contentType: attachmentContentType(name) };
	} catch (e) {
		// Vanished between attachmentPath's stat and the read — absent.
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
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

// A first line with no newline boundary inside the window is dropped as
// partial and reported via `truncated`, never guessed at; a torn write
// is dropped content, reported the same way.
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
	// A short read means the file shrank under stat — report truncation
	// rather than guess.
	const windowCut = start > 0 || read < len;
	const rawLines = buf.subarray(0, read).toString("utf8").split("\n");
	if (windowCut && rawLines.length > 0) rawLines.shift();

	const q = opts.q ?? null;
	const level = opts.level ?? null;
	const matching: LogTailItem[] = [];
	// Parse before the filters: an unreadable line is dropped content
	// wherever it lands; a filtered-out record is intentional selection —
	// only the former is truncation.
	let discarded = 0;
	for (const line of rawLines) {
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// A torn write leaves a half line — it counts as truncation so
			// the view never silently hides content.
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
