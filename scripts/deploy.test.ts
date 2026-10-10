import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy.sh run for real in a scratch tree — the shipped text is what's
// exercised — with its external boundaries (git, bun, systemctl,
// journalctl, podman, sleep) stubbed on PATH and the coreutils it needs
// (dirname, cat, grep) symlinked from the host. PATH is the stub dir
// alone: `command -v podman` is answered by the stub's presence, never
// the host's, and no real git/systemctl can leak into a run.

const deploySh = join(import.meta.dir, "deploy.sh");

const OLD_REV = `o${"0".repeat(39)}`;
const NEW_REV = `n${"1".repeat(39)}`;

type DeployRun = {
	status: number | null;
	stdout: string;
	stderr: string;
	git: string[];
	bun: string[];
	systemctl: string[];
	journalctl: string[];
	marker: string | null;
};

function runDeploy(opts: {
	changed?: string[];
	mode?: string;
	// "set" (default) seeds the marker with the old revision; "none"
	// removes it (first run); "dead" writes one no git can resolve
	// (history rewrite).
	marker?: "set" | "none" | "dead";
	podman?: boolean;
}): DeployRun {
	const { changed = [], mode = "", marker = "set", podman = true } = opts;
	const dir = mkdtempSync(join(tmpdir(), "goblin-deploy-test-"));
	try {
		// The script deploys the tree containing it (dirname $0/..), so
		// the scratch tree is a .git dir (the marker's home) plus the
		// verbatim script under scripts/.
		const tree = join(dir, "tree");
		mkdirSync(join(tree, ".git"), { recursive: true });
		mkdirSync(join(tree, "scripts"), { recursive: true });
		writeFileSync(join(tree, "scripts", "deploy.sh"), readFileSync(deploySh));
		if (marker !== "none") {
			writeFileSync(
				join(tree, ".git", "GOBLIN_DEPLOYED_REV"),
				`${marker === "dead" ? `d${"e".repeat(39)}` : OLD_REV}\n`,
			);
		}

		const bin = join(dir, "bin");
		mkdirSync(bin);
		const link = (name: string): void => {
			const real = ["/usr/bin", "/bin"].map((p) => join(p, name)).find((p) => existsSync(p));
			if (real === undefined) throw new Error(`deploy.test: no host ${name} to symlink`);
			symlinkSync(real, join(bin, name));
		};
		link("dirname");
		link("cat");
		link("grep");
		link("tail"); // the journal-warning path caps the printed errors

		const log = {
			git: join(dir, "git.calls"),
			bun: join(dir, "bun.calls"),
			systemctl: join(dir, "systemctl.calls"),
			journalctl: join(dir, "journalctl.calls"),
		};

		const stub = (name: string, body: string): void => {
			const path = join(bin, name);
			// Absolute interpreter: PATH is the stub dir alone, so an
			// env-style shebang couldn't resolve bash.
			writeFileSync(path, `#!/bin/bash\n${body}`);
			chmodSync(path, 0o755);
		};
		// sleep is stubbed so the restart wait costs nothing; date/seq
		// only feed the journal scan and the wait loop.
		stub("date", "echo 1700000000");
		stub("seq", "echo 1");
		stub("sleep", "exit 0");
		stub(
			"git",
			[
				'echo "git $*" >> "$GIT_CALLS"',
				'case "$*" in',
				'	"status --porcelain") if [ "$MODE" = dirty ]; then printf "M src/x.ts\\n"; fi ;;',
				'	"symbolic-ref -q --short HEAD") if [ "$MODE" = detached ]; then exit 1; fi; echo main ;;',
				'	"rev-parse HEAD") cat "$FAKE_NEW_REV" ;;',
				'	"rev-parse -q --verify"*) if [ "$MODE" = dead ]; then exit 1; fi ;;',
				'	"log -1"*) echo "abc1234 subject" ;;',
				'	"push origin HEAD") if [ "$MODE" = push ]; then echo "push failed" >&2; exit 21; fi ;;',
				'	"diff --name-only"*) cat "$FAKE_DIFF" ;;',
				'	*) echo "git stub: unhandled: $*" >&2; exit 64 ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		stub(
			"bun",
			[
				'echo "bun $*" >> "$BUN_CALLS"',
				'case "$1 $2" in',
				'	"run typecheck") if [ "$MODE" = typecheck ]; then echo "typecheck failed" >&2; exit 22; fi ;;',
				'	"run app:build") if [ "$MODE" = build ]; then echo "build failed" >&2; exit 25; fi ;;',
				"esac",
				'case "$1" in',
				'	test) if [ "$MODE" = test ]; then echo "test failed" >&2; exit 23; fi ;;',
				'	install) if [ "$MODE" = install ]; then echo "install failed" >&2; exit 24; fi ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		stub(
			"systemctl",
			[
				'echo "systemctl $*" >> "$SYSTEMCTL_CALLS"',
				'case "$1 $2" in',
				'	"--user restart") if [ "$MODE" = restart ]; then echo "restart failed" >&2; exit 33; fi ;;',
				'	"--user is-active") if [ "$MODE" = notactive ]; then echo activating; else echo active; fi ;;',
				'	"--user show") if [ "$MODE" = absent ]; then echo not-found; else echo loaded; fi ;;',
				"esac",
				"exit 0",
			].join("\n"),
		);
		stub(
			"journalctl",
			[
				'echo "journalctl $*" >> "$JOURNALCTL_CALLS"',
				'case "$*" in',
				'	*--since*) if [ "$MODE" = errorlines ]; then echo \'{"level":"error","msg":"boom"}\'; fi ;;',
				'	*) if [ "$MODE" = notactive ]; then echo "journal dump" >&2; fi ;;',
				"esac",
				'if [ "$MODE" = journal ]; then echo "journal failed" >&2; exit 34; fi',
				"exit 0",
			].join("\n"),
		);
		if (podman) {
			stub(
				"podman",
				[
					'if [ "$1" = container ]; then',
					'case "$MODE" in',
					"absent|installed-missing) exit 1 ;;",
					"storage) echo 'storage unavailable' >&2; exit 125 ;;",
					"*) exit 0 ;;",
					"esac",
					"else",
					'case "$MODE" in',
					"inspect) echo 'inspection failed' >&2; exit 125 ;;",
					"unhealthy) echo unhealthy ;;",
					"*) echo healthy ;;",
					"esac",
					"fi",
					"exit 0",
				].join("\n"),
			);
		}

		writeFileSync(join(dir, "diff"), changed.length > 0 ? `${changed.join("\n")}\n` : "");
		// rev-parse HEAD cats this file — its content is the revision.
		const newRevFile = join(dir, "newrev");
		writeFileSync(newRevFile, `${NEW_REV}\n`);
		const env: Record<string, string> = {
			MODE: mode,
			PATH: bin,
			GIT_CALLS: log.git,
			BUN_CALLS: log.bun,
			SYSTEMCTL_CALLS: log.systemctl,
			JOURNALCTL_CALLS: log.journalctl,
			FAKE_NEW_REV: newRevFile,
			FAKE_DIFF: join(dir, "diff"),
		};
		const res = spawnSync("/bin/bash", [join(tree, "scripts", "deploy.sh")], {
			env,
			encoding: "utf8",
		});
		const calls = (path: string): string[] =>
			existsSync(path)
				? readFileSync(path, "utf8")
						.split("\n")
						.filter((l) => l !== "")
				: [];
		const markerPath = join(tree, ".git", "GOBLIN_DEPLOYED_REV");
		return {
			status: res.status,
			stdout: res.stdout,
			stderr: res.stderr,
			git: calls(log.git),
			bun: calls(log.bun),
			systemctl: calls(log.systemctl),
			journalctl: calls(log.journalctl),
			marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : null,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// The gate runs through the same bun stub as the refresh steps — only
// what survives it counts as a refresh decision.
const refresh = (run: DeployRun): string[] =>
	run.bun.filter((c) => c !== "bun run typecheck" && c !== "bun test");

describe("deploy.sh refresh selection", () => {
	test("dependency-only change rebuilds the client (#121)", () => {
		// react/ai/vite bumps land in package.json/bun.lock with no app/
		// path touched — the bundle inlines that code, so it must rebuild.
		for (const manifest of ["bun.lock", "package.json"]) {
			const run = runDeploy({ changed: [manifest] });
			expect(run.status).toBe(0);
			expect(refresh(run)).toContain("bun install --frozen-lockfile");
			expect(refresh(run)).toContain("bun run app:build");
		}
	});

	test("app-only change builds the client but installs nothing", () => {
		const run = runDeploy({ changed: ["app/src/App.tsx", "app/vite.config.ts"] });
		expect(run.status).toBe(0);
		expect(refresh(run)).toEqual(["bun run app:build"]);
	});

	test("backend-only change installs and builds nothing", () => {
		const run = runDeploy({ changed: ["src/index.ts", "src/http/app-channel.ts"] });
		expect(run.status).toBe(0);
		expect(refresh(run)).toEqual([]);
		expect(run.systemctl).toContain("systemctl --user restart goblin");
	});

	test("deploy/memory-only change prints the install note, refreshes nothing", () => {
		const run = runDeploy({ changed: ["deploy/memory/install.py"] });
		expect(run.status).toBe(0);
		expect(refresh(run)).toEqual([]);
		expect(run.stdout).toContain("deploy/memory/ changed");
	});

	test("first run (no marker) refreshes everything, including the memory note", () => {
		// An empty diff proves nothing on the first deploy — deps, client,
		// and the memory note must all fire, not silently skip.
		const run = runDeploy({ marker: "none" });
		expect(run.status).toBe(0);
		expect(refresh(run)).toContain("bun install --frozen-lockfile");
		expect(refresh(run)).toContain("bun run app:build");
		expect(run.stdout).toContain("deploy/memory/ changed");
	});

	test("dead marker (history rewrite) refreshes everything (sentinel)", () => {
		// A marker git can no longer resolve must not fall through to
		// "diff failed → nothing changed": the refresh can't prove any
		// path fresh, so deps, client, and the memory note all fire.
		const run = runDeploy({ marker: "dead", mode: "dead" });
		expect(run.status).toBe(0);
		expect(refresh(run)).toContain("bun install --frozen-lockfile");
		expect(refresh(run)).toContain("bun run app:build");
		expect(run.stdout).toContain("deploy/memory/ changed");
	});

	test("printed rollback reinstalls and rebuilds before restart (#120)", () => {
		// app/dist and node_modules are gitignored: a bare reset leaves
		// the new client/deps beside the old backend. The printed line
		// must order reset → install → build → restart to be copy-paste
		// safe.
		const run = runDeploy({ changed: ["src/index.ts"] });
		expect(run.status).toBe(0);
		const line = run.stdout.split("\n").find((l) => l.startsWith("deploy: rollback:"));
		expect(line).toBeDefined();
		const at = (frag: string): number => (line ?? "").indexOf(frag);
		const reset = at("reset --hard");
		const install = at("bun install --frozen-lockfile");
		const build = at("bun run app:build");
		const restart = at("systemctl --user restart goblin");
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(install).toBeGreaterThan(reset);
		expect(build).toBeGreaterThan(install);
		expect(restart).toBeGreaterThan(build);
	});
});

describe("deploy.sh gates and boundaries", () => {
	test("a dirty tree refuses before anything runs", () => {
		const run = runDeploy({ mode: "dirty" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("dirty");
		expect(run.git).not.toContain("git push origin HEAD");
		expect(run.systemctl).toEqual([]);
	});

	test("a detached HEAD refuses", () => {
		const run = runDeploy({ mode: "detached" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("detached");
		expect(run.git).not.toContain("git push origin HEAD");
	});

	test("gate typecheck failure stops before refresh and restart", () => {
		const run = runDeploy({ mode: "typecheck" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("typecheck failed");
		expect(run.git).not.toContain("git push origin HEAD");
		expect(run.systemctl).toEqual([]);
	});

	test("gate test failure stops before refresh and restart", () => {
		const run = runDeploy({ mode: "test" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("test failed");
		expect(run.git).not.toContain("git push origin HEAD");
		expect(run.systemctl).toEqual([]);
	});

	test("a local deploy succeeds even when pushing would fail", () => {
		const run = runDeploy({ mode: "push", changed: ["package.json"] });
		expect(run.status).toBe(0);
		expect(run.git).not.toContain("git push origin HEAD");
		expect(refresh(run)).toEqual(["bun install --frozen-lockfile", "bun run app:build"]);
		expect(run.systemctl).toContain("systemctl --user restart goblin");
		expect(run.marker).toBe(NEW_REV);
	});

	test("deployment leaves Git publication and the remote review base alone", () => {
		const run = runDeploy({ changed: ["src/index.ts"] });
		expect(run.status).toBe(0);
		expect(run.git.some((call) => /\b(push|fetch|pull)\b/.test(call))).toBe(false);
		expect(run.stdout).not.toContain("pushing");
		expect(run.marker).toBe(NEW_REV);
	});

	test("install failure stops before restart", () => {
		const run = runDeploy({ mode: "install", changed: ["package.json"] });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("install failed");
		expect(run.systemctl).toEqual([]);
	});

	test("build failure stops before restart", () => {
		const run = runDeploy({ mode: "build", changed: ["app/src/App.tsx"] });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("build failed");
		expect(run.systemctl).toEqual([]);
	});

	test("restart failure retains the previous revision", () => {
		const run = runDeploy({ mode: "restart", changed: ["src/index.ts"] });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("restart failed");
		expect(run.marker).toBe(OLD_REV);
	});

	test("unit not active after restart dumps the journal and retains the revision", () => {
		const run = runDeploy({ mode: "notactive", changed: ["src/index.ts"] });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("goblin not active after restart");
		expect(run.journalctl.length).toBeGreaterThan(0);
		expect(run.marker).toBe(OLD_REV);
	});

	test("journal read failure stops before the marker write", () => {
		const run = runDeploy({ mode: "journal", changed: ["src/index.ts"] });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("journal failed");
		expect(run.marker).toBe(OLD_REV);
	});

	test("error lines in the fresh journal warn but still ship", () => {
		const run = runDeploy({ mode: "errorlines", changed: ["src/index.ts"] });
		expect(run.status).toBe(0);
		expect(run.stderr).toContain("WARNING");
		expect(run.marker).toBe(NEW_REV);
	});

	test("success writes the marker and prints the rollback line", () => {
		const run = runDeploy({ changed: ["src/index.ts"] });
		expect(run.status).toBe(0);
		expect(run.marker).toBe(NEW_REV);
		expect(run.stdout).toContain("done: g7");
		expect(run.stdout).toContain("rollback:");
	});
});

describe("deploy.sh memory probe", () => {
	test("missing podman is informational", () => {
		const run = runDeploy({ podman: false });
		expect(run.status).toBe(0);
		expect(run.stdout).not.toContain("goblin-memory-api:");
	});

	test("absent container with no unit means the stack is not installed", () => {
		const run = runDeploy({ mode: "absent" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("memory stack not installed");
	});

	test("absent container with a loaded unit fails visibly", () => {
		const run = runDeploy({ mode: "installed-missing" });
		expect(run.status).not.toBe(0);
		expect(run.stderr.length).toBeGreaterThan(0);
	});

	test("healthy memory container passes", () => {
		const run = runDeploy({ mode: "healthy" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("goblin-memory-api: healthy");
	});

	test("unhealthy memory container fails visibly", () => {
		const run = runDeploy({ mode: "unhealthy" });
		expect(run.status).not.toBe(0);
		expect(run.stderr.length).toBeGreaterThan(0);
	});

	test("inspection failure fails visibly", () => {
		const run = runDeploy({ mode: "inspect" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("inspection failed");
	});

	test("podman container exists failing hard fails visibly", () => {
		const run = runDeploy({ mode: "storage" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("storage unavailable");
	});
});
