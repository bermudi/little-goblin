import { tool } from "ai";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { log } from "../../log.ts";
import { SNIFF_HEAD, sniffImageBytes, type SniffedImage } from "../sniff.ts";
import { resolvePath, unicodeTwin } from "./paths.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const MAX_LINE_CHARS = 2000;

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
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
	} catch {
		return { error: `binary file: ${display} (${raw.byteLength} bytes)`, kind: "binary" };
	}
}

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

function suggestAlternatives(abs: string): string[] {
	const parent = dirname(abs);
	const base = basename(abs);
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
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

function readTextFileSmart(abs: string, display: string): { text: string } | ReadFileError {
	const read = readTextFile(abs, display);
	if (!("error" in read) || read.kind !== "not-found") return read;
	const alts = suggestAlternatives(abs);
	if (alts.length === 0) return read;
	return {
		error: `file not found: ${display} — did you mean: ${alts.join(", ")}?`,
		kind: "not-found",
	};
}

export function sniffImage(abs: string): SniffedImage | null {
	let fd: number;
	try {
		fd = openSync(abs, "r");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`cannot open image candidate ${abs}: ${String(err)}`, { cause: err });
	}
	try {
		const buf = Buffer.alloc(SNIFF_HEAD);
		const n = readSync(fd, buf, 0, SNIFF_HEAD, 0);
		return sniffImageBytes(buf.subarray(0, n));
	} finally {
		closeSync(fd);
	}
}

function clampLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	let cut = line.slice(0, MAX_LINE_CHARS);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	const omitted = line.length - cut.length;
	return (
		cut +
		` … [+${omitted} chars truncated — see the full line with bash; do not quote this line for edits]`
	);
}

export const readFileTool = (cwd: string, visionAvailable = false) =>
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
				if (read.kind === "binary" || read.kind === "too-large") {
					const sniff = sniffImage(abs);
					if (sniff) {
						const size = statSync(abs).size;
						const dims =
							sniff.width !== undefined && sniff.height !== undefined
								? ` ${sniff.width}x${sniff.height}`
								: "";
						const channels = visionAvailable
							? `Use the vision tool to ask questions about what it shows; `
							: `Have the operator send it via Telegram so I can see it natively; `;
						return {
							content:
								`[image file ${sniff.mediaType}${dims}, ${size} bytes — read_file cannot show images to the model. ` +
								`${channels}otherwise inspect it via bash (ffmpeg -i gives full metadata).]`,
							lines: 0,
							shown: 0,
						};
					}
				}
				return read;
			}
			if (read.text.length === 0) {
				return { content: "[file is empty — 0 bytes]", lines: 0, shown: 0 };
			}
			const lines = read.text.split("\n");
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			const total = lines.length;

			if (offset !== undefined && offset > 0 && offset > total) {
				return { error: `offset ${offset} is beyond end of file (${total} lines)` };
			}
			const start =
				offset !== undefined && offset < 0 ? Math.max(0, total + offset) : (offset ?? 1) - 1;
			const limitEnd = limit !== undefined ? Math.min(start + limit, total) : total;

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
