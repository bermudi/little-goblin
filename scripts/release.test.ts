// Release-directory deployment (scripts/release.ts, design/deploy.md).
//
// Only the process boundary is faked: `bun`, `systemctl` and `journalctl` are
// PATH fixtures that record what they were asked to do. Everything the tool
// reasons about — the git archive, the extracted release tree, the symlink
// flip, the unit rewrite, the durable marker — is real. The history under
// test is a fixture repository the tests build themselves (three commits),
// so HEAD~1 and HEAD~2 resolve no matter how shallow the outer checkout is
// (CI uses fetch-depth: 1). The real scripts/release.ts is copied into the
// fixture because the tool discovers its repo as the tree the script itself
// lives in; its ../src/durable.ts and zod imports resolve through untracked
// symlinks, so the archive stays exactly the fixture's committed tree.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "../src/testkit.ts";
import {
	isCompleteRelease,
	isRev,
	layoutFrom,
	parseArgs,
	parseUnit,
	readLive,
	releaseDir,
	rewriteWorkingDirectory,
} from "./release.ts";

const REPO = resolve(import.meta.dir, "..");
const BUN = process.execPath;
// Each release() is a real bun, git and tar run; a cold CI runner takes about 5s for one.
const RELEASE_TEST_TIMEOUT_MS = 30_000;

// The fixture repository: three commits so HEAD~1 and HEAD~2 name older,
// distinct revs, whatever the outer clone's depth. Built lazily per test —
// testkit's afterEach removes tracked temp dirs, so a fixture cannot outlive
// its test — and read-only afterwards.
function fixtureRepo(box: Box): string {
	if (box.repo !== null) return box.repo;
	const dir = tmpDir("goblin-release-history-");
	const git = (args: string[]): void => {
		const result = spawnSync(
			"git",
			[
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@invalid",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: dir, encoding: "utf8" },
		);
		if (result.status !== 0) {
			throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
		}
	};
	git(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "bun.lock"), "{}\n");
	writeFileSync(join(dir, "package.json"), "{}\n");
	// Resolution seams for the copied tool — untracked, so never archived.
	mkdirSync(join(dir, "src"));
	symlinkSync(join(REPO, "src", "durable.ts"), join(dir, "src", "durable.ts"));
	symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
	// Completeness shape only (REQUIRED_IN_RELEASE): nothing executes the
	// archived tree, the build steps are fakes — the tool under test is the
	// scripts/release.ts copy, which is the real current file.
	writeFileSync(join(dir, "src", "index.ts"), "// fixture tree, never executed\n");
	mkdirSync(join(dir, "scripts"));
	copyFileSync(join(REPO, "scripts", "release.ts"), join(dir, "scripts", "release.ts"));
	mkdirSync(join(dir, "content"));
	let made = 0;
	for (const step of [31, 15, 15]) {
		for (let i = 0; i < step; i++) {
			made += 1;
			writeFileSync(
				join(dir, "content", `file-${String(made).padStart(3, "0")}.txt`),
				`content file ${made}\n`,
			);
		}
		git(["add", "bun.lock", "package.json", "src/index.ts", "scripts", "content"]);
		git(["commit", "-q", "-m", `fixture history, ${made} content files`]);
	}
	box.repo = dir;
	return dir;
}

interface Box {
	root: string;
	releases: string;
	live: string;
	unit: string;
	bin: string;
	home: string;
	log: string;
	// The fixture repository, built on first use (testkit's afterEach removes
	// tracked temp dirs, so it cannot outlive one test).
	repo: string | null;
}

function unitText(box: Box, workingDirectory: string): string {
	return `[Unit]
Description=goblin release fixture

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
Environment=GOBLIN_HOME=${box.home}
Environment=PATH=/usr/bin:/bin
ExecStart=${box.bin}/bun run src/index.ts
KillSignal=SIGTERM
Restart=on-failure
`;
}

function makeBox(): Box {
	const root = tmpDir("goblin-release-");
	const box: Box = {
		root,
		releases: join(root, "releases"),
		live: join(root, "releases", "live"),
		unit: join(root, "goblin.service"),
		bin: join(root, "bin"),
		home: join(root, "home"),
		log: join(root, "calls.log"),
		repo: null,
	};
	mkdirSync(box.bin);
	mkdirSync(join(box.home, "state"), { recursive: true });
	writeFileSync(box.unit, unitText(box, REPO), { mode: 0o644 });
	writeFileSync(box.log, "");
	// Build steps are the fakes' whole job — the release's real content comes
	// from `git archive`, so a wrong archive would still be caught (the marker
	// records the rev, and the extracted tree is inspected below).
	writeFileSync(
		join(box.bin, "bun"),
		`#!/usr/bin/env bash
set -u
echo "bun $*" >> "${box.log}"
case "\${1:-}" in
  install) mkdir -p node_modules; : > node_modules/.installed; exit 0 ;;
  run)
    case "\${2:-}" in
      typecheck) if [ -n "\${FAKE_TYPECHECK_FAIL:-}" ]; then echo "fake tsc: bad" >&2; exit 3; fi; exit 0 ;;
      app:build)
        mkdir -p app/dist/assets
        echo '<html>fake</html>' > app/dist/index.html
        echo 'js' > app/dist/assets/index.js
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
  --no-install) exit 0 ;;
  */check-startup.ts)
    if [ -n "\${FAKE_ACCEPT_FAIL:-}" ]; then echo "fake: no startup evidence" >&2; exit 4; fi
    echo "startup accepted (fake)" >&2; exit 0 ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(box.bin, "systemctl"),
		`#!/usr/bin/env bash
echo "systemctl $*" >> "${box.log}"
case "$*" in
  *--property=InvocationID*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n12345\\n' ;;
  *--property=MainPID*) printf '%s\\n' "\${FAKE_MAINPID:-0}" ;;
  *--property=LoadState*) printf 'not-found\\n' ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(box.bin, "journalctl"),
		`#!/usr/bin/env bash
echo "journalctl $*" >> "${box.log}"
exit 0
`,
		{ mode: 0o755 },
	);
	for (const name of ["bun", "systemctl", "journalctl"]) chmodSync(join(box.bin, name), 0o755);
	return box;
}

interface Result {
	status: number | null;
	stdout: string;
	stderr: string;
}

function release(box: Box, args: string[], extraEnv: Record<string, string> = {}): Result {
	const result = spawnSync(BUN, [join(fixtureRepo(box), "scripts", "release.ts"), ...args], {
		cwd: box.root,
		encoding: "utf8",
		// git and tar stay real; only the process boundary is faked. The fake
		// bin sits first so the unit's ExecStart and any PATH lookup agree.
		env: {
			...process.env,
			PATH: `${box.bin}:${process.env.PATH ?? ""}`,
			GOBLIN_RELEASES_ROOT: box.releases,
			GOBLIN_LIVE_LINK: box.live,
			GOBLIN_UNIT_FILE: box.unit,
			FAKE_LOG: box.log,
			...extraEnv,
		},
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function calls(box: Box): string[] {
	return readFileSync(box.log, "utf8")
		.split("\n")
		.filter((line) => line !== "");
}

function headRev(box: Box): string {
	return spawnSync("git", ["-C", fixtureRepo(box), "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).stdout.trim();
}

function liveTarget(box: Box): string | null {
	try {
		return (
			readLive(
				layoutFrom(
					{
						GOBLIN_RELEASES_ROOT: box.releases,
						GOBLIN_LIVE_LINK: box.live,
						GOBLIN_UNIT_FILE: box.unit,
					},
					box.root,
				),
			)?.rev ?? null
		);
	} catch {
		return null;
	}
}

describe("release build", () => {
	test(
		"--build-only makes a complete private release and touches nothing live",
		() => {
			const box = makeBox();
			const rev = headRev(box);
			const result = release(box, ["--build-only"]);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(
				`built ${rev} at ${releaseDir(layoutFrom({ GOBLIN_RELEASES_ROOT: box.releases }), rev)}`,
			);
			const dir = join(box.releases, rev);
			expect(readFileSync(join(dir, ".release-complete"), "utf8").trim()).toBe(rev);
			// The release is exactly the tracked tree at that commit: every path git
			// reports is present, and the fixture's untracked resolution symlinks
			// (src/durable.ts, node_modules) are not.
			const tracked = spawnSync(
				"git",
				["-C", fixtureRepo(box), "ls-tree", "-r", "--name-only", rev],
				{ encoding: "utf8" },
			)
				.stdout.trim()
				.split("\n");
			expect(tracked.length).toBeGreaterThan(50);
			for (const path of tracked) expect(existsSync(join(dir, path))).toBe(true);
			expect(existsSync(join(dir, ".git"))).toBe(false);
			expect(existsSync(join(dir, "app", "dist", "index.html"))).toBe(true);
			expect(existsSync(join(dir, "node_modules", ".installed"))).toBe(true);
			// Nothing addressable, nothing restarted.
			expect(existsSync(box.live)).toBe(false);
			expect(calls(box).some((line) => line.includes("restart"))).toBe(false);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"a second build of the same rev is a no-op",
		() => {
			const box = makeBox();
			expect(release(box, ["--build-only"]).status).toBe(0);
			const builds = calls(box).filter((line) => line.startsWith("bun install")).length;
			const second = release(box, ["--build-only"]);
			expect(second.status).toBe(0);
			expect(second.stderr).toContain("already built");
			expect(calls(box).filter((line) => line.startsWith("bun install")).length).toBe(builds);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"a failed typecheck leaves the staging directory and flips nothing",
		() => {
			const box = makeBox();
			const result = release(box, ["--build-only"], { FAKE_TYPECHECK_FAIL: "1" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("typecheck failed");
			const staging = readdirSync(box.releases).filter((name) => name.startsWith(".staging."));
			expect(staging.length).toBe(1);
			// Left for inspection, deliberately not deleted — and not addressable.
			expect(readdirSync(box.releases).some((name) => isRev(name))).toBe(false);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);
});

describe("rollout", () => {
	test(
		"refuses while the unit still runs the in-place tree",
		() => {
			const box = makeBox();
			const result = release(box, []);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("--adopt-unit");
			expect(calls(box).some((line) => line.includes("restart"))).toBe(false);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"a symlinked unit still rolls out, and --adopt-unit refuses to write through it",
		() => {
			const adopted = makeBox();
			expect(release(adopted, ["--adopt-unit"]).status).toBe(0);
			const target = `${adopted.unit}.target`;
			renameSync(adopted.unit, target);
			symlinkSync(target, adopted.unit);
			const rolled = release(adopted, ["--status"]);
			expect(rolled.status).toBe(0);
			expect(rolled.stdout).toContain("(release layout)");
			expect(release(adopted, []).status).toBe(0);
			expect(lstatSync(adopted.unit).isSymbolicLink()).toBe(true);

			const fresh = makeBox();
			const freshTarget = `${fresh.unit}.target`;
			renameSync(fresh.unit, freshTarget);
			symlinkSync(freshTarget, fresh.unit);
			const before = readFileSync(freshTarget, "utf8");
			const refused = release(fresh, ["--adopt-unit"]);
			expect(refused.status).toBe(1);
			expect(refused.stderr).toContain("is a symlink");
			expect(lstatSync(fresh.unit).isSymbolicLink()).toBe(true);
			expect(readFileSync(freshTarget, "utf8")).toBe(before);
			expect(existsSync(fresh.live)).toBe(false);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"--adopt-unit cuts over: builds, flips, rewrites only WorkingDirectory, restarts, annotates",
		() => {
			const box = makeBox();
			const rev = headRev(box);
			const result = release(box, ["--adopt-unit"]);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(`adopted release layout and deployed ${rev}`);
			expect(liveTarget(box)).toBe(rev);
			const unit = readFileSync(box.unit, "utf8");
			expect(unit).toContain(`WorkingDirectory=${box.live}`);
			// Value rewritten, every other line preserved verbatim.
			expect(unit).toContain(`Environment=GOBLIN_HOME=${box.home}`);
			expect(unit).toContain(`ExecStart=${box.bin}/bun run src/index.ts`);
			expect(unit).toContain("KillSignal=SIGTERM");
			expect(statSync(box.unit).mode & 0o777).toBe(0o644);
			const recorded = calls(box);
			expect(recorded.some((line) => line === "systemctl --user daemon-reload")).toBe(true);
			expect(recorded.some((line) => line === "systemctl --user restart goblin")).toBe(true);
			expect(
				recorded.some((line) => line.includes("/scripts/check-startup.ts --watch 0 75000")),
			).toBe(true);
			const annotations = readFileSync(join(box.home, "state", "goblin.log"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { msg: string; rev: string; level: string });
			expect(annotations.map((entry) => entry.msg)).toEqual([
				"deploy restarting goblin",
				"deploy restart accepted — goblin live at deployed rev",
			]);
			expect(annotations.every((entry) => entry.rev === rev && entry.level === "info")).toBe(true);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"a rollout flips to another rev and prints the rollback for the one it replaced",
		() => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			const first = headRev(box);
			const older = spawnSync("git", ["-C", fixtureRepo(box), "rev-parse", "HEAD~1"], {
				encoding: "utf8",
			}).stdout.trim();
			const result = release(box, ["--rev", "HEAD~1"]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`deployed ${older}`);
			expect(result.stdout).toContain(`rollback: bun scripts/release.ts --rollback ${first}`);
			expect(liveTarget(box)).toBe(older);
			// The replaced release is still whole: rollback rebuilds nothing.
			expect(isCompleteRelease(join(box.releases, first), first)).toBe(true);
			const back = release(box, ["--rollback", first]);
			expect(back.status).toBe(0);
			expect(back.stdout.trim()).toBe(`rolled back to ${first}`);
			expect(liveTarget(box)).toBe(first);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"rollback refuses a rev that has no complete release",
		() => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			const before = calls(box).filter((line) => line === "systemctl --user restart goblin").length;
			// A real commit that was never built into a release here.
			const unbuilt = spawnSync("git", ["-C", fixtureRepo(box), "rev-parse", "HEAD~2"], {
				encoding: "utf8",
			}).stdout.trim();
			const result = release(box, ["--rollback", unbuilt]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("no complete release");
			expect(calls(box).filter((line) => line === "systemctl --user restart goblin").length).toBe(
				before,
			);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"a failed acceptance fails the rollout without rolling back on its own",
		() => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			const first = headRev(box);
			const older = spawnSync("git", ["-C", fixtureRepo(box), "rev-parse", "HEAD~1"], {
				encoding: "utf8",
			}).stdout.trim();
			const result = release(box, ["--rev", "HEAD~1"], { FAKE_ACCEPT_FAIL: "1" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("startup acceptance failed");
			// The flip happened and stays: recovery is an explicit operator action —
			// but the command for it is printed, not left to memory.
			expect(liveTarget(box)).toBe(older);
			expect(result.stderr).toContain(`recover with: bun scripts/release.ts --rollback ${first}`);
			expect(result.stdout).toBe("");
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"rollback needs no git object: a kept release is self-contained",
		() => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			// A release whose commit git cannot resolve (pruned by a rebase or gc).
			// Rolling back to it must work from the directory alone.
			const orphan = "d".repeat(40);
			const dir = join(box.releases, orphan);
			for (const path of ["src", "app/dist", "node_modules"])
				mkdirSync(join(dir, path), { recursive: true });
			for (const path of ["package.json", "bun.lock", "src/index.ts", "app/dist/index.html"])
				writeFileSync(join(dir, path), "");
			writeFileSync(join(dir, ".release-complete"), `${orphan}\n`);
			const result = release(box, ["--rollback", orphan]);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(`rolled back to ${orphan}`);
			expect(liveTarget(box)).toBe(orphan);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);

	test(
		"rollback refuses a release whose tree is gone",
		() => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			const gutted = join(box.releases, headRev(box));
			renameSync(join(gutted, "node_modules"), join(gutted, "node_modules.gone"));
			const before = calls(box).filter((line) => line === "systemctl --user restart goblin").length;
			const result = release(box, ["--rollback", headRev(box)]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("no complete release");
			expect(calls(box).filter((line) => line === "systemctl --user restart goblin").length).toBe(
				before,
			);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);
});

describe("status", () => {
	test(
		"reports what is live, whether the unit matches, and restarts still pending",
		async () => {
			const box = makeBox();
			expect(release(box, ["--adopt-unit"]).status).toBe(0);
			const first = headRev(box);
			expect(release(box, ["--rev", "HEAD~1"]).status).toBe(0);
			// A process still sitting in the older release: the flip happened, the
			// restart did not. That is the one inconsistency this layout can hold.
			const sleeper = Bun.spawn(["sleep", "5"], { cwd: join(box.releases, first) });
			const result = release(box, ["--status"], { FAKE_MAINPID: String(sleeper.pid) });
			await sleeper.kill();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`live: ${box.releases}/`);
			expect(result.stdout).toContain("(release layout)");
			expect(result.stdout).toContain("releases: 2");
			expect(result.stdout).toContain("*live*");
			expect(result.stdout).toContain(`running: ${first.slice(0, 7)} (restart pending)`);
		},
		RELEASE_TEST_TIMEOUT_MS,
	);
});

describe("unit parsing", () => {
	const base = `WorkingDirectory=/home/daniel/build/little-goblin
Environment=GOBLIN_HOME=/home/daniel/goblin
Environment=PATH=/usr/bin:/bin
ExecStart=/usr/bin/bun run src/index.ts
`;

	test("reads the directory, the bun and the environment", () => {
		const facts = parseUnit(base);
		expect(facts.workingDirectory).toBe("/home/daniel/build/little-goblin");
		expect(facts.execStart).toEqual(["/usr/bin/bun", "run", "src/index.ts"]);
		expect(facts.environment).toEqual({
			GOBLIN_HOME: "/home/daniel/goblin",
			PATH: "/usr/bin:/bin",
		});
	});

	test("refuses ambiguity instead of guessing", () => {
		expect(() => parseUnit(`${base}WorkingDirectory=/elsewhere\n`)).toThrow(
			/exactly one WorkingDirectory/,
		);
		expect(() =>
			parseUnit("WorkingDirectory=relative/path\nExecStart=/usr/bin/bun run x.ts\n"),
		).toThrow(/not absolute/);
		expect(() => parseUnit("WorkingDirectory=/x\nExecStart=bun run x.ts\n")).toThrow(
			/absolute binary/,
		);
		expect(() =>
			parseUnit("Environment=GOBLIN_HOME=/x\nExecStart=/usr/bin/bun run x.ts\n"),
		).toThrow(/exactly one WorkingDirectory/);
	});

	test("rewrites exactly one line and leaves the rest byte-identical", () => {
		const rewritten = rewriteWorkingDirectory(base, "/home/daniel/goblin-releases/live");
		const lines = rewritten.split("\n");
		expect(lines[0]).toBe("WorkingDirectory=/home/daniel/goblin-releases/live");
		expect(lines.slice(1).join("\n")).toBe(base.split("\n").slice(1).join("\n"));
	});
});

describe("layout invariants", () => {
	test("readLive rejects a link that does not name a release", () => {
		const root = tmpDir("goblin-release-");
		const layout = layoutFrom({ GOBLIN_RELEASES_ROOT: root }, root);
		mkdirSync(root, { recursive: true });
		Bun.spawnSync(["ln", "-s", "/somewhere/else", layout.live]);
		expect(() => readLive(layout)).toThrow(/not a release directory/);
		expect(readLive(layoutFrom({ GOBLIN_RELEASES_ROOT: join(root, "empty") }))).toBeNull();
	});

	test("a release directory without the completion marker is not complete", () => {
		const root = tmpDir("goblin-release-");
		const rev = "a".repeat(40);
		const dir = join(root, rev);
		for (const path of ["src", "app/dist", "node_modules"])
			mkdirSync(join(dir, path), { recursive: true });
		for (const path of ["src/index.ts", "app/dist/index.html", "package.json", "bun.lock"])
			writeFileSync(join(dir, path), "");
		expect(isCompleteRelease(dir, rev)).toBe(false);
		writeFileSync(join(dir, ".release-complete"), `${rev}\n`);
		expect(isCompleteRelease(dir, rev)).toBe(true);
		// A marker for a different commit never counts as this one.
		expect(isCompleteRelease(dir, "b".repeat(40))).toBe(false);
	});

	test("a marker alone does not make a gutted release deployable", () => {
		const root = tmpDir("goblin-release-");
		const rev = "c".repeat(40);
		const dir = join(root, rev);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".release-complete"), `${rev}\n`);
		// The builder finished once, but the tree it would serve is gone.
		expect(isCompleteRelease(dir, rev)).toBe(false);
	});

	test("the CLI refuses to guess", () => {
		expect(parseArgs([])).toEqual({ kind: "rollout", rev: null });
		expect(parseArgs(["--rev", "HEAD"])).toEqual({ kind: "rollout", rev: "HEAD" });
		expect(parseArgs(["--status"])).toEqual({ kind: "status" });
		expect(() => parseArgs(["--rev"])).toThrow(/needs a rev/);
		expect(() => parseArgs(["--rollback"])).toThrow(/needs a rev/);
		expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
	});
});
