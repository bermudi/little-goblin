import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The /api proxy target is picked at config-eval time from GOBLIN_HTTP —
// each case runs in its own Bun process so the env (and the module
// cache) can't cross-contaminate. The child imports the real config
// and prints only the resolved target; no dev server, no API calls.
const repoRoot = join(import.meta.dir, "..");

function proxyTarget(env: Record<string, string | undefined>): string {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			'const c = (await import("./app/vite.config.ts")).default;' +
				'process.stdout.write(c.server.proxy["/api"].target)',
		],
		{
			cwd: repoRoot,
			env: { PATH: process.env.PATH, ...env },
			encoding: "utf8",
		},
	);
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	return result.stdout;
}

test("the /api proxy falls back to the default goblin http port", () => {
	expect(proxyTarget({ GOBLIN_HTTP: undefined })).toBe("http://127.0.0.1:8787");
});

test("GOBLIN_HTTP overrides the /api proxy target exactly", () => {
	expect(proxyTarget({ GOBLIN_HTTP: "http://127.0.0.1:9123" })).toBe("http://127.0.0.1:9123");
});
