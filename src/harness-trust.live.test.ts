// Live harness-trust drift check: the seeded key names are
// upstream-owned config literals, and drift here is silent by
// nature — upstream renaming a key means the seed still succeeds and
// the launch shows the consent dialog anyway. harness-trust.test.ts
// pins the write contract against fakes; this file is what catches a
// codex/claude upgrade moving the keys underneath it: seed a temp
// HOME through the real entry, then grep the INSTALLED binaries for
// the exact literals (they are property/string literals in both
// bundles — visible without launching anything). Gated OFF the
// default suite, run deliberately:
//
//     GOBLIN_HARNESS_TRUST_LIVE=1 bun test src/harness-trust.live.test.ts
//
// Nothing real is touched: the seed lands in a temp HOME, and no
// harness is ever started — no cost, no auth, no panes.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seedHarnessTrust } from "./harness-trust.ts";
import { boundedRun, spawnProc } from "./proc.ts";

const LIVE = process.env.GOBLIN_HARNESS_TRUST_LIVE === "1";

// The claude gates, top level and per-project, as the module writes them.
const CLAUDE_KEYS = [
	"bypassPermissionsModeAccepted",
	"hasCompletedOnboarding",
	"hasTrustDialogAccepted",
	"hasCompletedProjectOnboarding",
];

const tempHomes: string[] = [];

function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "goblin-harness-trust-"));
	tempHomes.push(home);
	return home;
}

function fail(msg: string): never {
	throw new Error(msg);
}

// exit 0 = literal present; 1 = absent (the drift signal); anything
// else is the probe itself breaking (unreadable binary) — loud, not
// a false "still pinned".
async function binaryContains(key: string, file: string): Promise<boolean> {
	const r = await boundedRun(spawnProc(["grep", "-a", "-q", "-m", "1", "--", key, file]), {
		timeoutMs: 30_000,
		maxOutput: 4096,
	});
	if (r.exitCode !== 0 && r.exitCode !== 1) {
		fail(`grep probe failed on ${file} (exit ${r.exitCode}): ${r.stderr.slice(0, 200)}`);
	}
	return r.exitCode === 0;
}

// The launcher's `codex` is an npm shim; the config-reading binary is
// the vendored platform package it spawns. Resolve that same layout,
// and fail with the searched root named when it moves.
function codexBinary(): string {
	const shim = Bun.which("codex");
	if (shim === null) fail("codex not on PATH — is the codex delegation lane still real?");
	const pkgRoot = dirname(dirname(realpathSync(shim)));
	const scanRoot = join(pkgRoot, "node_modules", "@openai");
	for (const hit of new Bun.Glob("codex-*/vendor/*/bin/codex").scanSync({
		cwd: scanRoot,
		onlyFiles: true,
	})) {
		return join(scanRoot, hit);
	}
	fail(`no vendored codex binary under ${scanRoot} — the npm layout moved, re-pin the check`);
}

function claudeBinary(): string {
	const shim = Bun.which("claude");
	if (shim === null) fail("claude not on PATH — is the claude delegation lane still real?");
	return realpathSync(shim);
}

describe.skipIf(!LIVE)("harness-trust live drift (GOBLIN_HARNESS_TRUST_LIVE=1)", () => {
	test("codex: the seed still writes trust_level and the installed binary still knows it", async () => {
		const home = freshHome();
		const seeded = seedHarnessTrust("codex", home, home);
		expect(seeded.length).toBe(1);
		const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
		if (!config.includes('trust_level = "trusted"')) {
			fail("seeded config.toml carries no trust_level — the module's write moved");
		}
		const bin = codexBinary();
		if (!(await binaryContains("trust_level", bin))) {
			fail(`codex binary ${bin} no longer mentions trust_level — re-pin harness-trust`);
		}
	}, 30_000);

	test("claude: the seed still writes the four gates and the installed bundle still knows them", async () => {
		const home = freshHome();
		seedHarnessTrust("claude", home, home);
		const doc = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
			projects?: Record<string, Record<string, unknown>>;
		} & Record<string, unknown>;
		expect(doc.bypassPermissionsModeAccepted).toBe(true);
		expect(doc.hasCompletedOnboarding).toBe(true);
		const project = doc.projects?.[home];
		expect(project?.hasTrustDialogAccepted).toBe(true);
		expect(project?.hasCompletedProjectOnboarding).toBe(true);
		const bin = claudeBinary();
		for (const key of CLAUDE_KEYS) {
			if (!(await binaryContains(key, bin))) {
				fail(`claude bundle ${bin} no longer mentions ${key} — re-pin harness-trust`);
			}
		}
	}, 30_000);

	afterAll(() => {
		const failures: string[] = [];
		for (const home of tempHomes) {
			try {
				rmSync(home, { recursive: true, force: true });
			} catch (err) {
				failures.push(`${home}: ${String(err).slice(0, 200)}`);
			}
		}
		if (failures.length > 0) throw new Error(`teardown failed: ${failures.join("; ")}`);
	});
});
