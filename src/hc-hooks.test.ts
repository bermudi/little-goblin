import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { installHcHooks } from "./hc-hooks.ts";

const roots: string[] = [];

function dir(): string {
	const path = mkdtempSync(join(tmpdir(), "goblin-hc-hooks-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		Bun.spawnSync(["trash", root]);
	}
});

describe("installHcHooks", () => {
	test("copies assets with mode 0755 and skips identical content", () => {
		const source = dir();
		const target = join(dir(), "installed");
		Bun.write(join(source, "report.sh"), "#!/bin/sh\nexit 0\n");

		installHcHooks(source, target);
		const path = join(target, "report.sh");
		const first = statSync(path);
		const mtime = first.mtimeMs;
		expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(first.mode & 0o777).toBe(0o755);

		installHcHooks(source, target);
		expect(statSync(path).mtimeMs).toBe(mtime);
	});
});
