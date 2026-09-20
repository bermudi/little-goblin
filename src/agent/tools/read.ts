import { tool } from "ai";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { log } from "../../log.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;
// Reads are whole-file, so gate on size first — a multi-GB log or database
// would OOM the process before the output cap ever applied. Bigger files
// get sliced with bash (sed/head/tail) instead.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

// Any single source line longer than this is clamped before it enters the
// output window — minified JS, base64 blobs and CSV rows would otherwise
// eat the whole 64KB budget in a handful of lines.
export const MAX_LINE_CHARS = 2000;

// Whole-file read guarded for tool use — shared by read_file and edit_file
// (edit_file needs the same gates: it reads the whole file too, and a
// binary file decoded as utf8 would be corrupted on write-back). The
// `kind` discriminates failures for callers; the message is for the model.
export type ReadFileError =
	| { error: string; kind: "not-found" }
	| { error: string; kind: "is-dir" }
	| { error: string; kind: "special" }
	| { error: string; kind: "too-large" }
	| { error: string; kind: "binary" };

export function readTextFile(abs: string, display: string): { text: string } | ReadFileError {
	let raw: Buffer;
	try {
		const st = statSync(abs);
		if (st.isDirectory()) {
			return { error: `is a directory: ${display}`, kind: "is-dir" };
		}
		// Special files hang or lie: /dev/zero reports size 0 (passes the gate
		// below) and never reaches EOF; a FIFO with no writer blocks forever.
		// /proc pseudo-files report as regular and stay readable — the stat
		// flags are the discriminator, not a path blocklist.
		if (st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket()) {
			return {
				error: `refusing to read special file (device/fifo/socket): ${display} — use the bash tool if you really need it`,
				kind: "special",
			};
		}
		if (st.size > MAX_FILE_BYTES) {
			return {
				error: `file too large: ${display} (${st.size} bytes, max ${MAX_FILE_BYTES}) — slice it with bash (sed/head/tail)`,
				kind: "too-large",
			};
		}
		raw = readFileSync(abs);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// A differently-normalized twin may exist (macOS NFD names): every
			// file tool resolves through the same twin so read, edit, and write
			// land on one file instead of forking it under a second spelling.
			const twin = unicodeTwin(abs);
			if (twin !== null) {
				log.info("read_unicode_retry", { original: abs, variant: twin });
				return readTextFile(twin, display);
			}
			return { error: `file not found: ${display}`, kind: "not-found" };
		}
		if ((err as NodeJS.ErrnoException).code === "EISDIR") {
			return { error: `is a directory: ${display}`, kind: "is-dir" };
		}
		throw err;
	}
	if (raw.includes(0)) {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)`, kind: "binary" };
	}
	// Fatal decode: lossy utf8 would let invalid bytes through, and
	// edit_file writes the decoded text back — corrupting the file.
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
	} catch {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)`, kind: "binary" };
	}
}

// Bounded Levenshtein: returns true if edit distance between a and b is
// <= max (3 at call sites). Early-exits once a row's minimum exceeds max.
function withinLevenshtein(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) return false;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
			rowMin = Math.min(rowMin, cur[j]!);
		}
		if (rowMin > max) return false;
		prev = cur;
	}
	return prev[b.length]! <= max;
}

// Suggest up to 3 near-miss filenames from the containing directory:
// case-insensitive exact, then substring either direction, then
// levenshtein <= 2 on the basename.
function suggestAlternatives(abs: string): string[] {
	const parent = dirname(abs);
	const base = basename(abs);
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return []; // parent missing / unreadable — plain error, no suggestion
	}
	const lower = base.toLowerCase();
	const picked: string[] = [];
	const take = (name: string): void => {
		if (picked.length < 3 && !picked.includes(name)) picked.push(name);
	};
	for (const e of entries) {
		if (e.toLowerCase() === lower) take(e);
	}
	for (const e of entries) {
		const el = e.toLowerCase();
		// 4-char floor: without it a 1-3 char entry matches inside almost
		// any miss ("efi" inside "definitely-not-here") and the suggestion
		// is pure noise.
		if (
			el !== lower &&
			el.length >= 4 &&
			lower.length >= 4 &&
			(el.includes(lower) || lower.includes(el))
		) {
			take(e);
		}
	}
	for (const e of entries) {
		if (!withinLevenshtein(base, e, 2)) continue;
		take(e);
	}
	return picked;
}

// read_file's readTextFile wrapper: decorates a genuine not-found with
// did-you-mean candidates. (The NFC/NFD twin retry lives inside
// readTextFile itself so every file tool shares it.)
function readTextFileSmart(abs: string, display: string): { text: string } | ReadFileError {
	const read = readTextFile(abs, display);
	if (!("error" in read) || read.kind !== "not-found") return read;
	const alts = suggestAlternatives(abs);
	if (alts.length === 0) return read;
	return { error: `file not found: ${display} — did you mean: ${alts.join(", ")}?`, kind: "not-found" };
}

// Image sniffing for the tool layer: providers carry tool results as
// strings, so image bytes must never reach the model. Reads at most the
// first few KB — never the whole file. JPEG needs the headroom: APP0/
// EXIF/DQT segments routinely push the SOF frame header past 64 bytes.
const SNIFF_BYTES = 4096;
export function sniffImage(abs: string): { mediaType: string; width?: number; height?: number } | null {
	let fd: number;
	try {
		fd = openSync(abs, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.alloc(SNIFF_BYTES);
		const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
		const b = buf.subarray(0, n);
		// PNG: signature then IHDR chunk — dims at offset 16/20, big-endian.
		if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
			return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
		}
		// JPEG: walk start-of-frame markers; SOF0/1/2 carry 16-bit dims.
		if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
			let i = 2;
			while (i + 9 < b.length) {
				if (b[i] !== 0xff) {
					i++;
					continue;
				}
				const marker = b[i + 1]!;
				// SOF0..SOF15, excluding DAC (C4), JPG (C8), RST segments.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return {
						mediaType: "image/jpeg",
						height: b.readUInt16BE(i + 5),
						width: b.readUInt16BE(i + 7),
					};
				}
				// Skip this segment by its length; stop if it runs past the window.
				if (i + 3 >= b.length) break;
				i += 2 + b.readUInt16BE(i + 2);
			}
			return { mediaType: "image/jpeg" };
		}
		// GIF: magic "GIF8", little-endian dims at offset 6.
		if (b.length >= 10 && b.subarray(0, 4).toString("latin1") === "GIF8") {
			return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
		}
		// BMP: "BM", little-endian dims at offset 18.
		if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
			return { mediaType: "image/bmp", width: b.readInt32LE(18), height: b.readInt32LE(22) };
		}
		// WEBP: RIFF container with WEBP fourcc — dims live deeper in the
		// chunk stream, mediaType only.
		if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
			return { mediaType: "image/webp" };
		}
		return null;
	} finally {
		closeSync(fd);
	}
}

function clampLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	// Back off a lone lead surrogate at the seam — slicing on UTF-16 units
	// can otherwise split an emoji in half and hand the model a U+FFFD.
	let cut = line.slice(0, MAX_LINE_CHARS);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	const omitted = line.length - cut.length;
	return (
		cut +
		` … [+${omitted} chars truncated — see the full line with bash; do not quote this line for edits]`
	);
}

export const readFileTool = (cwd: string) =>
	tool({
		description:
			"Read a file's contents with line numbers. offset is 1-based; a negative offset reads the tail (-5 = last 5 lines); limit caps lines returned. " +
			`Output is capped at ${MAX_LINES} lines / ${MAX_BYTES / 1024}KB — the cap notice says which offset continues the file.`,
		inputSchema: z.object({
			path: z.string().describe("File path, relative to the working directory or absolute"),
			offset: z
				.number()
				.int()
				.refine((v) => v !== 0, "offset must be non-zero")
				.optional()
				.describe("1-based start line; negative reads the tail (last |offset| lines)"),
			limit: z.number().int().positive().optional(),
		}),
		execute: async ({ path, offset, limit }) => {
			const abs = resolvePath(cwd, path);
			const read = readTextFileSmart(abs, path);
			if ("error" in read) {
				// Providers can't carry image bytes in tool results — turn a
				// binary/too-large refusal into a structured note when the file
				// is actually an image, so the model knows what it's holding.
				if (read.kind === "binary" || read.kind === "too-large") {
					const sniff = sniffImage(abs);
					if (sniff) {
						const size = statSync(abs).size;
						const dims =
							sniff.width !== undefined && sniff.height !== undefined
							? ` ${sniff.width}x${sniff.height}`
							: "";
						return {
							content:
								`[image file ${sniff.mediaType}${dims}, ${size} bytes — read_file cannot show images to the model. ` +
								`To let me actually see it, have the operator send it via Telegram; otherwise inspect it via bash (ffmpeg -i gives full metadata).]`,
							lines: 0,
							shown: 0,
						};
					}
				}
				return read;
			}
			if (read.text.length === 0) {
				// 0 bytes → a single blank numbered line would just look broken.
				// Whitespace-only files are not empty and keep their numbering.
				return { content: "[file is empty — 0 bytes]", lines: 0, shown: 0 };
			}
			const lines = read.text.split("\n");
			const total = lines.length;

			// An offset past EOF is an error with the real count, not a silent
			// empty read — the model can't tell "empty file" from "bad guess"
			// otherwise. Negative offsets clamp: asking for the last 500 lines
			// of a 30-line file means the whole file, not an error.
			if (offset !== undefined && offset > 0 && offset > total) {
				return { error: `offset ${offset} is beyond end of file (${total} lines)` };
			}
			const start = offset !== undefined && offset < 0 ? Math.max(0, total + offset) : (offset ?? 1) - 1;
			// The user's limit is honored first; caps apply to what they asked for.
			const limitEnd = limit !== undefined ? Math.min(start + limit, total) : total;

			// A single line bigger than the whole output cap can't be shown at
			// all — point at the bash fallback instead of emitting a marker that
			// carries no content. Checked on the raw source line, before the
			// per-line clamp: the clamp handles 2K–64K lines, bash handles monsters.
			const firstRaw = `${start + 1}\t${lines[start] ?? ""}\n`;
			if (Buffer.byteLength(firstRaw, "utf8") > MAX_BYTES) {
				return {
					content:
						`Line ${start + 1} alone is ${Buffer.byteLength(firstRaw, "utf8")} bytes — exceeds the ${MAX_BYTES / 1024}KB read_file cap. ` +
						`Slice it with bash: sed -n '${start + 1}p' "${path}" | head -c ${MAX_BYTES}`,
					lines: total,
					shown: 0,
				};
			}

			// Emit complete numbered lines only — never a partial line — stopping
			// at whichever cap hits first (line count or output bytes, line-number
			// prefixes included in the byte accounting). Lines are clamped before
			// byte accounting so junk lines can't consume the window.
			const out: string[] = [];
			let bytes = 0;
			let shown = 0;
			let i = start;
			for (; i < limitEnd && shown < MAX_LINES; i++) {
				const line = `${i + 1}\t${clampLine(lines[i] ?? "")}\n`;
				if (bytes + Buffer.byteLength(line, "utf8") > MAX_BYTES) break;
				out.push(line);
				bytes += Buffer.byteLength(line, "utf8");
				shown++;
			}

			// The continuation notice is the point of pre-capping: whenever
			// output stops short, it names the exact offset that resumes the
			// file, so paging is one call away instead of a guessing game.
			let notice = "";
			if (shown < MAX_LINES && i < limitEnd) {
				notice = `\n[Showing lines ${start + 1}–${i} of ${total} (${MAX_BYTES / 1024}KB limit). Use offset=${i + 1} to continue.]`;
			} else if (shown >= MAX_LINES && start + shown < limitEnd) {
				notice = `\n[Showing lines ${start + 1}–${start + shown} of ${total} (${MAX_LINES}-line limit). Use offset=${start + shown + 1} to continue.]`;
			} else if (limitEnd < total) {
				notice = `\n[${total - limitEnd} more lines in file. Use offset=${limitEnd + 1} to continue.]`;
			}
			return { content: out.join("") + notice, lines: total, shown };
		},
	});
