import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureCodexHooks, makeHarnessInvocation } from "./hc-harness.ts";

const roots: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "goblin-hc-harness-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ensureCodexHooks", () => {
	test("merges stable hooks and trust hashes additively and idempotently", () => {
		const home = tempDir();
		const hooksDir = "/var/lib/goblin/bin/hc-hooks";
		const hooksPath = join(home, "hooks.json");
		const configPath = join(home, "config.toml");
		writeFileSync(
			hooksPath,
			`${JSON.stringify({
				SessionStart: [{ hooks: [{ type: "command", command: "/operator/session-hook" }] }],
				operator_metadata: { retained: true },
			})}\n`,
		);
		chmodSync(hooksPath, 0o640);
		writeFileSync(configPath, '[features]\nproject_trust = true\n\n[operator]\nkeep = "yes"\n');

		ensureCodexHooks(hooksDir, home);
		const merged = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
		const sessionHooks = merged.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
		expect(sessionHooks).toHaveLength(2);
		expect(sessionHooks[0]?.hooks[0]?.command).toBe("/operator/session-hook");
		expect(sessionHooks[1]?.hooks[0]?.command).toBe(`${hooksDir}/report.sh idle`);
		expect(merged.operator_metadata).toEqual({ retained: true });
		expect(statSync(hooksPath).mode & 0o777).toBe(0o640);

		const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
			features: Record<string, unknown>;
			operator: Record<string, unknown>;
			hooks: { state: Record<string, { trusted_hash?: string }> };
		};
		expect(parsed.features).toEqual({ project_trust: true, hooks: true });
		expect(parsed.operator).toEqual({ keep: "yes" });
		const key = `${hooksPath}:session_start:1:0`;
		const hook = {
			async: false,
			command: `${hooksDir}/report.sh idle`,
			timeout: 600,
			type: "command",
		};
		const expectedHash = `sha256:${createHash("sha256")
			.update(JSON.stringify({ event_name: "session_start", hooks: [hook] }))
			.digest("hex")}`;
		expect(parsed.hooks.state[key]?.trusted_hash).toBe(expectedHash);
		const permissionKey = `${hooksPath}:permission_request:0:0`;
		const permissionHook = {
			async: false,
			command: `${hooksDir}/report.sh blocked permission`,
			timeout: 600,
			type: "command",
		};
		expect(parsed.hooks.state[permissionKey]?.trusted_hash).toBe(
			`sha256:${createHash("sha256").update(JSON.stringify({
				event_name: "permission_request",
				hooks: [permissionHook],
			})).digest("hex")}`,
		);

		const before = readFileSync(configPath);
		const timestamp = new Date(1_700_000_000_000);
		utimesSync(configPath, timestamp, timestamp);
		ensureCodexHooks(hooksDir, home);
		expect(readFileSync(configPath)).toEqual(before);
		expect(statSync(configPath).mtimeMs).toBe(timestamp.getTime());
		expect((JSON.parse(readFileSync(hooksPath, "utf8")) as { SessionStart: unknown[] }).SessionStart).toHaveLength(2);
	});
});

describe("makeHarnessInvocation", () => {
	test("codex runs in the terminal without its update prompt, operator config untouched", () => {
		const bin = tempDir();
		const codexHome = tempDir();
		writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
		chmodSync(join(bin, "codex"), 0o755);
		const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
		process.env.PATH = bin;
		process.env.CODEX_HOME = codexHome;
		try {
			const { argv, env } = makeHarnessInvocation({
				kind: "codex",
				args: ["--model", "gpt-6-luna"],
				cwd: bin,
				terminalName: "g1-x",
				goblinHome: tempDir(),
				hooksDir: "/var/lib/goblin/bin/hc-hooks",
			});
			expect(argv).toEqual([
				join(bin, "codex"),
				"--model",
				"gpt-6-luna",
				"--no-daemon",
				"-c",
				"check_for_update_on_startup=false",
			]);
			expect(env.CODEX_HOME).toBe(codexHome);
			expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("check_for_update");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
