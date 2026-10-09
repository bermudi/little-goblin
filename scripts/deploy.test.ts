import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy.sh's remote step, run for real with its external boundaries
// (git, bun, systemctl, journalctl) stubbed on PATH and HOME pointed at
// a scratch dir — the same fake-the-edge discipline as the agent tests.
// The REMOTE heredoc is extracted from the script, so the shipped text
// is what's exercised.

const deploySh = join(import.meta.dir, "deploy.sh");

function remoteScript(): string {
	const lines = readFileSync(deploySh, "utf8").split("\n");
	const start = lines.findIndex((l) => l.endsWith("<<'REMOTE'"));
	const end = lines.indexOf("REMOTE");
	if (start < 0 || end < start)
		throw new Error("deploy.sh: REMOTE heredoc not found — layout changed?");
	return `${lines.slice(start + 1, end).join("\n")}\n`;
}

type RemoteRun = {
	status: number | null;
	stdout: string;
	stderr: string;
	bun: string[];
	systemctl: string[];
};

function runRemote(changed: string[]): RemoteRun {
	const oldRev = `o${"0".repeat(39)}`;
	const newRev = `n${"1".repeat(39)}`;
	const dir = mkdtempSync(join(tmpdir(), "goblin-deploy-test-"));
	try {
		const home = join(dir, "home");
		mkdirSync(join(home, "build", "little-goblin"), { recursive: true });
		const bin = join(dir, "bin");
		mkdirSync(bin);

		const log = {
			bun: join(dir, "bun.calls"),
			systemctl: join(dir, "systemctl.calls"),
		};
		const fakeHead = join(dir, "head");
		writeFileSync(fakeHead, `${oldRev}\n`);
		const fakeDiff = join(dir, "diff");
		writeFileSync(fakeDiff, changed.length > 0 ? `${changed.join("\n")}\n` : "");

		const stub = (name: string, body: string): void => {
			const path = join(bin, name);
			writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
			chmodSync(path, 0o755);
		};
		stub(
			"git",
			[
				'echo "git $*" >> "$GIT_CALLS"',
				'case "$1 $2" in',
				'	"rev-parse HEAD") cat "$FAKE_HEAD" ;;',
				'	"status --porcelain") : ;;',
				'	"fetch --quiet") : ;;',
				'	"pull --ff-only") echo "$FAKE_NEW_REV" > "$FAKE_HEAD" ;;',
				'	"diff --name-only") cat "$FAKE_DIFF" ;;',
				'	"log -1") echo "fake0ab subject" ;;',
				'	*) echo "git stub: unhandled: $*" >&2; exit 1 ;;',
				"esac",
			].join("\n"),
		);
		stub("bun", 'echo "bun $*" >> "$BUN_CALLS"');
		stub(
			"systemctl",
			[
				'echo "systemctl $*" >> "$SYSTEMCTL_CALLS"',
				'if [ "$1 $2" = "--user is-active" ]; then echo active; fi',
			].join("\n"),
		);
		stub("journalctl", "exit 0");
		stub("sleep", "exit 0");

		const env: Record<string, string> = {
			HOME: home,
			PATH: `${bin}:/usr/bin:/bin`,
			GIT_CALLS: join(dir, "git.calls"),
			BUN_CALLS: log.bun,
			SYSTEMCTL_CALLS: log.systemctl,
			FAKE_HEAD: fakeHead,
			FAKE_NEW_REV: newRev,
			FAKE_DIFF: fakeDiff,
		};
		const res = spawnSync("bash", ["-s", "--", newRev], {
			input: remoteScript(),
			env,
			encoding: "utf8",
		});
		const calls = (path: string): string[] =>
			existsSync(path)
				? readFileSync(path, "utf8")
						.split("\n")
						.filter((l) => l !== "")
				: [];
		return {
			status: res.status,
			stdout: res.stdout,
			stderr: res.stderr,
			bun: calls(log.bun),
			systemctl: calls(log.systemctl),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("deploy.sh remote step", () => {
	test("dependency-only change rebuilds the client (#121)", () => {
		// react/ai/vite bumps land in package.json/bun.lock with no app/
		// path touched — the bundle inlines that code, so it must rebuild.
		for (const manifest of ["bun.lock", "package.json"]) {
			const run = runRemote([manifest]);
			expect(run.status).toBe(0);
			expect(run.bun).toContain("bun install --frozen-lockfile");
			expect(run.bun).toContain("bun run app:build");
		}
	});

	test("app-only change builds the client but installs nothing", () => {
		const run = runRemote(["app/src/App.tsx", "app/vite.config.ts"]);
		expect(run.status).toBe(0);
		expect(run.bun).toEqual(["bun run app:build"]);
	});

	test("backend-only change installs and builds nothing", () => {
		const run = runRemote(["src/index.ts", "src/http/app-channel.ts"]);
		expect(run.status).toBe(0);
		expect(run.bun).toEqual([]);
		expect(run.systemctl).toContain("systemctl --user restart goblin");
	});

	test("printed rollback reinstalls and rebuilds before restart (#120)", () => {
		// app/dist and node_modules are gitignored: a bare reset leaves the
		// new client/deps beside the old backend. The printed line must
		// order reset → install → build → restart so it's copy-paste safe.
		const run = runRemote(["src/index.ts"]);
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
