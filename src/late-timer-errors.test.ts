// #648: a timer that errors a stream after its test ends can make
// `bun test --parallel` report an unattributed failure with a blank test name.
// #681 fixed the known case by erroring the stream from pull instead. Keep
// test code from reintroducing stream/controller errors or throws on timers:
// error on read/pull instead of on a timer.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TIMER_CALL_RE = /\b(?:setTimeout|setInterval)\s*\(/g;
const ERROR_RE = /\b\w+\.error\s*\(|\bthrow\b/;

function skipQuoted(source: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i + 1;
		i++;
	}
	return source.length;
}

function skipTrivia(source: string, start: number): number {
	let i = start;
	while (i < source.length) {
		if (/\s/.test(source[i] ?? "")) {
			i++;
			continue;
		}
		if (source.startsWith("//", i)) {
			const end = source.indexOf("\n", i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function firstArgument(source: string, openParen: number): string | null {
	const stack: string[] = [")"];
	const start = skipTrivia(source, openParen + 1);
	if (source[start] === ")") return "";
	if (start >= source.length) return null;

	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (char === "'" || char === '"' || char === "`") {
			i = skipQuoted(source, i, char) - 1;
			continue;
		}
		if (source.startsWith("//", i)) {
			const end = source.indexOf("\n", i + 2);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2);
			if (end === -1) return null;
			i = end + 1;
			continue;
		}
		if (char === "(" || char === "{" || char === "[") {
			stack.push(char === "(" ? ")" : char === "{" ? "}" : "]");
			continue;
		}
		if (char === ")" || char === "}" || char === "]") {
			if (stack.at(-1) !== char) return null;
			if (stack.length === 1) return source.slice(start, i);
			stack.pop();
			continue;
		}
		if (char === "," && stack.length === 1) return source.slice(start, i);
	}
	return null;
}

export function lateTimerErrorLines(source: string): number[] {
	const lines: number[] = [];
	for (const match of source.matchAll(TIMER_CALL_RE)) {
		const call = match.index;
		if (call === undefined) continue;
		const openParen = source.indexOf("(", call);
		const callback = firstArgument(source, openParen);
		if (callback !== null && ERROR_RE.test(callback)) {
			lines.push(source.slice(0, call).split("\n").length);
		}
	}
	return lines;
}

function walkTestFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walkTestFiles(path, out);
		else if (/\.test\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

function repoHits(): string[] {
	const hits: string[] = [];
	for (const file of [...walkTestFiles(join(ROOT, "src")), ...walkTestFiles(join(ROOT, "app", "src"))]) {
		const source = readFileSync(file, "utf8");
		for (const line of lateTimerErrorLines(source)) {
			hits.push(`${file.slice(ROOT.length + 1)}:${line}`);
		}
	}
	return hits.sort();
}

describe("late timer error guard", () => {
	const timeout = "set" + "Timeout(";

	test("the old #681 timer error is flagged", () => {
		const source = `${timeout}() => controller.error(new Error("stream broke")), 5);`;
		expect(lateTimerErrorLines(source)).toEqual([1]);
	});

	test("multi-line timer callbacks are flagged", () => {
		const source = `${timeout}() => {\n  x();\n  controller.error(e);\n}, 5)`;
		expect(lateTimerErrorLines(source)).toEqual([1]);
	});

	test("throws in timer callbacks are flagged", () => {
		const source = `${timeout}() => { throw new Error("x"); }, 1)`;
		expect(lateTimerErrorLines(source)).toEqual([1]);
	});

	test("the pull-based shape has no timer to flag", () => {
		const source = `new ReadableStream({
			pull(controller) {
				controller.error(new Error("stream broke"));
			},
		});`;
		expect(lateTimerErrorLines(source)).toEqual([]);
	});

	test("safe timers are not flagged", () => {
		expect(lateTimerErrorLines(`${timeout}() => ac.abort(), 5)`)).toEqual([]);
		expect(lateTimerErrorLines(`${timeout}resolve, 5)`)).toEqual([]);
	});

	test("no test file errors a stream or throws from a timer", () => {
		const hits = repoHits();
		if (hits.length > 0) {
			process.stderr.write(`${hits.join("\n")}\nerror on read/pull instead of on a timer.\n`);
		}
		expect(hits).toEqual([]);
	});
});
