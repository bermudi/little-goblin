import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

describe("devin", () => {
	// Pinned against devin 3000.14 on a throwaway HOME (2026-11-20).
	const STORE = join(".local", "share", "devin", "cli", "trusted_workspaces.json");
	let savedXdg: string | undefined;
	beforeEach(() => {
		savedXdg = process.env.XDG_DATA_HOME;
		delete process.env.XDG_DATA_HOME;
	});
	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdg;
	});

	function filesUnder(root: string): string[] {
		return readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((e) => !e.isDirectory())
			.map((e) => relative(root, join(e.parentPath, e.name)))
			.sort();
	}

	test("a fresh HOME gets one store file trusting exactly this folder", () => {
		const h = home();
		const cwd = home();
		expect(seedHarnessTrust("devin", cwd, h)).toEqual([`dir trust ${realpathSync(cwd)}`]);
		expect(filesUnder(h)).toEqual([STORE]);
		expect(JSON.parse(readFileSync(join(h, STORE), "utf8"))).toEqual({
			trusted_paths: [realpathSync(cwd)],
		});
		expect(statSync(join(h, STORE)).mode & 0o777).toBe(0o644);
	});

	test("appends to existing trust, keeping other entries, unknown keys and the file mode", () => {
		const h = home();
		const cwd = home();
		const path = join(h, STORE);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ trusted_paths: ["/home/op/proj"], future: { a: 1 } }));
		chmodSync(path, 0o600);
		seedHarnessTrust("devin", cwd, h);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			trusted_paths: ["/home/op/proj", realpathSync(cwd)],
			future: { a: 1 },
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a folder already trusted, or under a trusted folder, is left alone", () => {
		const h = home();
		const parent = realpathSync(home());
		mkdirSync(join(parent, "child"));
		const path = join(h, STORE);
		mkdirSync(join(path, ".."), { recursive: true });
		const before = JSON.stringify({ trusted_paths: [parent] });
		writeFileSync(path, before);
		expect(seedHarnessTrust("devin", parent, h)).toEqual([]);
		expect(seedHarnessTrust("devin", join(parent, "child"), h)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("a sibling that shares a name prefix is not covered", () => {
		const h = home();
		const base = realpathSync(home());
		mkdirSync(join(base, "work"));
		mkdirSync(join(base, "workshop"));
		const path = join(h, STORE);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ trusted_paths: [join(base, "work")] }));
		seedHarnessTrust("devin", join(base, "workshop"), h);
		expect(JSON.parse(readFileSync(path, "utf8")).trusted_paths).toEqual([
			join(base, "work"),
			join(base, "workshop"),
		]);
	});

	test("a symlinked cwd is trusted by its real path, which is what devin checks", () => {
		const h = home();
		const real = home();
		const link = join(home(), "link");
		symlinkSync(real, link);
		seedHarnessTrust("devin", link, h);
		expect(JSON.parse(readFileSync(join(h, STORE), "utf8")).trusted_paths).toEqual([
			realpathSync(real),
		]);
	});

	test("an absolute XDG_DATA_HOME moves the store; a relative one is ignored", () => {
		const h = home();
		const xdg = home();
		const cwd = home();
		process.env.XDG_DATA_HOME = xdg;
		seedHarnessTrust("devin", cwd, h);
		expect(filesUnder(h)).toEqual([]);
		expect(filesUnder(xdg)).toEqual([join("devin", "cli", "trusted_workspaces.json")]);

		process.env.XDG_DATA_HOME = "relative/data";
		seedHarnessTrust("devin", cwd, h);
		expect(filesUnder(h)).toEqual([STORE]);
	});

	test("a store we can't read as a path list fails loudly and stays untouched", () => {
		const h = home();
		const cwd = home();
		const path = join(h, STORE);
		mkdirSync(join(path, ".."), { recursive: true });
		for (const [body, message] of [
			['{"trusted_paths": "/x"}', "not a list of paths"],
			['{"trusted_paths": [1]}', "not a list of paths"],
			['["/x"]', "not a JSON object"],
			["{not json", "invalid JSON"],
		] as const) {
			writeFileSync(path, body);
			expect(() => seedHarnessTrust("devin", cwd, h)).toThrow(message);
			expect(readFileSync(path, "utf8")).toBe(body);
		}
	});

	test("a symlinked store is written through, never replaced", () => {
		const h = home();
		const cwd = home();
		const target = join(h, "dots", "trusted.json");
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, JSON.stringify({ trusted_paths: [] }));
		const link = join(h, STORE);
		mkdirSync(join(link, ".."), { recursive: true });
		symlinkSync(target, link);
		seedHarnessTrust("devin", cwd, h);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8")).trusted_paths).toEqual([realpathSync(cwd)]);
	});
});

test("unknown kinds seed nothing and write nothing", () => {
	const h = home();
	expect(seedHarnessTrust("pi", "/w", h)).toEqual([]);
	expect(existsSync(join(h, ".claude.json"))).toBe(false);
	expect(existsSync(join(h, ".codex"))).toBe(false);
	expect(existsSync(join(h, ".local"))).toBe(false);
});
