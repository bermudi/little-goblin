// Function-size report (REFACTOR-PLAN-2.md → P0) — a signal, not a
// gate: exits 0 even when functions flag. Span = the function-like
// node's loc.start.line..loc.end.line; nested functions count their
// container's span too, so the god-function and its closures both
// surface. Scope = src/ + app/src/ minus test files, same as
// comment-audit.ts. Parse failures print at the top — never silent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";

const BOUND = 300;
const ROOTS = ["src", "app/src"];

interface Flag {
	file: string;
	line: number;
	name: string;
	span: number;
}

function productFiles(dir: string, out: string[]): void {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, ent.name);
		if (ent.isDirectory()) productFiles(path, out);
		else if (/\.(?:ts|tsx|js)$/.test(ent.name) && !/\.test\.[jt]sx?$/.test(ent.name))
			out.push(path);
	}
}

type Node = Record<string, unknown> & {
	type: string;
	loc?: { start: { line: number }; end: { line: number } } | null;
};

function propName(key: unknown): string | undefined {
	const k = key as Node | undefined;
	if (k === undefined) return undefined;
	if (k.type === "Identifier") return k.name as string;
	if (k.type === "StringLiteral" || k.type === "NumericLiteral")
		return String(k.value);
	if (k.type === "PrivateName") return `#${propName(k.id)}`;
	return undefined;
}

const FUNCTION_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
]);

function nameFor(node: Node, parent: Node | undefined): string {
	const n = node as { id?: Node; key?: Node; kind?: string };
	if (n.id !== undefined && n.id !== null) {
		const name = propName(n.id);
		if (name !== undefined) return name;
	}
	if (n.key !== undefined && n.key !== null) {
		if (n.kind === "constructor") return "<ctor>";
		const name = propName(n.key);
		if (name !== undefined) return name;
	}
	if (parent !== undefined) {
		const p = parent as Node & {
			id?: Node;
			key?: Node;
			left?: Node;
			callee?: Node;
		};
		if (p.type === "VariableDeclarator") {
			const name = propName(p.id);
			if (name !== undefined) return name;
		}
		if (p.type === "ObjectProperty" || p.type === "ClassProperty") {
			const name = propName(p.key);
			if (name !== undefined) return name;
		}
		if (p.type === "AssignmentExpression") {
			const name = propName(p.left);
			if (name !== undefined) return name;
		}
	}
	return "<anonymous>";
}

function walk(node: Node, parent: Node | undefined, file: string, out: Flag[]): void {
	if (FUNCTION_TYPES.has(node.type)) {
		const loc = node.loc;
		if (loc !== undefined && loc !== null) {
			const span = loc.end.line - loc.start.line + 1;
			if (span >= BOUND)
				out.push({ file, line: loc.start.line, name: nameFor(node, parent), span });
		}
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== null && typeof item === "object" && "type" in (item as Node))
					walk(item as Node, node, file, out);
			}
		} else if (value !== null && typeof value === "object" && "type" in (value as Node)) {
			walk(value as Node, node, file, out);
		}
	}
}

const files: string[] = [];
for (const dir of ROOTS) productFiles(dir, files);
files.sort();

const flags: Flag[] = [];
const failures: string[] = [];
for (const file of files) {
	const source = readFileSync(file, "utf8");
	const plugins: ParserPlugin[] = /\.[jt]sx$/.test(file)
		? ["typescript", "jsx"]
		: ["typescript"];
	try {
		const ast = parse(source, { sourceType: "module", plugins });
		for (const stmt of ast.program.body)
			walk(stmt as unknown as Node, undefined, file, flags);
	} catch (err) {
		failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

flags.sort((a, b) => b.span - a.span);

if (failures.length > 0) {
	console.log("parse failures:");
	for (const f of failures) console.log(`  ${f}`);
	console.log("");
}
if (flags.length === 0) {
	console.log(`no functions over ${BOUND} lines in ${files.length} files`);
} else {
	console.log(`${flags.length} function(s) over ${BOUND} lines:`);
	for (const f of flags)
		console.log(`  ${f.file}:${f.line} ${f.name} — ${f.span} lines`);
}
