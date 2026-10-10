import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const deploySh = join(import.meta.dir, "deploy.sh");
function commandPath(name: string): string {
	const path = Bun.which(name);
	if (!path) throw new Error(`fixture command missing: ${name}`);
	return path;
}
const realGit = commandPath("git");

type Options = {
	mode?: string;
	linked?: boolean;
	marker?:
		| "missing"
		| "empty"
		| "invalid"
		| "unknown"
		| "corrupt"
		| "blob"
		| "unreadable"
		| "unwritable"
		| "directory"
		| "dangling";
};

// Run the whole shipped script in a real scratch Git checkout. PATH contains
// only approved utilities and fakes: no production service, publication, build or SSH
// can escape the fixture, including on the missing-Podman path.
function runDeploy(changed: string[] = [], options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-deploy-test-"));
	const mode = options.mode ?? "healthy";
	const home = join(dir, "home");
	mkdirSync(home);
	const env = {
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	const git = (cwd: string, ...args: string[]): string => {
		const result = spawnSync(realGit, args, { cwd, env, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	};
	let markerDir: string | undefined;
	let marker: string | undefined;
	try {
		const main = join(dir, "main");
		mkdirSync(main);
		git(main, "init", "-q", "-b", "fixture");
		git(main, "config", "user.name", "Deploy fixture");
		git(main, "config", "user.email", "fixture@example.invalid");
		git(main, "config", "core.hooksPath", "/dev/null");
		mkdirSync(join(main, "scripts"));
		copyFileSync(deploySh, join(main, "scripts", "deploy.sh"));
		git(main, "add", ".");
		git(main, "commit", "-qm", "previous deployment");
		const oldRev = git(main, "rev-parse", "HEAD");
		for (const path of changed) {
			mkdirSync(dirname(join(main, path)), { recursive: true });
			writeFileSync(join(main, path), "fixture change\n");
		}
		git(main, "add", ".");
		git(main, "commit", "--allow-empty", "-qm", "new deployment");
		const newRev = git(main, "rev-parse", "HEAD");
		let repo = main;
		if (options.linked) {
			repo = join(dir, "linked checkout");
			git(main, "worktree", "add", "-qb", "linked", repo);
		}
		marker = resolve(repo, git(repo, "rev-parse", "--git-path", "GOBLIN_DEPLOYED_REV"));
		markerDir = dirname(marker);
		// Keep the damaged object outside HEAD's ancestry: ordinary status/log
		// checks must still succeed, leaving the marker check to detect it.
		const corruptRev =
			options.marker === "corrupt"
				? git(repo, "commit-tree", "HEAD^{tree}", "-m", "unrelated deployment")
				: undefined;
		if (options.marker !== "missing") {
			const value =
				options.marker === "empty"
					? ""
					: options.marker === "invalid"
						? "garbage"
						: options.marker === "unknown"
							? "0".repeat(40)
							: options.marker === "blob"
								? git(repo, "rev-parse", "HEAD:scripts/deploy.sh")
								: (corruptRev ?? oldRev);
			if (options.marker === "directory") mkdirSync(marker);
			else if (options.marker === "dangling") symlinkSync(join(dir, "missing"), marker);
			else writeFileSync(marker, `${value}\n`);
			if (options.marker === "unreadable") chmodSync(marker, 0o000);
			if (options.marker === "unwritable") chmodSync(marker, 0o444);
		}
		if (corruptRev) {
			const object = resolve(
				repo,
				git(repo, "rev-parse", "--git-path", `objects/${corruptRev.slice(0, 2)}/${corruptRev.slice(2)}`),
			);
			chmodSync(object, 0o644);
			writeFileSync(object, "not a compressed Git object\n");
		}
		if (mode === "marker-dir") chmodSync(markerDir, 0o555);
		if (mode === "dirty") writeFileSync(join(repo, "untracked"), "dirty\n");
		if (mode === "detached") git(repo, "checkout", "--detach", "-q");
		const alias = join(dir, "checkout-alias");
		symlinkSync(repo, alias);
		const serviceRoot =
			mode === "mismatch"
				? home
				: mode === "blank"
					? ""
					: mode === "missing-root"
						? join(dir, "missing")
						: mode === "alias"
							? alias
							: repo;
		const bin = join(dir, "bin");
		mkdirSync(bin);
		for (const name of ["dirname", "cat", "grep", "date", "seq", "tail"]) {
			symlinkSync(commandPath(name), join(bin, name));
		}
		const callsFile = join(dir, "calls");
		const stub = (name: string, body: string): void => {
			const path = join(bin, name);
			writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' '${name} '"$*" >> "$CALLS"\n${body}\n`);
			chmodSync(path, 0o755);
		};
		stub(
			"git",
			`case "$1" in
push|fetch|pull) echo 'deployment must not publish or update refs' >&2; exit 90 ;;
status|symbolic-ref|rev-parse|cat-file|log|diff)
  if [ "$MODE" = "$1" ]; then echo "$1 failed" >&2; exit 31; fi
  exec "$REAL_GIT" "$@" ;;
*) echo "unexpected git boundary: $*" >&2; exit 90 ;;
esac`,
		);
		stub(
			"bun",
			`case "$*" in
'run typecheck') failure=typecheck ;;
test) failure=test ;;
'install --frozen-lockfile') failure=install ;;
'run app:build') failure=build ;;
*) echo "unexpected bun boundary: $*" >&2; exit 90 ;;
esac
if [ "$MODE" = "$failure" ]; then echo "$failure failed" >&2; exit 32; fi`,
		);
		stub(
			"systemctl",
			`case "$*" in
'--user show --property=WorkingDirectory --value goblin.service')
  if [ "$MODE" = unit ]; then echo 'unit query failed' >&2; exit 33; fi
  printf '%s\\n' "$SERVICE_ROOT" ;;
'--user restart goblin')
  if [ "$MODE" = restart ]; then echo 'restart failed' >&2; exit 34; fi ;;
'--user is-active goblin')
  if [ "$MODE" = inactive ]; then echo failed; exit 3; fi
  echo active ;;
'--user show --property=LoadState --value goblin-memory-api.service')
  if [ "$MODE" = load-state ]; then echo 'load-state failed' >&2; exit 35; fi
  if [ "$MODE" = absent ]; then echo not-found; else echo loaded; fi ;;
*) echo "unexpected systemctl boundary: $*" >&2; exit 90 ;;
esac`,
		);
		stub(
			"journalctl",
			`if [ "$MODE" = journal ]; then echo 'journal failed' >&2; exit 36; fi
if [ "$MODE" = journal-errors ]; then echo '{"level":"error","msg":"fixture error"}'; fi`,
		);
		if (mode !== "no-podman")
			stub(
				"podman",
				`case "$*" in
'container exists goblin-memory-api')
  case "$MODE" in
  absent|installed-missing|load-state) exit 1 ;;
  storage) echo 'storage unavailable' >&2; exit 125 ;;
  esac ;;
"inspect goblin-memory-api --format {{.State.Health.Status}}")
  case "$MODE" in
  inspect) echo 'inspection failed' >&2; exit 125 ;;
  unhealthy) echo unhealthy ;;
  *) echo healthy ;;
  esac ;;
*) echo "unexpected podman boundary: $*" >&2; exit 90 ;;
esac`,
			);
		stub("sleep", "exit 0");
		stub("ssh", "echo 'deployment must be local' >&2; exit 90");
		const result = spawnSync("/bin/bash", [join(repo, "scripts", "deploy.sh")], {
			cwd: home,
			env: {
				...env,
				PATH: bin,
				MODE: mode,
				CALLS: callsFile,
				REAL_GIT: realGit,
				SERVICE_ROOT: serviceRoot,
			},
			encoding: "utf8",
			timeout: 10_000,
		});
		if (result.error) throw result.error;
		if (options.marker === "unreadable") chmodSync(marker, 0o600);
		const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [];
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			calls,
			oldRev,
			newRev,
			marker,
			markerValue:
				existsSync(marker) && options.marker !== "directory"
					? readFileSync(marker, "utf8").trim()
					: null,
		};
	} finally {
		if (markerDir) chmodSync(markerDir, 0o755);
		if (marker && existsSync(marker)) chmodSync(marker, 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
}

function expectPreflightFailure(result: ReturnType<typeof runDeploy>, diagnostic: string) {
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain(diagnostic);
	expect(
		result.calls.some(
			(call) =>
				call.startsWith("bun ") || /^git (push|fetch|pull)\b/.test(call) || call.includes(" restart "),
		),
	).toBe(false);
}

describe("local deployment preflight", () => {
	for (const [mode, diagnostic] of [
		["mismatch", "does not match checkout"],
		["blank", "no absolute WorkingDirectory"],
		["missing-root", "cannot resolve goblin.service WorkingDirectory"],
		["unit", "cannot read goblin.service WorkingDirectory"],
		["dirty", "working tree dirty"],
		["detached", "detached HEAD"],
		["diff", "cannot compare deployment revisions"],
		["status", "cannot read working tree status"],
		["log", "cannot read deployment commit"],
		["marker-dir", "marker directory is not writable"],
		["rev-parse", "cannot resolve deployment marker"],
		["cat-file", "cannot inspect deployment marker commit"],
	] as const) {
		test(`${mode} stops before any deployment side effects`, () => {
			expectPreflightFailure(runDeploy([], { mode }), diagnostic);
		});
	}

	for (const marker of [
		"empty",
		"invalid",
		"blob",
		"unreadable",
		"unwritable",
		"directory",
		"dangling",
	] as const) {
		test(`${marker} marker fails loudly instead of becoming a first deployment`, () => {
			expectPreflightFailure(runDeploy([], { marker }), "deployment marker");
		});
	}

	test("canonical service path accepts a symlink to this checkout", () => {
		expect(runDeploy([], { mode: "alias" }).status).toBe(0);
	});

	test("corrupt marker history fails before deployment even when Git reports missing with exit zero", () => {
		const result = runDeploy([], { marker: "corrupt" });
		expectPreflightFailure(result, "deployment marker");
		expect(result.stderr).toContain("unable to unpack");
		expect(result.stdout).not.toContain("history is missing; refreshing everything");
		expect(result.markerValue).not.toBe(result.newRev);
	});

	test("missing marker is a first deployment and refreshes everything", () => {
		const result = runDeploy([], { marker: "missing" });
		expect(result.status).toBe(0);
		expect(result.calls).toContain("bun install --frozen-lockfile");
		expect(result.calls).toContain("bun run app:build");
		expect(result.markerValue).toBe(result.newRev);
		expect(result.stdout).not.toContain("rollback:");
		expect(result.stdout).toContain("deploy/memory/ changed");
	});

	test("stale marker with missing history refreshes everything, including the memory note", () => {
		const result = runDeploy([], { marker: "unknown" });
		expect(result.status).toBe(0);
		expect(result.calls).toContain("bun install --frozen-lockfile");
		expect(result.calls).toContain("bun run app:build");
		expect(result.stdout).toContain("deploy/memory/ changed");
		expect(result.stdout).toContain("history is missing; refreshing everything");
		expect(result.markerValue).toBe(result.newRev);
	});

	test("linked worktree marker uses Git's path, not .git as a directory", () => {
		const result = runDeploy(["app/src/App.tsx"], { linked: true });
		expect(result.status).toBe(0);
		expect(result.marker).toContain("/.git/worktrees/");
		expect(result.markerValue).toBe(result.newRev);
		expect(result.stdout).toContain("rollback:");
	});
});

describe("local deployment refresh and rollback", () => {
	for (const path of [
		"bun.lock",
		"package.json",
		"app/src/App.tsx",
		"app/vite.config.ts",
		"src/agent/tools/ui-schema.ts",
	]) {
		test(`${path} rebuilds the inlined client`, () => {
			const result = runDeploy([path]);
			expect(result.status).toBe(0);
			expect(result.calls).toContain("bun run app:build");
			expect(result.calls.includes("bun install --frozen-lockfile")).toBe(
				["bun.lock", "package.json"].includes(path),
			);
		});
	}

	test("backend-only deployment gates locally without rebuilding or updating remote refs", () => {
		const result = runDeploy(["src/index.ts", "src/http/app-channel.ts"]);
		expect(result.status).toBe(0);
		expect(result.calls.filter((call) => call.startsWith("bun "))).toEqual([
			"bun run typecheck",
			"bun test",
		]);
		const boundaries = [
			"bun run typecheck",
			"bun test",
			"systemctl --user restart goblin",
		];
		const indexes = boundaries.map((call) => result.calls.indexOf(call));
		expect(
			indexes.every((index, i) => index >= 0 && (i === 0 || index > (indexes[i - 1] ?? -1))),
		).toBe(true);
		expect(result.calls.some((call) => /^(ssh |git (push|fetch|pull))/.test(call))).toBe(false);
		expect(result.markerValue).toBe(result.newRev);
		expect(result.stdout).toContain("done: g7");
	});

	test("a local deploy succeeds even when publication would fail", () => {
		const result = runDeploy(["package.json"], { mode: "push" });
		expect(result.status).toBe(0);
		expect(result.calls.some((call) => /^git (push|fetch|pull)\b/.test(call))).toBe(false);
		expect(result.stdout).not.toContain("pushing");
		expect(result.calls).toContain("bun install --frozen-lockfile");
		expect(result.calls).toContain("bun run app:build");
		expect(result.calls).toContain("systemctl --user restart goblin");
		expect(result.markerValue).toBe(result.newRev);
	});

	test("rollback restores revision, ignored dependencies/client and marker in order", () => {
		const result = runDeploy(["src/index.ts"]);
		expect(result.status).toBe(0);
		const line = result.stdout.split("\n").find((value) => value.startsWith("deploy: rollback:"));
		expect(line).toBe(
			`deploy: rollback: git reset --hard ${result.oldRev} && bun install --frozen-lockfile && bun run app:build && systemctl --user restart goblin && echo ${result.oldRev} > .git/GOBLIN_DEPLOYED_REV`,
		);
	});

	test("memory asset changes print a manual runbook without applying it", () => {
		const result = runDeploy(["deploy/memory/healthcheck.py"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("never auto-applied");
		expect(result.calls.filter((call) => call.startsWith("bun "))).toEqual([
			"bun run typecheck",
			"bun test",
		]);
		expect(result.calls.filter((call) => call.includes(" restart "))).toEqual([
			"systemctl --user restart goblin",
		]);
	});
});

describe("local deployment failures and memory probe", () => {
	for (const mode of [
		"typecheck",
		"test",
		"install",
		"build",
		"restart",
		"inactive",
		"journal",
		"storage",
		"inspect",
		"unhealthy",
		"installed-missing",
		"load-state",
	]) {
		test(`${mode} failure keeps the previous deployment marker`, () => {
			const result = runDeploy(["package.json"], { mode });
			expect(result.status).not.toBe(0);
			expect(result.stderr.length).toBeGreaterThan(0);
			expect(result.markerValue).toBe(result.oldRev);
			expect(result.stdout).not.toContain("deploy: done:");
			if (["typecheck", "test", "install", "build", "restart", "journal"].includes(mode))
				expect(result.stderr).toContain(`${mode} failed`);
			if (["typecheck", "test"].includes(mode)) {
				expect(result.calls).not.toContain("bun install --frozen-lockfile");
				expect(result.calls).not.toContain("bun run app:build");
			}
			if (["typecheck", "test", "install", "build"].includes(mode))
				expect(result.calls).not.toContain("systemctl --user restart goblin");
			if (mode === "inactive") {
				expect(result.stderr).toContain("goblin not active after restart");
				expect(result.calls).toContain("journalctl --user -u goblin -n 40 --no-pager");
			}
		});
	}

	for (const [mode, output] of [
		["absent", "not installed"],
		["no-podman", "podman unavailable"],
		["healthy", "goblin-memory-api: healthy"],
	] as const) {
		test(`memory ${mode} is successful`, () => {
			const result = runDeploy([], { mode });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(output);
			expect(result.markerValue).toBe(result.newRev);
		});
	}

	test("fresh journal errors are visible warnings, not hidden or a read failure", () => {
		const result = runDeploy([], { mode: "journal-errors" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("WARNING — error lines in the fresh journal");
		expect(result.stderr).toContain("fixture error");
	});
});
