// The cycle guard: import cycles in src/ and app/src/ are frozen at the
// list below. Any NEW cycle fails this test; a FIXED cycle also fails so
// the list stays honest — the failure tells you which side moved.
// Every import form counts as an edge (value, `import type`, re-export,
// dynamic import): a type-only cycle tangles the tree just the same.
// Print the current signature list with:
//   GOBLIN_PRINT_CYCLES=1 bun test src/import-cycles.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// Relative imports only — package imports cannot cycle inside the repo.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.[^"']+)\1/g;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		// Test files are not part of the dependency graph: production code
		// never imports them, so they cannot close a cycle.
		else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
	}
	return out;
}

const FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app", "src"))];
const NODES = new Set(FILES.map((f) => f.slice(ROOT.length + 1)));

function resolveSpec(from: string, spec: string): string | null {
	const base = resolve(dirname(from), spec).slice(ROOT.length + 1);
	for (const candidate of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}/index.ts`,
		`${base}/index.tsx`,
	]) {
		if (NODES.has(candidate)) return candidate;
	}
	// Assets and json imports are not modules of the graph.
	return null;
}

function buildGraph(): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const file of FILES) {
		const rel = file.slice(ROOT.length + 1);
		const source = readFileSync(file, "utf8");
		const edges = new Set<string>();
		for (const match of source.matchAll(IMPORT_RE)) {
			const to = resolveSpec(file, match[2]!);
			if (to !== null) edges.add(to);
		}
		graph.set(rel, [...edges]);
	}
	return graph;
}

// Tarjan strongly-connected components; a cycle is an SCC of more than one
// node, or a node importing itself.
function stronglyConnected(graph: Map<string, string[]>): string[][] {
	let index = 0;
	const indices = new Map<string, number>();
	const lowlink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const out: string[][] = [];

	const visit = (node: string): void => {
		indices.set(node, index);
		lowlink.set(node, index);
		index += 1;
		stack.push(node);
		onStack.add(node);
		for (const next of graph.get(node) ?? []) {
			if (!indices.has(next)) {
				visit(next);
				lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
			} else if (onStack.has(next)) {
				lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(next)!));
			}
		}
		if (lowlink.get(node) === indices.get(node)) {
			const component: string[] = [];
			for (;;) {
				const popped = stack.pop()!;
				onStack.delete(popped);
				component.push(popped);
				if (popped === node) break;
			}
			if (component.length > 1 || graph.get(node)?.includes(node)) out.push(component);
		}
	};

	for (const node of graph.keys()) if (!indices.has(node)) visit(node);
	return out;
}

// Today's cycles, frozen. A cycle signature is its member set — a new
// module joining an existing cycle is a new signature, not the old one.
// The two clusters the untangle campaign (#201) is shrinking: the
// runtime↔turn cluster and the conversation-store cluster.
const ALLOWED_CYCLES: readonly string[][] = [
	[
		"src/agent/claude-code/engine.ts",
		"src/agent/claude-code/mod.ts",
		"src/runtime.ts",
		"src/turn/compact-job.ts",
		"src/turn/engine.ts",
		"src/turn/run-record.ts",
	],
	["src/agent/codex/models.ts", "src/agent/models-dev.ts"],
	[
		"src/agent/onemin-speech.ts",
		"src/agent/transcribe-cloud.ts",
		"src/agent/transcribe-whistle.ts",
		"src/agent/transcribe.ts",
		"src/agent/tts-cloud.ts",
		"src/agent/tts.ts",
	],
	[
		"src/agent/prompt.ts",
		"src/conversation-history.ts",
		"src/conversation-schema.ts",
		"src/conversation.ts",
		"src/memory/mod.ts",
		"src/notes.ts",
		"src/program-proposals.ts",
		"src/programs.ts",
		"src/projects.ts",
		"src/responsibilities.ts",
		"src/responsibility-followup.ts",
		"src/responsibility-stage.ts",
		"src/targets.ts",
		"src/turn/itemize.ts",
		"src/window-capture.ts",
	],
	["src/agent/tools/delegate.ts", "src/delegation-lifecycle.ts"],
	["src/agent/tools/vision.ts", "src/agent/vision.ts"],
	["src/http/app-responsibilities.ts", "src/http/app-shared.ts"],
	["src/mail-gws.ts", "src/mail.ts"],
	["src/turn/overflow.ts", "src/turn/stream.ts"],
	["src/sandbox-lifecycle.ts", "src/sandboxes.ts"],
];

describe("import cycles", () => {
	test("no import cycle exists outside the frozen allowlist", () => {
		const cycles = stronglyConnected(buildGraph())
			.map((members) => [...members].sort())
			.sort((a, b) => a.join().localeCompare(b.join()));
		const signatures = cycles.map((members) => JSON.stringify(members));
		if (process.env.GOBLIN_PRINT_CYCLES === "1") {
			process.stderr.write(`cycle signatures:\n${signatures.join("\n")}\n`);
		}
		const allowed = new Set(ALLOWED_CYCLES.map((members) => JSON.stringify([...members].sort())));
		const added = signatures.filter((s) => !allowed.has(s));
		const removed = [...allowed].filter((s) => !signatures.includes(s));
		if (added.length > 0) {
			throw new Error(
				`new import cycles — untangle them, or (only if the operator accepts the tangle) add to ALLOWED_CYCLES:\n${added.join("\n")}`,
			);
		}
		if (removed.length > 0) {
			throw new Error(
				`cycles fixed or changed since the allowlist was frozen — prune ALLOWED_CYCLES:\n${removed.join("\n")}`,
			);
		}
		expect(added).toEqual([]);
		expect(removed).toEqual([]);
	});
});
