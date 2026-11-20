import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

	test("opencode's --model moves into its per-run config: the TUI has no model flag (#742)", () => {
		const bin = tempDir();
		writeFileSync(join(bin, "opencode"), "#!/bin/sh\n");
		chmodSync(join(bin, "opencode"), 0o755);
		const saved = process.env.PATH;
		process.env.PATH = bin;
		try {
			const run = (args: string[]) =>
				makeHarnessInvocation({
					kind: "opencode",
					args,
					cwd: bin,
					terminalName: "g1-x",
					goblinHome: tempDir(),
					hooksDir: "/var/lib/goblin/bin/hc-hooks",
				});
			for (const args of [
				["--auto", "--model", "opencode/deepseek-v4.1-flash-free"],
				["--auto", "-m", "opencode/deepseek-v4.1-flash-free"],
				["--auto", "--model=opencode/deepseek-v4.1-flash-free"],
			]) {
				const { argv, env } = run(args);
				expect(argv).toEqual([join(bin, "opencode"), "--auto", "--standalone"]);
				expect(JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT!)).toEqual({
					plugins: ["/var/lib/goblin/bin/hc-hooks"],
					model: "opencode/deepseek-v4.1-flash-free",
				});
			}
			const bare = run(["--auto"]);
			expect(JSON.parse(bare.env.OPENCODE_CLI_CONFIG_CONTENT!)).toEqual({
				plugins: ["/var/lib/goblin/bin/hc-hooks"],
			});
			expect(() => run(["--model"])).toThrow("--model needs a model");
		} finally {
			if (saved === undefined) delete process.env.PATH;
			else process.env.PATH = saved;
		}
	});
});

describe("devin per-run config", () => {
	const hooksDir = "/var/lib/goblin/bin/hc-hooks";
	const events = {
		SessionStart: "idle",
		UserPromptSubmit: "working",
		PreToolUse: "working",
		PostToolUse: "working",
		Stop: "idle",
		PermissionRequest: "blocked permission",
	} as const;

	function withDevinEnv(xdg: string | undefined, body: (home: string, bin: string) => void): void {
		const bin = tempDir();
		const home = tempDir();
		writeFileSync(join(bin, "devin"), "#!/bin/sh\n");
		chmodSync(join(bin, "devin"), 0o755);
		const saved = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		process.env.PATH = bin;
		if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = xdg;
		try {
			body(home, bin);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	function launch(home: string, goblinHome: string): { argv: string[]; config: Record<string, unknown> } {
		const { argv } = makeHarnessInvocation({
			kind: "devin",
			args: ["--permission-mode", "dangerous"],
			cwd: goblinHome,
			terminalName: "g1-x",
			goblinHome,
			hooksDir,
			homeDir: home,
		});
		const path = argv[argv.indexOf("--config") + 1]!;
		return { argv, config: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
	}

	function commands(config: Record<string, unknown>, event: string): string[] {
		const entries = (config.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)[event] ?? [];
		return entries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
	}

	function writeOperator(dir: string, text: string): void {
		mkdirSync(join(dir, "devin"), { recursive: true });
		writeFileSync(join(dir, "devin", "config.json"), text);
	}

	test("starts from the operator's config and appends goblin's six hooks after theirs (#810)", () => {
		withDevinEnv(undefined, (home) => {
			writeOperator(join(home, ".config"), `{
				// devin reads JSONC
				"version": 1,
				"agent": { "model": "operator-model" },
				"permissions": { "allow": ["Read(**)"] },
				"hooks": {
					"Stop": [{ "hooks": [{ "type": "command", "command": "/operator/stop" }] }],
					"PreToolUse": [{ "matcher": "exec", "hooks": [{ "type": "command", "command": "/operator/pre" }] }],
				},
			}`);
			const goblinHome = tempDir();
			const { config } = launch(home, goblinHome);
			expect(config.agent).toEqual({ model: "operator-model" });
			expect(config.permissions).toEqual({ allow: ["Read(**)"] });
			expect(config.version).toBe(1);
			for (const [event, state] of Object.entries(events)) {
				const own = event === "Stop" ? ["/operator/stop"] : event === "PreToolUse" ? ["/operator/pre"] : [];
				expect(commands(config, event)).toEqual([...own, `${hooksDir}/report.sh ${state}`]);
			}
			// Re-launching rebuilds from the operator file: no duplicate entries.
			expect(launch(home, goblinHome).config).toEqual(config);
			expect(readFileSync(join(home, ".config", "devin", "config.json"), "utf8")).toContain("// devin reads JSONC");
		});
	});

	test("an operator entry that already runs goblin's command is not doubled", () => {
		withDevinEnv(undefined, (home) => {
			writeOperator(join(home, ".config"), JSON.stringify({
				version: 1,
				hooks: { Stop: [{ hooks: [{ type: "command", command: `${hooksDir}/report.sh idle` }] }] },
			}));
			expect(commands(launch(home, tempDir()).config, "Stop")).toEqual([`${hooksDir}/report.sh idle`]);
		});
	});

	test("no operator config means version 1 plus goblin's hooks", () => {
		withDevinEnv(undefined, (home) => {
			const { config } = launch(home, tempDir());
			expect(Object.keys(config).sort()).toEqual(["hooks", "version"]);
			expect(config.version).toBe(1);
			for (const [event, state] of Object.entries(events)) {
				expect(commands(config, event)).toEqual([`${hooksDir}/report.sh ${state}`]);
			}
		});
	});

	test("an absolute XDG_CONFIG_HOME is where devin's config lives; a relative one is ignored", () => {
		const xdg = tempDir();
		withDevinEnv(xdg, (home) => {
			writeOperator(xdg, JSON.stringify({ version: 1, theme_mode: "xdg" }));
			writeOperator(join(home, ".config"), JSON.stringify({ version: 1, theme_mode: "home" }));
			expect(launch(home, tempDir()).config.theme_mode).toBe("xdg");
		});
		withDevinEnv("relative/xdg", (home) => {
			writeOperator(join(home, ".config"), JSON.stringify({ version: 1, theme_mode: "home" }));
			expect(launch(home, tempDir()).config.theme_mode).toBe("home");
		});
	});

	test("a broken operator config fails loud instead of dropping their settings", () => {
		for (const [text, message] of [
			["{ not json", "invalid JSONC"],
			["[1, 2]", "expected an object"],
			[JSON.stringify({ version: 1, hooks: { Stop: { hooks: [] } } }), "expected an object"],
		] as const) {
			withDevinEnv(undefined, (home) => {
				writeOperator(join(home, ".config"), text);
				expect(() => launch(home, tempDir())).toThrow(message);
			});
		}
	});

	test("an unreadable operator config fails loud, not as missing", () => {
		withDevinEnv(undefined, (home) => {
			mkdirSync(join(home, ".config", "devin", "config.json"), { recursive: true });
			expect(() => launch(home, tempDir())).toThrow("cannot read devin config");
		});
	});
});
