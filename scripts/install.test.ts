import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthReportSchema } from "../src/health.ts";

const realBun = process.execPath;
const root = join(import.meta.dir, "..");
// Fake only external command boundaries; the shipped installer runs in a disposable checkout.
function fixture(
	mode = "healthy",
	edit?: (home: string, repo: string) => void,
): {
	status: number | null;
	stderr: string;
	calls: string;
	units: string;
	keysUnit: string;
	descendantAlive: boolean;
	checkoutVerified: boolean;
} {
	const dir = mkdtempSync(join(tmpdir(), "goblin-install-test-"));
	const home = join(dir, "home");
	const repo = join(dir, "repo");
	const bin = join(dir, "bin");
	for (const path of [
		home,
		bin,
		join(home, "goblin"),
		join(repo, "scripts"),
		join(repo, "src"),
		join(repo, "deploy"),
	])
		mkdirSync(path, { recursive: true });
	const calls = join(dir, "calls");
	const script = (name: string, content: string): void => {
		writeFileSync(
			join(bin, name),
			`#!/bin/bash\nset -eu\nprintf '%s\\n' '${name} '"$*" >> '${calls}'\n${content}\n`,
			{ mode: 0o755 },
		);
	};
	try {
		copyFileSync(join(root, "scripts", "install.sh"), join(repo, "scripts", "install.sh"));
		copyFileSync(join(root, "scripts", "install.ts"), join(repo, "scripts", "install.ts"));
		copyFileSync(
			join(root, "scripts", "startup-categories.ts"),
			join(repo, "scripts", "startup-categories.ts"),
		);
		copyFileSync(join(root, "src", "proc.ts"), join(repo, "src", "proc.ts"));
		if (mode.startsWith("real-")) cpSync(join(root, "src"), join(repo, "src"), { recursive: true });
		if (mode === "startup-descendant") {
			copyFileSync(
				join(root, "scripts", "check-startup.ts"),
				join(repo, "scripts", "check-startup.ts"),
			);
			writeFileSync(
				join(repo, "scripts", "startup-runner.ts"),
				"import {acceptStartup} from './check-startup.ts';\ntry { await acceptStartup(8787,200); } catch { process.stderr.write('install: startup inspection failed\\n');process.exitCode=1; }",
			);
		}
		for (const name of [
			"goblin.service",
			"goblin-herdr.service",
			"goblin-keys.service",
			"goblin-keys.timer",
		])
			copyFileSync(join(root, "deploy", name), join(repo, "deploy", name));
		writeFileSync(
			join(home, "goblin", "goblin.json5"),
			mode.startsWith("real-")
				? '{providers:{fixture:{kind:"openai-compatible",baseUrl:"https://fixture.invalid",auth:"fixture"}},model:"fixture/model",operators:[1],tts:""}\n'
				: "{}\n",
		);
		writeFileSync(
			join(home, "goblin", "auth.jsonl"),
			mode === "real-cancel"
				? '{"name":"telegram","value":"!pass-keys get goblin-main FIXTURE"}\\n{"name":"fixture","value":"!pass-keys get goblin-main FIXTURE"}\\n'.replaceAll(
						"\\n",
						"\n",
					)
				: mode === "real-preflight"
					? '{"name":"telegram","value":"nonsecret-fixture"}\n{"name":"fixture","value":"nonsecret-fixture"}\n'
					: "",
			{ mode: 0o600 },
		);
		// These routes specify the proposed CLI contract, not proof of shared Doctor behavior.
		script(
			"bun",
			`case "$*" in
'--no-install ${repo}/scripts/install.ts '*) exec '${realBun}' "$@" ;;
'install --frozen-lockfile') ${mode.startsWith("cancel-") ? `sleep 120 >/dev/null 2>&1 & child=$!; printf '%s' "$child" > '${join(dir, "child-pid")}'; sleep 0.05; kill -${mode.slice(7)} "$PPID"; wait "$child"` : mode === "dependency" ? "echo FIXTURE_SECRET >&2; exit 8" : `ln -s '${join(root, "node_modules")}' node_modules`} ;;
'--no-install run src/doctor.ts --phase preflight --json') ${mode.startsWith("real-") ? `printf '%s' "$PPID" > '${join(dir, "installer-pid")}'; exec '${realBun}' --no-install run '${join(repo, "src", "doctor.ts")}' --phase preflight --json > '${join(dir, "doctor-report.json")}'` : mode === "preflight" ? "echo FIXTURE_SECRET >&2; exit 1" : "printf '{\"ok\":true}'"} ;;
'--no-install run scripts/install-options.ts') printf '${mode === "badoptions" ? "invalid FIXTURE_SECRET" : JSON.stringify({ delegation: mode === "optional", keys: mode === "optional", port: mode === "port-zero" ? 0 : 8787, profiles: mode === "optional" ? ["goblin-main", "alpha-one"] : [] })}' ;;
'run app:build') ${mode === "build" ? "exit 1" : "mkdir -p app/dist; printf fixture > app/dist/index.html"} ;;
'--no-install run scripts/check-app-assets.ts '*) ${mode === "assets" ? "exit 1" : ":"} ;;
'--no-install run scripts/check-startup.ts '*) ${mode === "startup-descendant" ? `exec '${realBun}' --no-install run '${join(repo, "scripts", "startup-runner.ts")}'` : mode === "startup" ? "echo 'install: startup ready port mismatch' >&2; echo FIXTURE_SECRET >&2; exit 1" : "systemctl --user enable goblin.service && systemctl --user start --no-block goblin.service"} ;;
'--no-install run src/doctor.ts --phase installed --json') ${mode === "installed" ? "exit 1" : ":"} ;;
*) echo 'unexpected Bun boundary' >&2; exit 99 ;;
esac`,
		);
		script(
			"systemctl",
			`case "$*" in
'--user show goblin.service --property=LoadState --value') ${mode === "manager" ? "echo FIXTURE_SECRET >&2; exit 1" : `printf '${mode === "existing" ? "loaded" : "not-found"}\\n'`} ;;
'--user show goblin.service --property=InvocationID '*) sleep 120 >/dev/null 2>&1 & child=$!; printf '%s' \"$child\" > '${join(dir, "child-pid")}'; wait \"$child\" ;;
'--user daemon-reload'|'--user enable goblin.service'|'--user start --no-block goblin.service'|'--user enable --now goblin-herdr.service'|'--user enable goblin-keys.service'|'--user enable --now goblin-keys.timer') : ;;
*) echo 'unexpected systemctl boundary' >&2; exit 99 ;;
esac`,
		);
		script("systemd-analyze", mode === "unit" ? "echo FIXTURE_SECRET >&2; exit 1" : ":");
		script("loginctl", mode === "linger" ? "exit 1" : ":");
		if (mode === "optional") {
			script("herdr", ":");
			script("pass-keys", "echo 'must not execute credential tool' >&2; exit 99");
		}
		if (mode === "real-cancel")
			script(
				"pass-keys",
				`sleep 120 >/dev/null 2>&1 & child=$!; printf '%s' "$child" > '${join(dir, "child-pid")}'; kill -TERM "$(cat '${join(dir, "installer-pid")}')"; wait "$child"`,
			);
		edit?.(home, repo);
		const result = spawnSync("/bin/bash", [join(repo, "scripts", "install.sh")], {
			env: {
				HOME: home,
				USER: "fixture",
				GOBLIN_HOME: join(home, "goblin"),
				PATH: `${bin}:/usr/bin`,
			},
			encoding: "utf8",
			timeout: 20_000,
		});
		const installedUnit = join(home, ".config", "systemd", "user", "goblin.service");
		const installedKeysUnit = join(home, ".config", "systemd", "user", "goblin-keys.service");
		let descendantAlive = false;
		const childFile = join(dir, "child-pid");
		if (existsSync(childFile)) {
			const pid = Number(readFileSync(childFile, "utf8"));
			try {
				const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[0];
				descendantAlive = state !== "Z" && state !== "X";
				if (descendantAlive) process.kill(pid, "SIGKILL");
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" &&
					(error as NodeJS.ErrnoException).code !== "ESRCH"
				)
					throw error;
			}
		}
		const reportPath = join(dir, "doctor-report.json");
		const report =
			existsSync(reportPath) && readFileSync(reportPath, "utf8").trim()
				? healthReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")) as unknown)
				: undefined;
		return {
			status: result.status,
			stderr: result.stderr,
			calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
			units: existsSync(installedUnit) ? readFileSync(installedUnit, "utf8") : "",
			keysUnit: existsSync(installedKeysUnit) ? readFileSync(installedKeysUnit, "utf8") : "",
			descendantAlive,
			checkoutVerified: report?.target.checkout === repo,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("fresh installer", () => {
	test("cancellation lets real Doctor reclaim its independently owned worker/probe group", () => {
		const result = fixture("real-cancel");
		expect(result.status).not.toBe(0);
		expect(result.descendantAlive).toBe(false);
		expect(result.calls).toContain("pass-keys status goblin-main");
		expect(result.calls).not.toContain("run app:build");
		expect(result.stderr).toContain("setup cancelled (SIGTERM)");
	});
	for (const name of ["SIGINT", "SIGTERM"] as const)
		test(`${name} cancels the owned command group and prevents later phases`, () => {
			const result = fixture(`cancel-${name}`);
			expect(result.status).not.toBe(0);
			expect(result.descendantAlive).toBe(false);
			expect(result.calls).not.toContain("--phase preflight");
			expect(result.calls).not.toContain("run app:build");
			expect(result.units).toBe("");
			expect(result.stderr).toContain(`setup cancelled (${name}); no later phases`);
		});
	test("inner startup failure cleans descendants before the outer timeout", () => {
		const result = fixture("startup-descendant");
		expect(result.status).not.toBe(0);
		expect(result.descendantAlive).toBe(false);
		expect(result.stderr).toContain("startup inspection failed");
	});
	test("real shared Doctor preflight gates an isolated fresh target without resolving credentials", () => {
		const result = fixture("real-preflight");
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toContain("run app:build");
		expect(result.checkoutVerified).toBe(true);
	});
	test("real Doctor missing-reference failure prevents build/units and prints scoped read-only remedy", () => {
		const result = fixture("real-missing-auth");
		expect(result.status).not.toBe(0);
		expect(result.calls).not.toContain("run app:build");
		expect(result.units).toBe("");
		expect(result.stderr).toContain("--no-install run src/doctor.ts --phase preflight --json");
		expect(result.checkoutVerified).toBe(true);
	});
	test("configured port zero reaches startup acceptance unchanged", () => {
		const result = fixture("port-zero");
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toContain("scripts/check-startup.ts 0");
	});
	test("orders frozen sync, preflight, build, asset check, units, current startup, installed checks", () => {
		const result = fixture();
		expect(result.status, result.stderr).toBe(0);
		const stages = [
			"install --frozen-lockfile",
			"--phase preflight --json",
			"run app:build",
			"scripts/check-app-assets.ts",
			"systemd-analyze --user verify",
			"systemctl --user daemon-reload",
			"loginctl --no-ask-password enable-linger fixture",
			"scripts/check-startup.ts",
			"--phase installed --json",
		];
		let last = -1;
		for (const stage of stages) {
			const next = result.calls.indexOf(stage);
			expect(next).toBeGreaterThan(last);
			last = next;
		}
		expect(result.units).toContain("WorkingDirectory=/tmp/goblin-install-test-");
		expect(result.calls.split("\n")).toContain("loginctl --no-ask-password enable-linger fixture");
		expect(result.units).toContain("Environment=PATH=/tmp/goblin-install-test-");
		expect(result.stderr).toContain("end-to-end acceptance");
	});
	for (const mode of ["existing", "manager"])
		test(`${mode} refuses before live dependency/client mutation`, () => {
			const result = fixture(mode);
			expect(result.status).not.toBe(0);
			expect(result.calls).not.toContain("install --frozen-lockfile");
			expect(result.calls).not.toContain("app:build");
			expect(result.units).toBe("");
			expect(result.stderr).not.toContain("FIXTURE_SECRET");
		});
	test("existing unit and dangling unit symlink refuse before even manager inspection", () => {
		for (const link of [false, true]) {
			const result = fixture("healthy", (home) => {
				const unit = join(home, ".config", "systemd", "user");
				mkdirSync(unit, { recursive: true });
				if (link) symlinkSync("/no-such-target", join(unit, "goblin.service"));
				else writeFileSync(join(unit, "goblin.service"), "existing");
			});
			expect(result.status).not.toBe(0);
			expect(result.calls).not.toContain("systemctl");
			expect(result.calls).not.toContain("install --frozen-lockfile");
		}
	});
	test("insecure auth stops before dependency sync", () => {
		const result = fixture("healthy", (home) =>
			chmodSync(join(home, "goblin", "auth.jsonl"), 0o640),
		);
		expect(result.status).not.toBe(0);
		expect(result.calls).not.toContain("install --frozen-lockfile");
		expect(result.stderr).toContain("insecure-mode");
	});
	for (const mode of ["dependency", "preflight", "badoptions", "build", "assets", "unit"])
		test(`${mode} failure prevents unit installation/start and does not echo subprocess secrets`, () => {
			const result = fixture(mode);
			expect(result.status).not.toBe(0);
			expect(result.units).toBe("");
			expect(result.calls).not.toContain("daemon-reload");
			expect(result.stderr).not.toContain("FIXTURE_SECRET");
		});
	for (const mode of ["linger", "startup", "installed"])
		test(`${mode} failure never claims accepted installation`, () => {
			const result = fixture(mode);
			expect(result.status).not.toBe(0);
			expect(result.stderr).not.toContain("local startup accepted");
			expect(result.stderr).not.toContain("FIXTURE_SECRET");
		});
	test("startup failure preserves only allowlisted categories and an exact read-only remedy", () => {
		const result = fixture("startup");
		expect(result.stderr).toContain("startup ready port mismatch");
		expect(result.stderr).toContain("--no-install run src/doctor.ts --phase installed --json");
		expect(result.stderr).toContain("partial installation");
		expect(result.stderr).not.toContain("FIXTURE_SECRET");
	});
	test("optional units are config-aware; pass-keys is never executed by inspection", () => {
		const result = fixture("optional");
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toContain("enable --now goblin-herdr.service");
		expect(result.calls).toContain("enable --now goblin-keys.timer");
		expect(result.calls).not.toContain("pass-keys ");
		// Warm targets render from the reported profiles — one line per
		// profile, sorted — next to the template's pinned MCP-lane line.
		expect(result.keysUnit).toContain("warm goblin-main");
		expect(result.keysUnit).toContain("warm alpha-one");
		expect(result.keysUnit.indexOf("warm alpha-one")).toBeLessThan(
			result.keysUnit.indexOf("warm goblin-main"),
		);
		expect(result.keysUnit).toContain("warm goblin-mcp-dev");
		expect(result.keysUnit).not.toContain("@WARM_AUTH_PROFILES@");
	});
});
