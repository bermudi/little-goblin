// The cycle guard: import cycles in src/ and app/src/ are frozen at the
// list below. A cycle passes only when its members all sit inside ONE
// frozen cluster. A cycle that grew past a cluster, spans two clusters,
// or has no cluster fails the test. A cluster that shrank or vanished
// passes, but a fully empty one warns on stderr — an unpruned cluster
// would let its old tangle return silently. Prune by hand; print the
// live clusters to copy from with:
//   GOBLIN_PRINT_CYCLES=1 bun test src/import-cycles.test.ts
// Every import form counts as an edge (value, `import type`, re-export,
// dynamic import): a type-only cycle tangles the tree just the same.
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

// Today's cycles, frozen as clusters. Detection is containment, not
// exact signatures: edits inside a cluster (a member's imports changing)
// must not turn this test red, only growth or a new cycle may.
// The two clusters the untangle campaign (#201) is shrinking: the
// runtime↔turn cluster and the conversation-store cluster.
const ALLOWED_CYCLES: readonly string[][] = [
	// The engine fork's type-level shape: TurnEngine names ClaudeStep,
	// the claude engine implements TurnEngine. Runtime and the turn
	// seams left this cluster in #201 stage 2.
	["src/agent/claude-code/engine.ts", "src/agent/claude-code/mod.ts", "src/turn/engine.ts"],
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
		"src/conversation-read.ts",
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

// Containment: a cycle passes only when every member already sits inside
// one single frozen cluster. Shrunk clusters are fine (prune by hand);
// growth or anything new is not.
function fitsAllowedCluster(members: readonly string[], allowed: readonly string[][]): boolean {
	return allowed.some((cluster) => members.every((m) => cluster.includes(m)));
}

// A cluster with no cycle left inside it guards nothing anymore — its only
// remaining effect is letting that tangle return silently. Warn, don't
// fail: pruning is a hand edit in the same spirit as the shrink itself.
function staleClusters(cycles: readonly string[][], allowed: readonly string[][]): string[][] {
	return allowed.filter((cluster) => !cycles.some((members) => fitsAllowedCluster(members, [cluster])));
}

describe("import cycles", () => {
	test("no import cycle exists outside the frozen clusters", () => {
		const cycles = stronglyConnected(buildGraph())
			.map((members) => [...members].sort())
			.sort((a, b) => a.join().localeCompare(b.join()));
		if (process.env.GOBLIN_PRINT_CYCLES === "1") {
			const signatures = cycles.map((members) => JSON.stringify(members));
			process.stderr.write(`cycle signatures:\n${signatures.join("\n")}\n`);
		}
		const offenders = cycles.filter((members) => !fitsAllowedCluster(members, ALLOWED_CYCLES));
		if (offenders.length > 0) {
			throw new Error(
				`import cycles grew or appeared — untangle them first; only the operator may freeze a new tangle in ALLOWED_CYCLES:\n${offenders
					.map((members) => JSON.stringify(members))
					.join("\n")}`,
			);
		}
		expect(offenders).toEqual([]);
		const stale = staleClusters(cycles, ALLOWED_CYCLES);
		if (stale.length > 0) {
			process.stderr.write(
				`prune ALLOWED_CYCLES — these clusters have no cycle left inside them, so a re-tangle of their members would pass silently:\n${stale
					.map((cluster) => JSON.stringify([...cluster].sort()))
					.join("\n")}\n`,
			);
		}
	});

	test("containment judges clusters, not signatures", () => {
		const allowed = [
			["a.ts", "b.ts", "c.ts"],
			["x.ts", "y.ts"],
		];
		// A cluster that matches, shrank, or split passes.
		expect(fitsAllowedCluster(["a.ts", "b.ts", "c.ts"], allowed)).toBe(true);
		expect(fitsAllowedCluster(["a.ts", "b.ts"], allowed)).toBe(true);
		expect(fitsAllowedCluster(["x.ts"], allowed)).toBe(true);
		// Growth past one cluster fails, spanning two fails, brand new fails.
		expect(fitsAllowedCluster(["a.ts", "b.ts", "c.ts", "d.ts"], allowed)).toBe(false);
		expect(fitsAllowedCluster(["a.ts", "x.ts"], allowed)).toBe(false);
		expect(fitsAllowedCluster(["q.ts", "r.ts"], allowed)).toBe(false);
		// Stale = no detected cycle sits fully inside the cluster anymore.
		expect(staleClusters([["a.ts", "b.ts"], ["x.ts", "y.ts"]], allowed)).toEqual([]);
		expect(staleClusters([["a.ts", "b.ts"]], allowed)).toEqual([["x.ts", "y.ts"]]);
		expect(staleClusters([["a.ts", "x.ts"]], allowed)).toEqual(allowed);
	});
});
