import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
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
	attempt?: "regular" | "directory" | "dangling" | "link" | "unreadable" | "unwritable";
};

// Fake only external command boundaries: PATH contains approved
// utilities and fakes — nothing here can reach a production service,
// publication, build or SSH. The bun refresh stubs write real artifact
// bytes from the checkout's own sources, so an interrupted deploy's
// half-written artifacts are distinguishable from a clean refresh.
function fakeBin(dir: string, includePodman = true): string {
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const name of [
		"bash",
		"cat",
		"cp",
		"date",
		"dirname",
		"flock",
		"grep",
		"ln",
		"mkdir",
		"mktemp",
		"mv",
		"readlink",
		"rm",
		"sed",
		"seq",
		"sort",
		"tail",
		"tr",
	]) {
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
'install --frozen-lockfile') failure=install ;;
'run app:build') failure=build ;;
'scripts/check-startup.ts --watch '*)
  if [ "$MODE" = watch-fail ]; then echo 'startup acceptance failed' >&2; exit 37; fi ;;
'scripts/check-startup.ts --brief '*)
  echo 'systemd[1]: Started goblin.service.' ;;
*) echo "unexpected bun boundary: $*" >&2; exit 90 ;;
esac
if [ "$MODE" = "$failure" ]; then echo "$failure failed" >&2; exit 32; fi
case "$failure" in
install) mkdir -p node_modules && cp package.json node_modules/installed.txt ;;
build) mkdir -p app/dist.next && cp app/src/App.tsx app/dist.next/bundle.txt && cp app/index.html app/dist.next/index.html ;;
esac`,
	);
	stub(
		"systemctl",
		`case "$*" in
'--user show --property=WorkingDirectory --value goblin.service')
  if [ "$MODE" = unit ]; then echo 'unit query failed' >&2; exit 33; fi
  printf '%s\\n' "$SERVICE_ROOT" ;;
'--user restart goblin')
  if [ "$MODE" = restart ]; then echo 'restart failed' >&2; exit 34; fi ;;
'--user show goblin.service --property=InvocationID,ExecMainStartTimestampMonotonic --value')
  if [ "$MODE" = floor ]; then echo 'floor failed' >&2; exit 33; fi
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n42000000\n' ;;
'--user show goblin.service --property=Environment --value')
  printf 'GOBLIN_HOME=%s\n' "$HOME/goblin" ;;
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
	if (includePodman)
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
	// The marker's fsyncs are prod-real durability; the hermetic PATH
	// only needs the command to exist.
	stub("sync", "exit 0");
	return bin;
}

// Run the whole shipped script in a real scratch Git checkout. PATH
// contains only approved utilities and fakes — no production service,
// publication, build or SSH can escape the fixture, including on the
// missing-Podman path.
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
	let attempt: string | undefined;
	try {
		const main = join(dir, "main");
		mkdirSync(main);
		git(main, "init", "-q", "-b", "fixture");
		git(main, "config", "user.name", "Deploy fixture");
		git(main, "config", "user.email", "fixture@example.invalid");
		git(main, "config", "core.hooksPath", "/dev/null");
		mkdirSync(join(main, "scripts"));
		copyFileSync(deploySh, join(main, "scripts", "deploy.sh"));
		copyFileSync(join(import.meta.dir, "publish-app.sh"), join(main, "scripts", "publish-app.sh"));
		// Ignored artifact locations so a stub refresh never dirties the
		// tree, plus the sources the stub refresh copies verbatim.
		writeFileSync(join(main, ".gitignore"), "node_modules/\napp/dist*\n");
		writeFileSync(join(main, "package.json"), "deps-A\n");
		mkdirSync(join(main, "app", "src"), { recursive: true });
		writeFileSync(join(main, "app", "index.html"), "<html>fixture</html>\n");
		// The served bundle inlines every "../src/" module app/src
		// imports — deploy.sh derives its rebuild set from these
		// specifiers, so the fixture carries the three the tests exercise.
		writeFileSync(
			join(main, "app", "src", "App.tsx"),
			'import { isMachineryText } from "../../src/tags.ts";\n' +
				'import { artifactOf } from "../../src/agent/tools/artifact-schema.ts";\n' +
				'import type { UiInput } from "../../src/agent/tools/ui-schema.ts";\n',
		);
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
				git(
					repo,
					"rev-parse",
					"--git-path",
					`objects/${corruptRev.slice(0, 2)}/${corruptRev.slice(2)}`,
				),
			);
			chmodSync(object, 0o644);
			writeFileSync(object, "not a compressed Git object\n");
		}
		if (mode === "marker-dir") chmodSync(markerDir, 0o555);
		if (mode === "dirty") writeFileSync(join(repo, "package.json"), "deps-A-dirty\n");
		if (mode === "untracked") writeFileSync(join(repo, "scratch-note.md"), "local scratch\n");
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
		attempt = resolve(repo, git(repo, "rev-parse", "--git-path", "GOBLIN_DEPLOY_INCOMPLETE"));
		if (options.attempt !== undefined) {
			if (options.attempt === "directory") mkdirSync(attempt);
			else if (options.attempt === "dangling") symlinkSync(join(dir, "missing-attempt"), attempt);
			else if (options.attempt === "link") symlinkSync(marker, attempt);
			else {
				writeFileSync(attempt, `${newRev}\n`);
				if (options.attempt === "unreadable") chmodSync(attempt, 0o000);
				if (options.attempt === "unwritable") chmodSync(attempt, 0o444);
			}
		}
		const bin = fakeBin(dir, mode !== "no-podman");
		const callsFile = join(dir, "calls");
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
		if (options.attempt === "unreadable" || options.attempt === "unwritable")
			chmodSync(attempt, 0o600);
		const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [];
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			calls,
			oldRev,
			newRev,
			marker,
			attempt,
			// Captured before cleanup — the fixture dir is gone by the
			// time a test could stat the returned path itself.
			attemptExists: existsSync(attempt),
			markerValue:
				existsSync(marker) && options.marker !== "directory"
					? readFileSync(marker, "utf8").trim()
					: null,
			// Published client state — app/dist is a symlink to a slot dir.
			distTarget: (() => {
				try {
					return readlinkSync(join(repo, "app", "dist"));
				} catch {
					return null;
				}
			})(),
			distBundle: existsSync(join(repo, "app", "dist", "bundle.txt"))
				? readFileSync(join(repo, "app", "dist", "bundle.txt"), "utf8")
				: null,
			stagedExists: existsSync(join(repo, "app", "dist.next")),
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
	// Nothing has mutated yet, so no rollback recipe is printed.
	expect(result.stderr).not.toContain("FAILED");
	expect(result.stderr).not.toContain("git reset --hard");
	expect(
		result.calls.some(
			(call) =>
				call.startsWith("bun ") ||
				/^git (push|fetch|pull)\b/.test(call) ||
				call.includes(" restart "),
		),
	).toBe(false);
}

describe("local deployment preflight", () => {
	for (const [mode, diagnostic] of [
		["mismatch", "does not match checkout"],
		["blank", "no absolute WorkingDirectory"],
		["missing-root", "cannot resolve goblin.service WorkingDirectory"],
		["unit", "cannot read goblin.service WorkingDirectory"],
		["dirty", "tracked files modified"],
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

	test("untracked files are surfaced but do not block deploying HEAD", () => {
		const result = runDeploy([], { mode: "untracked" });
		expect(result.status).toBe(0);
		expect(result.markerValue).toBe(result.newRev);
		expect(result.stdout).toContain("untracked files present — not in HEAD, so not deployed:");
		expect(result.stdout).toContain("scratch-note.md");
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
		expect(result.stdout).not.toContain("rollback:");
		expect(result.stderr).not.toContain("git reset --hard");
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
		// Value-imported into the served bundle by the fixture's App.tsx —
		// each module the client inlines must rebuild it, including a
		// shared module added without touching deploy.sh's trigger set.
		"src/agent/tools/ui-schema.ts",
		"src/agent/tools/artifact-schema.ts",
		"src/tags.ts",
	]) {
		test(`${path} rebuilds the inlined client`, () => {
			const result = runDeploy([path]);
			expect(result.status).toBe(0);
			expect(result.calls).toContain("bun run app:build");
			expect(result.calls.includes("bun install --frozen-lockfile")).toBe(
				["bun.lock", "package.json"].includes(path),
			);
			// Deps sync precedes the gate: the typecheck must run against
			// new_rev's dependency tree, never the deployed one.
			if (result.calls.includes("bun install --frozen-lockfile")) {
				expect(result.calls.indexOf("bun install --frozen-lockfile")).toBeLessThan(
					result.calls.indexOf("bun run typecheck"),
				);
			}
		});
	}

	test("backend-only deployment gates locally without rebuilding or updating remote refs", () => {
		const result = runDeploy(["src/index.ts", "src/http/app-channel.ts"]);
		expect(result.status).toBe(0);
		expect(result.calls.filter((call) => call.startsWith("bun "))).toEqual([
			"bun run typecheck",
			"bun scripts/check-startup.ts --watch 0 75000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42000000",
		]);
		const boundaries = [
			"bun run typecheck",
			// The watcher's floor is read BEFORE the restart — an invocation
			// that predates it can never be accepted.
			"systemctl --user show goblin.service --property=InvocationID,ExecMainStartTimestampMonotonic --value",
			"systemctl --user restart goblin",
			"bun scripts/check-startup.ts --watch 0 75000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42000000",
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

	test("a client build publishes through the atomic slot swap", () => {
		const result = runDeploy(["app/src/App.tsx"]);
		expect(result.status).toBe(0);
		expect(result.calls).toContain("bun run app:build");
		expect(result.distTarget).toMatch(/^dist\.[ab]$/);
		expect(result.distBundle).toBe("fixture change\n");
		expect(result.stagedExists).toBe(false);
	});

	test("rollback restores revision, ignored dependencies/client and marker in order", () => {
		const result = runDeploy(["src/index.ts"]);
		expect(result.status).toBe(0);
		const line = result.stdout.split("\n").find((value) => value.startsWith("deploy: rollback:"));
		expect(line).toBe(
			`deploy: rollback: git reset --hard ${result.oldRev} && bun install --frozen-lockfile && bun run app:build && bash scripts/publish-app.sh && systemctl --user restart goblin && echo ${result.oldRev} > .git/GOBLIN_DEPLOYED_REV && sync .git/GOBLIN_DEPLOYED_REV`,
		);
	});

	test("memory asset changes print a manual runbook without applying it", () => {
		const result = runDeploy(["deploy/memory/healthcheck.py"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("never auto-applied");
		expect(result.calls.filter((call) => call.startsWith("bun "))).toEqual([
			"bun run typecheck",
			"bun scripts/check-startup.ts --watch 0 75000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 42000000",
		]);
		expect(result.calls.filter((call) => call.includes(" restart "))).toEqual([
			"systemctl --user restart goblin",
		]);
	});
});

describe("local deployment failures and memory probe", () => {
	for (const mode of [
		"typecheck",
		"install",
		"build",
		"floor",
		"restart",
		"watch-fail",
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
			// Post-publish failures print recovery without rolling back or
			// clearing the attempt marker.
			expect(result.stderr).toContain("FAILED — the attempt marker stays");
			expect(result.stderr).toContain(
				`git reset --hard ${result.oldRev} && bun install --frozen-lockfile && bun run app:build && bash scripts/publish-app.sh && systemctl --user restart goblin`,
			);
			expect(result.attemptExists).toBe(true);
			if (["typecheck", "install", "build", "restart", "floor"].includes(mode))
				expect(result.stderr).toContain(`${mode} failed`);
			if (mode === "typecheck") {
				// Deps sync precedes the gate (it must read new_rev's tree),
				// so a failed gate may have already installed — but it never
				// builds or restarts.
				expect(result.calls).not.toContain("bun run app:build");
			}
			if (["typecheck", "install", "build", "floor"].includes(mode))
				expect(result.calls).not.toContain("systemctl --user restart goblin");
			if (mode === "watch-fail") {
				// Crash-loop detection lives in the acceptance probe: the failure
				// prints the allowlisted brief and never raw journal bodies.
				expect(result.stderr).toContain("goblin failed startup acceptance after restart");
				expect(result.calls).toContain("bun scripts/check-startup.ts --brief 40");
				expect(result.calls.some((call) => call.startsWith("journalctl"))).toBe(false);
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

	test("a failed first deployment reports failure state with manual recovery", () => {
		const result = runDeploy([], { marker: "missing", mode: "typecheck" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("FAILED — the attempt marker stays");
		expect(result.stderr).toContain("previous deployed revision unknown");
		expect(result.stderr).toContain("GOBLIN_DEPLOYED_REV");
		expect(result.stderr).toContain("GOBLIN_DEPLOY_INCOMPLETE");
		expect(result.stderr).toContain("redeploy from the origin/main baseline");
		expect(result.stderr).not.toContain("git reset --hard");
		expect(result.stderr).not.toContain("rollback:");
	});

	test("a stale marker's post-restart failure keeps the attempt marker and prints manual recovery", () => {
		const result = runDeploy([], { marker: "unknown", mode: "watch-fail" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("FAILED — the attempt marker stays");
		expect(result.stderr).toContain("goblin failed startup acceptance after restart");
		expect(result.stderr).toContain("previous deployed revision unknown");
		expect(result.stderr).toContain("redeploy from the origin/main baseline");
		expect(result.stderr).not.toContain("git reset --hard");
		expect(result.stderr).not.toContain("rollback:");
		expect(result.attemptExists).toBe(true);
	});

	test("a journal read failure warns but the deploy and marker still land", () => {
		const result = runDeploy(["package.json"], { mode: "journal" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("journal failed");
		expect(result.stderr).toContain("could not read the fresh journal");
		expect(result.markerValue).toBe(result.newRev);
		expect(result.attemptExists).toBe(false);
		expect(result.stdout).toContain("done: g7");
	});

	test("fresh journal errors are visible warnings, not hidden or a read failure", () => {
		const result = runDeploy([], { mode: "journal-errors" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("WARNING — error lines in the fresh journal");
		expect(result.stderr).toContain("fixture error");
	});
});

describe("deployment attempt marker", () => {
	for (const form of ["directory", "dangling", "link", "unreadable", "unwritable"] as const) {
		test(`a ${form} attempt marker fails loudly before any deployment side effects`, () => {
			expectPreflightFailure(runDeploy([], { attempt: form }), "attempt marker");
		});
	}

	test("a leftover attempt marker forces dependency and client refresh despite a clean diff", () => {
		const result = runDeploy(["src/index.ts"], { attempt: "regular" });
		expect(result.status).toBe(0);
		expect(result.calls).toContain("bun install --frozen-lockfile");
		expect(result.calls).toContain("bun run app:build");
		expect(result.markerValue).toBe(result.newRev);
		expect(result.attemptExists).toBe(false);
	});

	test("a linked worktree resolves the attempt marker inside its own gitdir", () => {
		const result = runDeploy(["src/index.ts"], { linked: true, attempt: "regular" });
		expect(result.status).toBe(0);
		expect(result.attempt).toContain("/.git/worktrees/");
		expect(result.calls).toContain("bun install --frozen-lockfile");
		expect(result.calls).toContain("bun run app:build");
		expect(result.attemptExists).toBe(false);
	});
});

// A→B→C on ONE scratch checkout: markers and artifacts persist between
// runs — the interrupted middle deploy's leftover marker, never the
// source diff, is what forces the retry's dependency and client refresh.
function deploySequence() {
	const dir = mkdtempSync(join(tmpdir(), "goblin-deploy-seq-"));
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
	const repo = join(dir, "main");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "fixture");
	git(repo, "config", "user.name", "Deploy fixture");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "core.hooksPath", "/dev/null");
	mkdirSync(join(repo, "scripts"));
	mkdirSync(join(repo, "app", "src"), { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	copyFileSync(deploySh, join(repo, "scripts", "deploy.sh"));
	copyFileSync(join(import.meta.dir, "publish-app.sh"), join(repo, "scripts", "publish-app.sh"));
	writeFileSync(join(repo, ".gitignore"), "node_modules/\napp/dist*\n");
	writeFileSync(join(repo, "package.json"), "deps-A\n");
	writeFileSync(join(repo, "app", "index.html"), "<html>fixture</html>\n");
	writeFileSync(join(repo, "app", "src", "App.tsx"), "app-A\n");
	writeFileSync(join(repo, "src", "index.ts"), "backend-A\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "deployment A");
	const bin = fakeBin(dir);
	const callsFile = join(dir, "calls");
	return {
		repo,
		marker: resolve(repo, git(repo, "rev-parse", "--git-path", "GOBLIN_DEPLOYED_REV")),
		attempt: resolve(repo, git(repo, "rev-parse", "--git-path", "GOBLIN_DEPLOY_INCOMPLETE")),
		head: () => git(repo, "rev-parse", "HEAD"),
		commit(changes: Record<string, string>) {
			for (const [path, content] of Object.entries(changes)) {
				mkdirSync(dirname(join(repo, path)), { recursive: true });
				writeFileSync(join(repo, path), content);
			}
			git(repo, "add", ".");
			git(repo, "commit", "-qm", "sequence deployment");
		},
		run(mode: string) {
			rmSync(callsFile, { force: true });
			const result = spawnSync("/bin/bash", [join(repo, "scripts", "deploy.sh")], {
				cwd: home,
				env: {
					...env,
					PATH: bin,
					MODE: mode,
					CALLS: callsFile,
					REAL_GIT: realGit,
					SERVICE_ROOT: repo,
				},
				encoding: "utf8",
				timeout: 10_000,
			});
			if (result.error) throw result.error;
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [],
			};
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("interrupted deploy forces a refresh on retry", () => {
	test("A→B→C: verification failure leaves the marker; retry rebuilds to source artifacts", () => {
		const f = deploySequence();
		try {
			// A: the baseline deploy lands A's artifacts and clears nothing.
			let run = f.run("healthy");
			expect(run.status).toBe(0);
			const revA = readFileSync(f.marker, "utf8").trim();
			expect(existsSync(f.attempt)).toBe(false);
			expect(readFileSync(join(f.repo, "app", "dist", "bundle.txt"), "utf8")).toBe("app-A\n");
			expect(readFileSync(join(f.repo, "node_modules", "installed.txt"), "utf8")).toBe("deps-A\n");

			// B: deps+app move and build B's artifacts, then verification
			// fails — the successful marker stays on A while the attempt
			// marker records B's interrupted revision.
			f.commit({ "package.json": "deps-B\n", "app/src/App.tsx": "app-B\n" });
			run = f.run("unhealthy");
			expect(run.status).not.toBe(0);
			expect(run.calls).toContain("bun install --frozen-lockfile");
			expect(run.calls).toContain("bun run app:build");
			expect(readFileSync(f.attempt, "utf8").trim()).toBe(f.head());
			expect(readFileSync(f.marker, "utf8").trim()).toBe(revA);
			expect(readFileSync(join(f.repo, "app", "dist", "bundle.txt"), "utf8")).toBe("app-B\n");
			expect(readFileSync(join(f.repo, "node_modules", "installed.txt"), "utf8")).toBe("deps-B\n");

			// C: dep/app source bytes return to A's, so the A→C diff is
			// backend-only. The leftover marker, not the diff, must force
			// reinstall/rebuild back to the deployed source's artifacts —
			// then the marker clears only after full verification.
			f.commit({
				"package.json": "deps-A\n",
				"app/src/App.tsx": "app-A\n",
				"src/index.ts": "backend-C\n",
			});
			run = f.run("healthy");
			expect(run.status).toBe(0);
			expect(run.calls).toContain("bun install --frozen-lockfile");
			expect(run.calls).toContain("bun run app:build");
			expect(readFileSync(join(f.repo, "app", "dist", "bundle.txt"), "utf8")).toBe("app-A\n");
			expect(readFileSync(join(f.repo, "node_modules", "installed.txt"), "utf8")).toBe("deps-A\n");
			expect(existsSync(f.attempt)).toBe(false);
			expect(readFileSync(f.marker, "utf8").trim()).toBe(f.head());
		} finally {
			f.cleanup();
		}
	});

	// Whether the break is the dependency install or the client build,
	// B's attempt marker outlives the failure while the successful
	// marker stays on A; the clean retry refreshes on the marker, not
	// the diff.
	for (const mode of ["install", "build"] as const) {
		test(`a failed ${mode} leaves the marker; the clean retry clears it`, () => {
			const f = deploySequence();
			try {
				expect(f.run("healthy").status).toBe(0);
				const revA = readFileSync(f.marker, "utf8").trim();
				f.commit({ "package.json": "deps-B\n", "app/src/App.tsx": "app-B\n" });
				const failed = f.run(mode);
				expect(failed.status).not.toBe(0);
				expect(readFileSync(f.attempt, "utf8").trim()).toBe(f.head());
				expect(readFileSync(f.marker, "utf8").trim()).toBe(revA);
				f.commit({
					"package.json": "deps-A\n",
					"app/src/App.tsx": "app-A\n",
					"src/index.ts": "backend-C\n",
				});
				const retried = f.run("healthy");
				expect(retried.status).toBe(0);
				expect(retried.calls).toContain("bun install --frozen-lockfile");
				expect(retried.calls).toContain("bun run app:build");
				expect(existsSync(f.attempt)).toBe(false);
				expect(readFileSync(f.marker, "utf8").trim()).toBe(f.head());
			} finally {
				f.cleanup();
			}
		});
	}
});

test("shipped CI gates merges on the test suite", () => {
	const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
	expect(ci).toMatch(/run:\s*bun test\b/);
});
