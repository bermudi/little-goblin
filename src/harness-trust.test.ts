// Trust seeding is the difference between a delegation that runs and
// one parked on a first-run dialog — these guard the two recipes
// (claude's .claude.json flags, codex's config.toml trust_level) and
// the only-ever-set rule against the operator's own files.

import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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
});

describe("codex", () => {
	test("creates config.toml with a trusted projects section", () => {
		const h = home();
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(join(h, ".codex", "config.toml"), "utf8");
		expect(text).toContain('[projects."/work/task"]');
		expect(text).toContain('trust_level = "trusted"');
	});

	test("appends without disturbing existing content", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		writeFileSync(path, '# hand-maintained\n[projects."/keep"]\ntrust_level = "trusted"\n');
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("# hand-maintained");
		expect(text).toContain('[projects."/keep"]\ntrust_level = "trusted"');
		expect(text).toContain('[projects."/work/task"]\ntrust_level = "trusted"');
	});

	test("inserts trust_level into a section that lacks it", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		writeFileSync(path, '[projects."/work/task"]\nother = 1\n\n[projects."/b"]\ntrust_level = "trusted"\n');
		seedHarnessTrust("codex", "/work/task", h);
		const text = readFileSync(path, "utf8");
		expect(text).toContain('[projects."/work/task"]\ntrust_level = "trusted"\nother = 1');
		expect(text).toContain('[projects."/b"]\ntrust_level = "trusted"');
	});

	test("an explicit trust_level stands — the operator's call wins", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const path = join(h, ".codex", "config.toml");
		writeFileSync(path, '[projects."/work/task"]\ntrust_level = "untrusted"\n');
		expect(seedHarnessTrust("codex", "/work/task", h)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe('[projects."/work/task"]\ntrust_level = "untrusted"\n');
	});
});

test("unknown kinds seed nothing and write nothing", () => {
	const h = home();
	expect(seedHarnessTrust("pi", "/w", h)).toEqual([]);
	expect(existsSync(join(h, ".claude.json"))).toBe(false);
	expect(existsSync(join(h, ".codex"))).toBe(false);
});
