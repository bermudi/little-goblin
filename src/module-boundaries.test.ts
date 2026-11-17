//  1. grammy — only src/tg knows it; checked statically because a
//     type-only import leaks invisibly.
//  2. The Pi Durable stack (pi-durable/pi-ai/chord/pi-schema) is gone
//     with issue #609 — no import of it may come back. Deliberately not
//     pi-codemode: the script tool's QuickJS VM is a live dependency.
//  3. src/http/mod.ts stays runtime-free — naming ../runtime.ts ties the
//     server to the harness, so every import form counts.
//  4. No non-test sibling imports its own dir's mod.ts; `import type`
//     is the sanctioned cycle-breaker.
//  5. Message shapes come from goblin, not AI SDK packages; block named
//     imports/re-exports, namespace imports, star exports, and inline types.
//  6. Escapes and node_modules paths hide what a specifier resolves to.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = import.meta.dir;
const ROOT = resolve(SRC, "..");

const GRAMMY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']grammy(?:\/[^"']*)?["']/;
const PI_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*)["']@earendil-works\/(?:pi-durable|pi-ai|chord|pi-schema)(?:\/[^"']*)?["']/;
const CLAUDE_SDK_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*)["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']/;
const RUNTIME_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']\.\.\/runtime\.ts["']/;
const SIBLING_MOD_IMPORT =
	/(?:\bimport\b|\bexport\b)(?!\s*type\b)[^;]*from\s*["']\.\/mod\.ts["']|\bimport\s*\(\s*["']\.\/mod\.ts["']\s*\)/;

// Every import form that carries a specifier: `from "…"` (static
// import/export, `import type` included), dynamic `import("…")` —
// quoted or backticked, without `${` interpolation, leading /* … */
// comments allowed — and bare side-effect `import "…"`.
const FROM_SPEC = /\bfrom\s*["']([^"']+)["']/g;
const DYNAMIC_SPEC =
	/\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*["'`]([^"'`$]+)["'`]\s*\)/g;
const BARE_SPEC = /\bimport\s*["']([^"']+)["']/g;
const AI_SDK_MESSAGE_SHAPE_NAMES =
	"(?:UIMessage|UIMessageChunk|UIMessagePart|ToolUIPart|DynamicToolUIPart|LanguageModelUsage|FinishReason|ProviderMetadata)";
const AI_SDK_FENCED_SPECIFIER = "(?:ai(?:/[^'\"]*)?|@ai-sdk/[^'\"]+)";
const AI_SDK_SEPARATOR = "(?:\\s|/\\*[\\s\\S]*?\\*/)*";
const AI_SDK_NAMED_SHAPE_IMPORT_EXPORT = new RegExp(
	"(?:^|;)" +
		AI_SDK_SEPARATOR +
		"\\b(?:import|export)\\b" +
		AI_SDK_SEPARATOR +
		"(?:\\btype\\b" +
		AI_SDK_SEPARATOR +
		")?\\{[^}]*\\b" +
		AI_SDK_MESSAGE_SHAPE_NAMES +
		"\\b[^}]*\\}" +
		AI_SDK_SEPARATOR +
		"\\bfrom\\b" +
		AI_SDK_SEPARATOR +
		"['\"]" +
		AI_SDK_FENCED_SPECIFIER +
		"['\"]",
	"ms",
);
const AI_SDK_NAMESPACE_IMPORT = new RegExp(
	"(?:^|;)" +
		AI_SDK_SEPARATOR +
		"\\bimport\\b" +
		AI_SDK_SEPARATOR +
		"(?:\\btype\\b" +
		AI_SDK_SEPARATOR +
		")?\\*" +
		AI_SDK_SEPARATOR +
		"\\bas\\b" +
		AI_SDK_SEPARATOR +
		"[A-Za-z_$][\\w$]*" +
		AI_SDK_SEPARATOR +
		"\\bfrom\\b" +
		AI_SDK_SEPARATOR +
		"['\"]" +
		AI_SDK_FENCED_SPECIFIER +
		"['\"]",
	"m",
);
const AI_SDK_STAR_EXPORT = new RegExp(
	"(?:^|;)" +
		AI_SDK_SEPARATOR +
		"\\bexport\\b" +
		AI_SDK_SEPARATOR +
		"\\*" +
		AI_SDK_SEPARATOR +
		"(?:\\bas\\b" +
		AI_SDK_SEPARATOR +
		"[A-Za-z_$][\\w$]*" +
		AI_SDK_SEPARATOR +
		")?\\bfrom\\b" +
		AI_SDK_SEPARATOR +
		"['\"]" +
		AI_SDK_FENCED_SPECIFIER +
		"['\"]",
	"m",
);
const AI_SDK_INLINE_MESSAGE_TYPE = new RegExp(
	"\\bimport\\b" +
		AI_SDK_SEPARATOR +
		"\\(" +
		AI_SDK_SEPARATOR +
		"['\"]" +
		AI_SDK_FENCED_SPECIFIER +
		"['\"]" +
		AI_SDK_SEPARATOR +
		"\\)" +
		AI_SDK_SEPARATOR +
		"(?:\\." +
		AI_SDK_SEPARATOR +
		AI_SDK_MESSAGE_SHAPE_NAMES +
		"\\b|\\[" +
		AI_SDK_SEPARATOR +
		"['\"]" +
		AI_SDK_MESSAGE_SHAPE_NAMES +
		"['\"]" +
		AI_SDK_SEPARATOR +
		"\\])",
);
const AI_SDK_MESSAGE_SHAPE_ALLOWLIST = new Set(["src/message.test.ts"]);
const AI_SDK_SCAN_ROOTS = [
	SRC,
	join(ROOT, "scripts"),
	join(ROOT, "experimental"),
];

function specifiers(source: string): string[] {
	return [FROM_SPEC, DYNAMIC_SPEC, BARE_SPEC].flatMap((re) =>
		[...source.matchAll(re)].map((m) => m[1]!),
	);
}

// testkit's fake-api.ts builds the Api stub — not production code.
const GRAMMY_EXEMPT_DIRS = new Set(["tg", "testkit"]);

// The claude engine's vendor boundary: the SDK (and its bundled CLI
// surface) is known only inside src/agent/claude-code/.
const CLAUDE_SDK_DIR = "agent/claude-code";

// The feature folders (DESIGN.md → Module map, ruling 2026-11-08,
// #201): each folder's index.ts is its only public import.
const FEATURE_FOLDERS = new Set(["reminders"]);

// The trees the feature-folder rule scans: the server, the app client,
// and the repo scripts — the roots import-cycles walks, plus scripts/.
const FEATURE_SCAN_ROOTS = [
	SRC,
	join(ROOT, "app", "src"),
	join(ROOT, "scripts"),
];

// Test-only edges: shared rigs that build the family's real entry to
// fake at it.
const SIBLING_EXEMPT = new Set(["http/app-testing.ts"]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
	}
	return out;
}

function rel(file: string): string {
	return file.slice(SRC.length + 1);
}

// src files report relative to src/ like every other rule here; files
// from the other scan roots report repo-root-relative paths.
function label(file: string): string {
	return file.startsWith(SRC) ? rel(file) : file.slice(ROOT.length + 1);
}

function repoPath(file: string): string {
	return relative(ROOT, file);
}

// The t3 CLI wire is one adapter's contract: spawning the CLI (or
// pinning its argv) outside src/t3.ts means a second wire owner.
const T3_SPAWN = /(?:spawnProc|Bun\.spawn|execSync|exec)\((?:[^)]*["'])t3["']/;

describe("module boundaries", () => {
	test("the t3 CLI is spawned only by src/t3.ts", () => {
		const offenders = walk(ROOT)
			// Dependency trees and tool caches are not goblin's code.
			.filter((file) => !file.split(sep).includes("node_modules"))
			.map(repoPath)
			// The scan covers app/ and scripts/ too — one wire owner means
			// one everywhere. The live drift check owns its own probes.
			.filter((name) => name !== "src/t3.ts" && name !== "src/t3.live.test.ts")
			.filter((name) => !name.endsWith(".test.ts"))
			.filter((name) => T3_SPAWN.test(readFileSync(join(ROOT, name), "utf8")));
		expect(offenders).toEqual([]);
	});

	test("grammy is imported only under src/tg", () => {
		const offenders = walk(SRC)
			.filter(
				(file) =>
					!rel(file)
						.split("/")
						.some((part) => GRAMMY_EXEMPT_DIRS.has(part)),
			)
			.filter((file) => !file.endsWith(".test.ts"))
			.filter((file) => GRAMMY_IMPORT.test(readFileSync(file, "utf8")))
			.map(rel);
		expect(offenders).toEqual([]);
	});

	test("the Pi Durable stack is never imported", () => {
		const offenders = AI_SDK_SCAN_ROOTS.filter(existsSync)
			.flatMap((root) => walk(root))
			// This file carries the patterns; it names no package as an import.
			.filter((file) => repoPath(file) !== "src/module-boundaries.test.ts")
			.filter((file) => PI_IMPORT.test(readFileSync(file, "utf8")))
			.map(repoPath);
		expect(offenders).toEqual([]);
	});

	test("claude-agent-sdk is imported only under src/agent/claude-code", () => {
		const offenders = walk(SRC)
			// The engine dir is the sanctioned home; its tests fake the
			// vendor at the edge like every other boundary adapter.
			.filter((file) => !rel(file).split("/").includes("claude-code"))
			// This file carries the pattern; it names no package as an import.
			.filter((file) => rel(file) !== "module-boundaries.test.ts")
			.filter((file) => CLAUDE_SDK_IMPORT.test(readFileSync(file, "utf8")))
			.map(rel);
		expect(offenders).toEqual([]);
	});

	test("http/mod.ts stays runtime-free", () => {
		const source = readFileSync(join(SRC, "http", "mod.ts"), "utf8");
		expect(RUNTIME_IMPORT.test(source)).toBe(false);
	});

	test("message shapes are not imported, re-exported, or referenced from AI SDK packages", () => {
		const offenders = AI_SDK_SCAN_ROOTS
			.filter(existsSync)
			.flatMap((root) => walk(root))
			.filter((file) => !AI_SDK_MESSAGE_SHAPE_ALLOWLIST.has(repoPath(file)))
			.filter((file) => {
				const source = readFileSync(file, "utf8");
				return (
					AI_SDK_NAMED_SHAPE_IMPORT_EXPORT.test(source) ||
					AI_SDK_NAMESPACE_IMPORT.test(source) ||
					AI_SDK_STAR_EXPORT.test(source) ||
					AI_SDK_INLINE_MESSAGE_TYPE.test(source)
				);
			})
			.map(repoPath);
		expect(offenders).toEqual([]);
	});

	test("import specifiers are plain package or path names", () => {
		const offenders = AI_SDK_SCAN_ROOTS
			.filter(existsSync)
			.flatMap((root) => walk(root))
			.flatMap((file) =>
				specifiers(readFileSync(file, "utf8"))
					.filter(
						(specifier) =>
							specifier.includes("node_modules") || specifier.includes("\\"),
					)
					.map((specifier) => `${repoPath(file)} -> ${specifier}`),
			);
		expect(offenders).toEqual([]);
	});

	test("no non-test sibling imports its own directory's mod.ts", () => {
		const offenders: string[] = [];
		for (const mod of walk(SRC).filter((file) => file.endsWith("/mod.ts"))) {
			const dir = mod.slice(0, -"/mod.ts".length);
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
				if (entry.name === "mod.ts" || entry.name.endsWith(".test.ts")) continue;
				const file = join(dir, entry.name);
				if (SIBLING_EXEMPT.has(rel(file))) continue;
				if (SIBLING_MOD_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(rel(file));
			}
		}
		expect(offenders).toEqual([]);
	});

	test("feature folders are imported only through their index.ts", () => {
		const offenders: string[] = [];
		for (const file of FEATURE_SCAN_ROOTS.flatMap((root) => walk(root))) {
			// Inside the feature folder itself — its own modules and tests.
			if (file.startsWith(SRC) && FEATURE_FOLDERS.has(rel(file).split("/")[0]!))
				continue;
			for (const spec of specifiers(readFileSync(file, "utf8"))) {
				if (!spec.startsWith(".")) continue;
				const resolved = resolve(dirname(file), spec);
				for (const feature of FEATURE_FOLDERS) {
					const within = relative(join(SRC, feature), resolved);
					// Outside the feature, the folder itself (which resolves to
					// its index), or any spelling of the public index — allowed.
					if (
						within.startsWith("..") ||
						within === "" ||
						/^index(\.ts|\.js)?$/.test(within)
					)
						continue;
					offenders.push(`${label(file)} -> ${spec}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
