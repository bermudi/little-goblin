// Release-directory deployment (scripts/release.ts, design/deploy.md).
//
// Only the process boundary is faked: `bun`, `systemctl` and `journalctl` are
// PATH fixtures that record what they were asked to do. Everything the tool
// reasons about — the git archive, the extracted release tree, the symlink
// flip, the unit rewrite, the durable marker — is real. The fixture checkout
// is this repository at HEAD, read-only, so the archive under test is the code
// a real deploy would ship.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "../src/testkit.ts";
import { isCompleteRelease, isRev, layoutFrom, parseArgs, parseUnit, readLive, releaseDir, rewriteWorkingDirectory } from "./release.ts";

const REPO = resolve(import.meta.dir, "..");
const BUN = process.execPath;

interface Box {
	root: string;
	releases: string;
	live: string;
	unit: string;
	bin: string;
	home: string;
	log: string;
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
        mkdir -p app/dist.next/assets
        echo '<html>fake</html>' > app/dist.next/index.html
        echo 'js' > app/dist.next/assets/index.js
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
	const result = spawnSync(BUN, [join(REPO, "scripts", "release.ts"), ...args], {
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
	return readFileSync(box.log, "utf8").split("\n").filter((line) => line !== "");
}

function headRev(): string {
	return spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function liveTarget(box: Box): string | null {
	try {
		return readLive(layoutFrom({ GOBLIN_RELEASES_ROOT: box.releases, GOBLIN_LIVE_LINK: box.live, GOBLIN_UNIT_FILE: box.unit }, box.root))?.rev ?? null;
	} catch {
		return null;
	}
}

describe("release build", () => {
	test("--build-only makes a complete private release and touches nothing live", () => {
		const box = makeBox();
		const rev = headRev();
		const result = release(box, ["--build-only"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`built ${rev} at ${releaseDir(layoutFrom({ GOBLIN_RELEASES_ROOT: box.releases }), rev)}`);
		const dir = join(box.releases, rev);
		expect(readFileSync(join(dir, ".release-complete"), "utf8").trim()).toBe(rev);
		// The release is exactly the tracked tree at that commit: every path git
		// reports is present, and the untracked files of the dev tree (this new
		// script among them, before it was committed) are not.
		const tracked = spawnSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", rev], { encoding: "utf8" })
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
	});

	test("a second build of the same rev is a no-op", () => {
		const box = makeBox();
		expect(release(box, ["--build-only"]).status).toBe(0);
		const builds = calls(box).filter((line) => line.startsWith("bun install")).length;
		const second = release(box, ["--build-only"]);
		expect(second.status).toBe(0);
		expect(second.stderr).toContain("already built");
		expect(calls(box).filter((line) => line.startsWith("bun install")).length).toBe(builds);
	});

	test("a failed typecheck leaves the staging directory and flips nothing", () => {
		const box = makeBox();
		const result = release(box, ["--build-only"], { FAKE_TYPECHECK_FAIL: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("typecheck failed");
		const staging = readdirSync(box.releases).filter((name) => name.startsWith(".staging."));
		expect(staging.length).toBe(1);
		// Left for inspection, deliberately not deleted — and not addressable.
		expect(readdirSync(box.releases).some((name) => isRev(name))).toBe(false);
	});
});

describe("rollout", () => {
	test("refuses while the unit still runs the in-place tree", () => {
		const box = makeBox();
		const result = release(box, []);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--adopt-unit");
		expect(calls(box).some((line) => line.includes("restart"))).toBe(false);
	});

	test("--adopt-unit cuts over: builds, flips, rewrites only WorkingDirectory, restarts, annotates", () => {
		const box = makeBox();
		const rev = headRev();
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
		expect(recorded.some((line) => line.includes("/scripts/check-startup.ts --watch 0 75000"))).toBe(true);
		const annotations = readFileSync(join(box.home, "state", "goblin.log"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { msg: string; rev: string; level: string });
		expect(annotations.map((entry) => entry.msg)).toEqual([
			"deploy restarting goblin",
			"deploy restart accepted — goblin live at deployed rev",
		]);
		expect(annotations.every((entry) => entry.rev === rev && entry.level === "info")).toBe(true);
	});

	test("a rollout flips to another rev and prints the rollback for the one it replaced", () => {
		const box = makeBox();
		expect(release(box, ["--adopt-unit"]).status).toBe(0);
		const first = headRev();
		const older = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
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
	});

	test("rollback refuses a rev that has no complete release", () => {
		const box = makeBox();
		expect(release(box, ["--adopt-unit"]).status).toBe(0);
		const before = calls(box).filter((line) => line === "systemctl --user restart goblin").length;
		// A real commit that was never built into a release here.
		const unbuilt = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD~2"], { encoding: "utf8" }).stdout.trim();
		const result = release(box, ["--rollback", unbuilt]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no complete release");
		expect(calls(box).filter((line) => line === "systemctl --user restart goblin").length).toBe(before);
	});

	test("a failed acceptance fails the rollout without rolling back on its own", () => {
		const box = makeBox();
		expect(release(box, ["--adopt-unit"]).status).toBe(0);
		const older = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
		const result = release(box, ["--rev", "HEAD~1"], { FAKE_ACCEPT_FAIL: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("startup acceptance failed");
		// The flip happened and stays: recovery is an explicit operator action.
		expect(liveTarget(box)).toBe(older);
		expect(result.stdout).toBe("");
	});
});

describe("status", () => {
	test("reports what is live, whether the unit matches, and restarts still pending", async () => {
		const box = makeBox();
		expect(release(box, ["--adopt-unit"]).status).toBe(0);
		const first = headRev();
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
	});
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
		expect(facts.environment).toEqual({ GOBLIN_HOME: "/home/daniel/goblin", PATH: "/usr/bin:/bin" });
	});

	test("refuses ambiguity instead of guessing", () => {
		expect(() => parseUnit(`${base}WorkingDirectory=/elsewhere\n`)).toThrow(/exactly one WorkingDirectory/);
		expect(() => parseUnit("WorkingDirectory=relative/path\nExecStart=/usr/bin/bun run x.ts\n")).toThrow(/not absolute/);
		expect(() => parseUnit("WorkingDirectory=/x\nExecStart=bun run x.ts\n")).toThrow(/absolute binary/);
		expect(() => parseUnit("Environment=GOBLIN_HOME=/x\nExecStart=/usr/bin/bun run x.ts\n")).toThrow(
			/exactly one WorkingDirectory/,
		);
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
		mkdirSync(dir, { recursive: true });
		expect(isCompleteRelease(dir, rev)).toBe(false);
		writeFileSync(join(dir, ".release-complete"), `${rev}\n`);
		expect(isCompleteRelease(dir, rev)).toBe(true);
		// A marker for a different commit never counts as this one.
		expect(isCompleteRelease(dir, "b".repeat(40))).toBe(false);
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
