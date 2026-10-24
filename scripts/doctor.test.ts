import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthReportSchema } from "../src/health.ts";

test("workspace launcher resolves owning checkout and preserves explicit home/CLI arguments", () => {
	const dir = mkdtempSync(join(tmpdir(), "goblin-doctor-launcher-"));
	try {
		const repo = join(dir, "repo");
		const bin = join(dir, "bin");
		const home = join(dir, "custom-home");
		const workspace = join(home, "workspace");
		for (const path of [join(repo, "scripts"), bin, workspace])
			mkdirSync(path, { recursive: true });
		copyFileSync(join(import.meta.dir, "doctor"), join(repo, "scripts", "doctor"));
		symlinkSync(join(repo, "scripts", "doctor"), join(home, "doctor"));
		writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$GOBLIN_HOME" "$*"\n`, {
			mode: 0o755,
		});
		const result = spawnSync("/bin/sh", [join(home, "doctor"), "--json", "--phase", "preflight"], {
			cwd: workspace,
			env: { HOME: dir, GOBLIN_HOME: home, PATH: `${bin}:/usr/bin` },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`${repo}\n${home}\n--no-install run src/doctor.ts --json --phase preflight\n`,
		);
		expect(result.stderr).toBe("");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the real worker's stdout stays exactly one JSON report", async () => {
	// design/doctor.md: "JSON stdout is exactly one report" — runtime
	// diagnostics (proc.ts's pipe warns in particular) must route to
	// stderr, never interleave. The worker runs with no external commands
	// on PATH: probes fail into the report instead of crashing it.
	const dir = mkdtempSync(join(tmpdir(), "goblin-doctor-worker-"));
	try {
		const home = join(dir, "home");
		mkdirSync(home);
		writeFileSync(
			join(home, "goblin.json5"),
			JSON.stringify({
				providers: { fake: { kind: "codex" } },
				model: "fake/model",
				operators: [1],
			}),
		);
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-install",
				join(import.meta.dir, "..", "src", "doctor.ts"),
				"--worker",
				"--phase",
				"preflight",
			],
			{
				env: { PATH: "/usr/bin:/bin", HOME: dir, GOBLIN_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		const reportLines = stdout.trim().split("\n");
		expect(reportLines.length).toBe(1);
		const report = healthReportSchema.parse(JSON.parse(reportLines[0]!));
		expect(report.phase).toBe("preflight");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
