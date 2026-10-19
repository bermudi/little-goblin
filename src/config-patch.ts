// Saves used to rewrite goblin.json5 wholesale — every settings save
// destroyed the operator's comments, key ordering, and any key the
// schema doesn't know (a hand-edited experiment, a comment block, a
// field a newer build hasn't taught the UI about). patchConfigText
// rewrites only the top-level entries whose parsed value changed:
// untouched keys keep their bytes verbatim, a known key the merged
// config dropped is deleted, new keys append before the closing
// brace. Anything the scanner can't safely read — a non-object root,
// a duplicate key — returns null and the caller writes the canonical
// stringify instead: a save degrades, it never corrupts.

import JSON5 from "json5";
import { log } from "./log.ts";

interface Entry {
	key: string;
	// [start, end) — key token through its trailing comma (or value end
	// for the last entry). `lineStart` lets a deletion take its whole
	// line when the key leads it.
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
	lineStart: number;
	commaStart: number; // the entry's own trailing comma, or -1
}

// Skip whitespace and both JSON5 comment kinds; returns the first
// significant offset. `toNewline` stops before the line break (the
// caller wants the comma span, not the comment tail).
function skipBlank(text: string, i: number): number {
	const n = text.length;
	for (;;) {
		while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
		if (text.startsWith("//", i)) {
			const nl = text.indexOf("\n", i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}
		if (text.startsWith("/*", i)) {
			const close = text.indexOf("*/", i + 2);
			if (close === -1) return n; // unterminated — the JSON5 parse fails anyway
			i = close + 2;
			continue;
		}
		return i;
	}
}

// Scan a string literal starting at i (a ' or " quote) → one past its
// close, honoring backslash escapes.
function stringEnd(text: string, i: number): number {
	const q = text[i]!;
	let j = i + 1;
	while (j < text.length) {
		const c = text[j]!;
		if (c === "\\") {
			j += 2;
			continue;
		}
		if (c === q) return j + 1;
		j++;
	}
	return text.length;
}

// Top-level entries of the root object. Null means the text isn't a
// single JSON5 object the patcher can reason about — caller falls back.
function scanEntries(text: string): { entries: Entry[]; rootEnd: number } | null {
	const n = text.length;
	let i = skipBlank(text, 0);
	if (text[i] !== "{") return null;
	i++;
	const entries: Entry[] = [];
	for (;;) {
		i = skipBlank(text, i);
		if (i >= n) return null;
		if (text[i] === "}") return { entries, rootEnd: i };
		// Key: identifier or quoted string.
		const keyStart = i;
		const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
		let key: string;
		if (text[i] === '"' || text[i] === "'") {
			const kEnd = stringEnd(text, i);
			try {
				const parsed: unknown = JSON5.parse(text.slice(i, kEnd));
				if (typeof parsed !== "string") return null;
				key = parsed;
			} catch {
				return null;
			}
			i = kEnd;
		} else {
			const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
			if (m === null) return null;
			key = m[0];
			i += m[0].length;
		}
		i = skipBlank(text, i);
		if (text[i] !== ":") return null;
		i = skipBlank(text, i + 1);
		const valueStart = i;
		// Scan the value until a depth-0 "," or the closing "}". Strings
		// and comments inside it are skipped whole; a comment sitting in
		// the gap between value and terminator is part of the span (a
		// changed value takes its attached note with it).
		let depth = 0;
		let term = -1;
		while (i < n) {
			const c = text[i]!;
			if (c === '"' || c === "'") {
				i = stringEnd(text, i);
				continue;
			}
			if (text.startsWith("//", i)) {
				const nl = text.indexOf("\n", i);
				i = nl === -1 ? n : nl;
				continue;
			}
			if (text.startsWith("/*", i)) {
				const close = text.indexOf("*/", i + 2);
				if (close === -1) return null;
				i = close + 2;
				continue;
			}
			if (c === "{" || c === "[" || c === "(") {
				depth++;
				i++;
				continue;
			}
			if (c === "}" || c === "]" || c === ")") {
				if (depth === 0) {
					// '}' can only close the root — ']' or ')' here is malformed.
					if (c !== "}") return null;
					term = i;
					break;
				}
				depth--;
				i++;
				continue;
			}
			if (c === "," && depth === 0) {
				term = i;
				break;
			}
			i++;
		}
		if (term === -1) return null;
		// The value token's end — trailing whitespace before the
		// terminator is the entry's, not the value's, so a rewrite never
		// makes "}" hug and a deletion leaves the file's line rhythm.
		let valueEnd = term;
		while (valueEnd > valueStart && " \t\n\r".includes(text[valueEnd - 1]!)) valueEnd--;
		const commaStart = text[term] === "," ? term : -1;
		entries.push({
			key,
			start: keyStart,
			end: commaStart === -1 ? valueEnd : commaStart + 1,
			valueStart,
			valueEnd,
			lineStart,
			commaStart,
		});
		i = commaStart === -1 ? valueEnd : commaStart + 1;
	}
}

// JSON5.stringify of one entry value, continuation lines re-indented
// under the entry's own leading whitespace so a nested block lands at
// the file's rhythm.
function serializeAt(value: unknown, indent: string): string {
	return JSON5.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	return ak.every(
		(k) =>
			Object.hasOwn(b, k) &&
			deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

// The one public verb. merged is the fully-parsed Config about to be
// written; normalize re-parses raw file text the same way so a sparse
// hand-written block (defaults materialized) still reads unchanged.
// knownKeys marks the schema's top-level fields — a key absent from
// merged is deleted only when the schema owns it; unknown keys always
// keep their text.
export function patchConfigText<T extends object>(
	text: string,
	merged: T,
	normalize: (raw: unknown) => T,
	knownKeys: ReadonlySet<string>,
): string | null {
	const m = merged as Record<string, unknown>;
	let raw: unknown;
	try {
		raw = JSON5.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const rawCfg = raw as Record<string, unknown>;
	const scanned = scanEntries(text);
	if (scanned === null) return null;
	const { entries, rootEnd } = scanned;
	const keys = new Set(entries.map((e) => e.key));
	if (keys.size !== entries.length) return null; // duplicate keys — don't guess

	// Replacements and deletions, applied right-to-left over the text.
	const edits: { start: number; end: number; text: string }[] = [];
	for (const [idx, e] of entries.entries()) {
		const mergedHas = Object.hasOwn(m, e.key);
		if (!mergedHas) {
			if (!knownKeys.has(e.key)) continue; // schema never heard of it — verbatim
			if (e.commaStart === -1 && idx > 0) {
				// Last entry without a trailing comma: the comma to eat
				// lives on the previous entry's tail — the span covers the
				// newline + indent before this key by itself.
				edits.push({ start: entries[idx - 1]!.end - 1, end: e.valueEnd, text: "" });
				continue;
			}
			// Whole-line removal when the key leads its line; the trailing
			// comma and the line's own newline go with it so no blank
			// line survives.
			let start = e.start;
			let end = e.end;
			if (text.slice(e.lineStart, e.start).trim() === "") start = e.lineStart;
			let e2 = end;
			while (e2 < text.length && (text[e2] === " " || text[e2] === "\t")) e2++;
			if (text[e2] === "\n") e2++;
			end = e2;
			edits.push({ start, end, text: "" });
			continue;
		}
		// The raw on-disk value vs the merged value: a key whose bytes
		// only differ in formatting compares equal and stays verbatim;
		// a semantically different block (defaults to materialize, a
		// retired key the schema strips) rewrites through canonical
		// stringify — same shape the old wholesale write produced.
		if (deepEqual(rawCfg[e.key], m[e.key])) continue;
		// Indent comes from the entry's own line lead — a mid-line entry
		// (minified file) has none, so its continuation lines go flush.
		const lead = text.slice(e.lineStart, e.start);
		const indent = lead.trim() === "" ? lead : "";
		edits.push({
			start: e.valueStart,
			end: e.valueEnd,
			text: serializeAt(m[e.key], indent),
		});
	}

	// Keys merged carries that the file doesn't — append before "}".
	const inserts: string[] = [];
	let indent = "  ";
	const firstEntry = entries[0];
	if (firstEntry !== undefined) {
		const lead = text.slice(firstEntry.lineStart, firstEntry.start);
		if (lead.trim() === "") indent = lead;
	}
	for (const k of Object.keys(m)) {
		if (keys.has(k)) continue;
		inserts.push(`${indent}${k}: ${serializeAt(m[k], indent)},\n`);
	}
	if (inserts.length > 0) {
		const last = entries[entries.length - 1];
		// The previous tail needs its comma before new entries land. When
		// its value hugs "}" (last.valueEnd === rootEnd) the comma and the
		// insert run splice at the same offset — fold them into one edit,
		// comma first, or right-to-left application emits ",\n,}".
		const needsComma = last !== undefined && last.commaStart === -1;
		const fused = needsComma && last.valueEnd === rootEnd;
		if (needsComma && !fused) {
			edits.push({ start: last.valueEnd, end: last.valueEnd, text: "," });
		}
		edits.push({
			start: rootEnd,
			end: rootEnd,
			text: last === undefined ? `\n${inserts.join("")}` : (fused ? "," : "") + inserts.join(""),
		});
	}

	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	}

	// Never write a patch that doesn't re-parse to the merged config.
	try {
		const reparsed = normalize(JSON5.parse(out));
		if (!deepEqual(reparsed, merged)) {
			log.warn("config patch verify failed — writing canonical form");
			return null;
		}
	} catch (err) {
		log.warn("config patch verify failed — writing canonical form", err);
		return null;
	}
	return out;
}
