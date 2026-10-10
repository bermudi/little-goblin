import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
