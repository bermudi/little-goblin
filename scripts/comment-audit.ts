import { parse, type ParserPlugin } from "@babel/parser";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const baselinePath = ".github/comment-baseline.json";
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.array(z.object({
	file: z.string().min(1),
	comments: z.array(z.object({ hash: hashSchema, count: z.number().int().positive() }).strict()).min(1),
}).strict());
type Baseline = z.infer<typeof baselineSchema>;

function git(...args: string[]): string {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
	});
}

function validate(text: string): Baseline {
	const rows = baselineSchema.parse(JSON.parse(text));
	let previous = "";
	for (const row of rows) {
		if (row.file <= previous || !/\.(?:ts|tsx)$/.test(row.file) || row.file.startsWith("/") || row.file.split("/").includes("..")) throw new Error("invalid or unordered baseline path");
		previous = row.file;
		let lastHash = "";
		for (const comment of row.comments) {
			if (comment.hash <= lastHash) throw new Error(`invalid or unordered hashes: ${row.file}`);
			lastHash = comment.hash;
		}
	}
	return rows;
}

function functional(text: string, source: string, start: number): boolean {
	const linePrefix = source.slice(Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1, start);
	if (/^\/\/\/\s*<reference\b/.test(text) || /^\/\/\s*@ts-/.test(text)) {
		if (linePrefix.trim()) return false;
	}
	if (/^\/\/\/\s*<reference\s+(?:path|types|lib)\s*=\s*["'][^"']+["']\s*\/?>\s*$/.test(text)) return true;
	const content = text.startsWith("//") ? text.slice(2).trim() : text.slice(2, -2).trim();
	if (/^(?:@ts-(?:ignore|expect-error|check|nocheck)\b|eslint-(?:disable|enable)(?:-next-line|-line)?\b|oxlint-(?:disable|enable)(?:-next-line|-line)?\b|biome-ignore(?:-all)?\b|prettier-ignore\b|istanbul ignore (?:next|file|if|else)\b|c8 ignore (?:next|start|stop|file)\b|#__PURE__\s*$|@__PURE__\s*$|@vite-ignore\s*$|webpack(?:ChunkName|Ignore|Mode|Prefetch|Preload)\s*:)/.test(content) && !/[\r\n]/.test(content)) return true;
	if (/^(?:SPDX-License-Identifier:\s*\S+|(?:Copyright|©)\s+(?:\(c\)\s*)?\d{4}(?:-\d{4})?\s+[^\r\n]+)$/i.test(content)) return true;
	if (text.startsWith("/**")) {
		const lines = text.slice(3, -2).split(/\r?\n/).map((line) => line.replace(/^\s*\*?\s?/, "").trim()).filter(Boolean);
		return lines.length > 0 && lines.every((line) => /^@(?:deprecated|internal)\b/.test(line));
	}
	return false;
}

function scan(commit?: string) {
	const paths = commit
		? git("ls-tree", "-r", "--name-only", "-z", "--full-tree", commit)
		: git("ls-files", "-z", "--cached", "--", "*.ts", "*.tsx");
	const files = paths.split("\0").filter((file) => /\.(?:ts|tsx)$/.test(file)).sort();
	const baseline: Baseline = [];
	const locations = new Map<string, number[]>();
	const rows = files.map((file) => {
		const source = commit ? git("cat-file", "blob", `${commit}:${file}`) : readFileSync(file, "utf8");
		const plugins: ParserPlugin[] = file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"];
		let ast;
		try { ast = parse(source, { sourceType: "unambiguous", plugins }); }
		catch (error) { throw new Error(`parse ${file}: ${String(error)}`); }
		const comments = ast.comments ?? [];
		const counts = new Map<string, number>();
		const removable = new Set<number>();
		const protectedLines = new Set<number>();
		const masked = source.split("");
		let prose = 0;
		for (const comment of comments) {
			const start = comment.start;
			const end = comment.end;
			const firstLine = comment.loc?.start.line;
			const lastLine = comment.loc?.end.line;
			if (start === undefined || end === undefined || firstLine === undefined || lastLine === undefined) {
				throw new Error(`missing comment location: ${file}`);
			}
			const text = source.slice(start, end);
			const exempt = functional(text, source, start);
			if (!exempt) {
				const hash = createHash("sha256").update(text).digest("hex");
				const key = `${file}\0${hash}`;
				const lines = locations.get(key) ?? [];
				lines.push(firstLine);
				locations.set(key, lines);
				counts.set(hash, lines.length);
				prose++;
			}
			for (let i = start; i < end; i++) if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
			const lineSet = exempt ? protectedLines : removable;
			for (let line = firstLine; line <= lastLine; line++) lineSet.add(line);
		}
		if (counts.size) {
			const comments = [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
				.map(([hash, count]) => ({ hash, count }));
			baseline.push({ file, comments });
		}
		const lines = masked.join("").split(/\r\n|\n|\r/);
		for (const line of removable) if (protectedLines.has(line) || lines[line - 1]?.trim()) removable.delete(line);
		const total = source === "" || /[\r\n]$/.test(source) ? lines.length - 1 : lines.length;
		return { file, comments: prose, removable: removable.size, total };
	});
	return { baseline, rows, locations };
}

function lookup(rows: Baseline): Map<string, number> {
	return new Map(rows.flatMap((row) => row.comments.map(({ hash, count }) => [`${row.file}\0${hash}`, count] as const)));
}

function compare(actual: Baseline, allowed: Baseline, locations?: ReadonlyMap<string, number[]>): void {
	const a = lookup(actual);
	const b = lookup(allowed);
	for (const [key, actualCount] of a) {
		const allowedCount = b.get(key) ?? 0;
		if (actualCount <= allowedCount) continue;
		const file = key.slice(0, key.indexOf("\0"));
		const line = locations?.get(key)?.[allowedCount];
		if (line !== undefined) throw new Error(`${file}:${line}: new or changed prose comment; remove it`);
		throw new Error(`${file}: comment baseline grew; remove the new allowance`);
	}
	if (!locations) return;
	for (const [key, allowedCount] of b) {
		if ((a.get(key) ?? 0) !== allowedCount) {
			const file = key.slice(0, key.indexOf("\0"));
			throw new Error(`${file}: unused comment allowance; run --prune`);
		}
	}
}

function readBaseline(): Baseline { return validate(readFileSync(baselinePath, "utf8")); }
function writeBaseline(rows: Baseline, flag: "wx" | "w"): void {
	mkdirSync(dirname(baselinePath), { recursive: true });
	writeFileSync(baselinePath, `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`, { flag });
}

function main(): void {
	const args = process.argv.slice(2);
	let mode = "--check";
	let base: string | undefined;
	let modeSet = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--base" && base === undefined && args[i + 1] && !args[i + 1]?.startsWith("-")) base = args[++i];
		else if ((arg === "--report" || arg === "--init" || arg === "--prune" || arg === "--check") && !modeSet) { mode = arg; modeSet = true; }
		else throw new Error(`invalid argument: ${arg}`);
	}
	if (base && mode !== "--check") throw new Error("--base requires --check");
	const result = scan();
	if (mode === "--report") {
		for (const row of result.rows) if (row.comments) process.stdout.write(`${row.file}: ${row.comments} comments, ${row.removable} removable lines / ${row.total} lines\n`);
		process.stdout.write(`total: ${result.rows.reduce((n, row) => n + row.comments, 0)} comments, ${result.rows.reduce((n, row) => n + row.removable, 0)} removable lines / ${result.rows.reduce((n, row) => n + row.total, 0)} lines\n`);
	} else if (mode === "--init") writeBaseline(result.baseline, "wx");
	else {
		const current = readBaseline();
		if (mode === "--prune") {
			const allowed = lookup(current);
			const pruned = result.baseline.map((row) => ({ file: row.file, comments: row.comments.flatMap((comment) => {
				const count = Math.min(comment.count, allowed.get(`${row.file}\0${comment.hash}`) ?? 0);
				return count ? [{ hash: comment.hash, count }] : [];
			}) })).filter((row) => row.comments.length);
			writeBaseline(pruned, "w");
		} else {
			compare(result.baseline, current, result.locations);
			if (base) {
				const commit = git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`).trim();
				git("merge-base", "--is-ancestor", commit, "HEAD");
				const head = validate(git("show", `HEAD:${baselinePath}`));
				const exists = git("ls-tree", "--name-only", commit, "--", baselinePath).trim();
				const prior = exists ? validate(git("show", `${commit}:${baselinePath}`)) : scan(commit).baseline;
				compare(head, prior);
				compare(current, prior);
			}
		}
	}
}

try { main(); } catch (error) { process.stderr.write(`comment-audit: ${String(error)}\n`); process.exitCode = 1; }
