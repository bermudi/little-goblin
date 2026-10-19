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
		writeFileSync(
			path,
			JSON.stringify({
				machineID: "m",
				projects: { "/other": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
			}),
		);
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
		writeFileSync(
			path,
			JSON.stringify({
				bypassPermissionsModeAccepted: false,
				hasCompletedOnboarding: false,
				projects: { "/work/task": { hasTrustDialogAccepted: false } },
			}),
		);
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
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		const doc = JSON.parse(readFileSync(target, "utf8"));
		expect(doc.machineID).toBe("m");
		expect(doc.bypassPermissionsModeAccepted).toBe(true);
	});

	test("a dangling .claude.json refuses the launch and the link survives", () => {
		const h = home();
		const link = join(h, ".claude.json");
		// Stitch shape: a link into a dots checkout that hasn't landed
		// the file — realpath ENOENTs, existsSync reads false.
		symlinkSync(join(h, "dots", "claude.json"), link);
		expect(() => seedHarnessTrust("claude", "/w", h)).toThrow(/dangling symlink/);
		// The target must not be quietly created — the dots store keeps
		// its authority once the file appears there.
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(join(h, "dots", "claude.json"))).toBe(false);
	});
});

describe("codex", () => {
	// Semantic AND verbatim: trust_level must read "trusted", and the
	// seeded file starts with the original bytes plus exactly one line.
	const codexTrust = (dir: string, cwd: string): unknown => {
		const projects = (
			Bun.TOML.parse(readFileSync(join(dir, ".codex", "config.toml"), "utf8")) as {
				projects: Record<string, { trust_level?: string }>;
			}
		).projects;
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
		// comments — the shapes sed-style edits would mangle.
		const original =
			'[projects."/work/task"]\nother = 1\n\n' +
			"[projects.'/b'] # literal-quote form\ntrust_level = 'trusted'\n";
		writeFileSync(path, original);
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(path, "utf8");
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

	test("a dotted projects key scoped under a foreign [table] refuses — the insert would land in that table", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		// The last matching dotted line sits under [other] — inserting
		// after it writes other.projects."…".trust_level: still valid
		// TOML, root trust unset, launch logs seeded.
		const original =
			'projects."/work/task".model = "gpt-5"\n' +
			"[other]\n" +
			'projects."/work/task".extra = "nested"\n';
		writeFileSync(path, original);
		expect(() => seedHarnessTrust("codex", "/work/task", h)).toThrow("can't be extended safely");
		expect(readFileSync(path, "utf8")).toBe(original);
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

	test("a dangling config.toml refuses the launch and the link survives", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const link = join(h, ".codex", "config.toml");
		// existsSync reads false on a dangling link — the error must
		// name where it points.
		symlinkSync("../dots/codex.toml", link);
		expect(() => seedHarnessTrust("codex", "/work/task", h)).toThrow(
			/dangling symlink.*\.\.\/dots\/codex\.toml/,
		);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(join(h, "dots", "codex.toml"))).toBe(false);
	});
});

test("unknown kinds seed nothing and write nothing", () => {
	const h = home();
	expect(seedHarnessTrust("pi", "/w", h)).toEqual([]);
	expect(existsSync(join(h, ".claude.json"))).toBe(false);
	expect(existsSync(join(h, ".codex"))).toBe(false);
});
