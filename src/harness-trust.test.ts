// Trust seeding is the difference between a delegation that runs and
// one parked on a first-run dialog — these guard the two recipes
// (claude's .claude.json flags, codex's config.toml trust_level) and
// the only-ever-set rule against the operator's own files.

import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedHarnessTrust } from "./harness-trust.ts";

let dirs: string[] = [];
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-trust-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("claude", () => {
	test("creates .claude.json with the bypass flag and per-cwd trust", () => {
		const h = home();
		seedHarnessTrust("claude", "/work/task", h);
		const doc = JSON.parse(readFileSync(join(h, ".claude.json"), "utf8"));
		expect(doc.bypassPermissionsModeAccepted).toBe(true);
		expect(doc.hasCompletedOnboarding).toBe(true);
		expect(doc.projects["/work/task"].hasTrustDialogAccepted).toBe(true);
		expect(doc.projects["/work/task"].hasCompletedProjectOnboarding).toBe(true);
		// New files are born 0600 — the file can carry machine identity.
		expect(statSync(join(h, ".claude.json")).mode & 0o777).toBe(0o600);
	});

	test("preserves existing keys, other projects, and file mode", () => {
		const h = home();
		const path = join(h, ".claude.json");
		writeFileSync(path, JSON.stringify({
			machineID: "m",
			projects: { "/other": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
		}));
		chmodSync(path, 0o444);
		seedHarnessTrust("claude", "/work/task", h);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.machineID).toBe("m");
		expect(doc.projects["/other"].allowedTools).toEqual(["Bash"]);
		expect(doc.projects["/work/task"].hasTrustDialogAccepted).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o444);
	});

	test("a non-object .claude.json fails loud, not a clobber", () => {
		const h = home();
		writeFileSync(join(h, ".claude.json"), "[1,2]");
		expect(() => seedHarnessTrust("claude", "/w", h)).toThrow("not a JSON object");
	});

	test("an explicit false is the operator's recorded answer — seeding never flips it", () => {
		const h = home();
		const path = join(h, ".claude.json");
		writeFileSync(path, JSON.stringify({
			bypassPermissionsModeAccepted: false,
			hasCompletedOnboarding: false,
			projects: { "/work/task": { hasTrustDialogAccepted: false } },
		}));
		seedHarnessTrust("claude", "/work/task", h);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		expect(doc.bypassPermissionsModeAccepted).toBe(false);
		expect(doc.hasCompletedOnboarding).toBe(false);
		// the project's explicit distrust stands…
		expect(doc.projects["/work/task"].hasTrustDialogAccepted).toBe(false);
		// …while keys it never answered still seed
		expect(doc.projects["/work/task"].hasCompletedProjectOnboarding).toBe(true);
	});

	test("a symlinked .claude.json writes through to the managed target", () => {
		const h = home();
		const target = join(h, "dots", "claude.json");
		mkdirSync(join(h, "dots"), { recursive: true });
		writeFileSync(target, JSON.stringify({ machineID: "m" }));
		const link = join(h, ".claude.json");
		symlinkSync(target, link);
		seedHarnessTrust("claude", "/work/task", h);
		// the link is still a link, and the write landed on the target
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		const doc = JSON.parse(readFileSync(target, "utf8"));
		expect(doc.machineID).toBe("m");
		expect(doc.bypassPermissionsModeAccepted).toBe(true);
	});
});

describe("codex", () => {
	// The write must be *semantically* right — a still-valid TOML file
	// whose projects.<cwd>.trust_level reads "trusted" — and the
	// operator's bytes must survive verbatim: the seeded file starts
	// with the original text and adds exactly one line.
	const codexTrust = (dir: string, cwd: string): unknown => {
		const projects = (Bun.TOML.parse(
			readFileSync(join(dir, ".codex", "config.toml"), "utf8"),
		) as { projects: Record<string, { trust_level?: string }> }).projects;
		return projects[cwd]?.trust_level;
	};

	test("creates config.toml with the cwd trusted", () => {
		const h = home();
		seedHarnessTrust("codex", "/work/task", h);
		expect(codexTrust(h, "/work/task")).toBe("trusted");
	});

	test("appends one line without disturbing existing content", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		const original = '# hand-maintained\n[projects."/keep"]\ntrust_level = "trusted"\n';
		writeFileSync(path, original);
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(path, "utf8");
		expect(text.startsWith(original)).toBe(true);
		expect(codexTrust(h, "/work/task")).toBe("trusted");
		expect(codexTrust(h, "/keep")).toBe("trusted");
	});

	test("trust_level lands on a table that lacks it — whatever its form", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		// Section-defined table with other keys, single-quoted keys,
		// comments and whitespace — the shapes sed-style edits used to
		// mangle.
		const original =
			'[projects."/work/task"]\nother = 1\n\n' +
			"[projects.'/b'] # literal-quote form\ntrust_level = 'trusted'\n";
		writeFileSync(path, original);
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(path, "utf8");
		// Exactly one line inserted, right inside the existing section —
		// everything else byte-identical.
		expect(text).toBe(
			original.replace(
				'[projects."/work/task"]\n',
				'[projects."/work/task"]\ntrust_level = "trusted"\n',
			),
		);
		expect(codexTrust(h, "/work/task")).toBe("trusted");
		expect(codexTrust(h, "/b")).toBe("trusted");
	});

	test("projects declared by dotted keys extends the same way", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		const original = 'projects."/a".trust_level = "untrusted"\nmodel = "gpt-5"\n';
		writeFileSync(path, original);
		seedHarnessTrust("codex", "/work/task", h);
		expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
		expect(codexTrust(h, "/work/task")).toBe("trusted");
		expect(codexTrust(h, "/a")).toBe("untrusted");
	});

	test("an inline-table projects cannot be extended — loud refusal, file untouched", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		const original = 'projects = {"/a" = {trust_level = "untrusted"}}\n';
		writeFileSync(path, original);
		expect(() => seedHarnessTrust("codex", "/work/task", h)).toThrow("inline table");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	test("corrupt TOML fails the seed before any write", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		const original = '[projects."/a"\ntrust_level = \n';
		writeFileSync(path, original);
		expect(() => seedHarnessTrust("codex", "/work/task", h)).toThrow("invalid TOML");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	test("a cwd with control characters still writes valid TOML", () => {
		const h = home();
		// Tab, newline, and a char with no shorthand escape — all legal
		// in directory names, all invalid bare inside a TOML basic key.
		const cwd = "/we\tr\ndi\x01r";
		seedHarnessTrust("codex", cwd, h);
		expect(codexTrust(h, cwd)).toBe("trusted");
		// The escaped key round-trips: a second seed finds the entry and
		// is a no-op.
		expect(seedHarnessTrust("codex", cwd, h)).toEqual([]);
	});

	test("an explicit trust_level stands — the operator's call wins", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		writeFileSync(path, '[projects."/work/task"]\ntrust_level = "untrusted"\n');
		expect(seedHarnessTrust("codex", "/work/task", h)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe('[projects."/work/task"]\ntrust_level = "untrusted"\n');
	});

	test("a symlinked config.toml writes through to the managed target", () => {
		const h = home();
		const target = join(h, "dots", "codex.toml");
		mkdirSync(join(h, "dots"), { recursive: true });
		const original = 'model = "gpt-5"\n';
		writeFileSync(target, original);
		mkdirSync(join(h, ".codex"), { recursive: true });
		const link = join(h, ".codex", "config.toml");
		symlinkSync(target, link);
		seedHarnessTrust("codex", "/work/task", h);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8").startsWith(original)).toBe(true);
		expect(codexTrust(h, "/work/task")).toBe("trusted");
	});
});

test("unknown kinds seed nothing and write nothing", () => {
	const h = home();
	expect(seedHarnessTrust("pi", "/w", h)).toEqual([]);
	expect(existsSync(join(h, ".claude.json"))).toBe(false);
	expect(existsSync(join(h, ".codex"))).toBe(false);
});
