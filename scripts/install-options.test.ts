import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function inspect(
	config: string,
	auth = "",
): { status: number | null; stdout: string; stderr: string; invoked: boolean } {
	const home = mkdtempSync(join(tmpdir(), "goblin-install-options-"));
	try {
		writeFileSync(join(home, "goblin.json5"), config);
		writeFileSync(join(home, "auth.jsonl"), auth, { mode: 0o600 });
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "credential-probe"),
			`#!/bin/sh\ntouch '${join(home, "invoked")}'\nprintf 'FIXTURE_SECRET'\n`,
			{ mode: 0o755 },
		);
		const result = spawnSync(
			process.execPath,
			["--no-install", "run", join(import.meta.dir, "install-options.ts")],
			{ env: { HOME: home, GOBLIN_HOME: home, PATH: `${bin}:/usr/bin` }, encoding: "utf8" },
		);
		return { ...result, invoked: existsSync(join(home, "invoked")) };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}
const config =
	'{providers:{fixture:{kind:"openai-compatible",baseUrl:"https://fixture.invalid",auth:"fixture"}},model:"fixture/model",allowedUsers:[1],tts:""';
test("setup options inspect config and auth shapes without executing credentials or emitting config logs", () => {
	const result = inspect(
		`${config},delegation:{harnesses:{fixture:{kind:"fixture"}},maxRunning:2}}`,
		'{"name":"fixture","value":"!pass-keys get goblin-dev FIXTURE"}',
	);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout) as unknown).toEqual({
		delegation: true,
		keys: true,
		port: 8787,
	});
	expect(result.stderr).toBe("");
});
for (const [name, settings, auth] of [
	["malformed config", "{value:FIXTURE_SECRET", ""],
	["malformed auth", `${config}}`, '{"name":"fixture","value":FIXTURE_SECRET}'],
	[
		"different Pass profile",
		`${config}}`,
		'{"name":"fixture","value":"!pass-keys get other FIXTURE_SECRET"}',
	],
	[
		"multi-directory absolute Pass path with unsupported profile",
		`${config}}`,
		'{"name":"fixture","value":"!/usr/bin/pass-keys get other FIXTURE_SECRET"}',
	],
] as const)
	test(`${name} fails safely before unit/action choice`, () => {
		const result = inspect(settings, auth);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("FIXTURE_SECRET");
	});

test("configured port zero is preserved for invocation-specific bound port discovery", () => {
	const result = inspect(`${config},http:{port:0}}`);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout) as unknown).toEqual({ delegation: false, keys: false, port: 0 });
});
test("an unrelated pass-keys substring stays unverified and never executes a credential command", () => {
	const result = inspect(
		`${config}}`,
		'{"name":"fixture","value":"!printf %s not-pass-keys-token"}',
	);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout) as unknown).toEqual({
		delegation: false,
		keys: false,
		port: 8787,
	});
	expect(result.stdout).not.toContain("not-pass-keys-token");
});
test("general credential command inspection never executes the boundary probe", () => {
	const result = inspect(`${config}}`, '{"name":"fixture","value":"!credential-probe"}');
	expect(result.status).toBe(0);
	expect(result.invoked).toBe(false);
	expect(result.stdout).not.toContain("FIXTURE_SECRET");
	expect(result.stderr).toBe("");
});

const record = (value: string): string =>
	`{"name":"fixture","value":${JSON.stringify(value)}}`;

// The supported grammar is literal: `!pass-keys get goblin-dev NAME`
// with NAME matching the health-key shape [A-Z0-9_]{1,128} — digits
// and a bare underscore are valid names.
for (const key of ["1PASSWORD", "_", "_2", "A".repeat(128)])
	test(`the literal supported pass-keys record reports keys (${key.slice(0, 10)}…)`, () => {
		const result = inspect(`${config}}`, record(`!pass-keys get goblin-dev ${key}`));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout) as unknown).toEqual({
			delegation: false,
			keys: true,
			port: 8787,
		});
		expect(result.invoked).toBe(false);
	});

for (const [name, value] of [
	["a lowercase key", "!pass-keys get goblin-dev fixture"],
	["a mixed-case key", "!pass-keys get goblin-dev Fixture"],
	["a hyphenated key", "!pass-keys get goblin-dev FIX-TURE"],
	["a missing key", "!pass-keys get goblin-dev"],
	["an oversized key", `!pass-keys get goblin-dev ${"A".repeat(129)}`],
	["another profile", "!pass-keys get other FIXTURE"],
	["an absolute pass-keys path", "!/usr/local/bin/pass-keys get goblin-dev FIXTURE"],
	["the multi-directory absolute path", "!/usr/bin/pass-keys get goblin-dev FIXTURE"],
	["a relative pass-keys path", "!./pass-keys get goblin-dev FIXTURE"],
	["a trailing command", "!pass-keys get goblin-dev FIXTURE;rm -rf /"],
	["an extra argument", "!pass-keys get goblin-dev FIXTURE EXTRA"],
] as const)
	test(`${name} fails safely without executing anything`, () => {
		const result = inspect(`${config}}`, record(value));
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.invoked).toBe(false);
	});

test("a pass-keys-looking refusal behind a valid record still fails", () => {
	// passCommand must evaluate every record — a .some() that
	// short-circuits on the valid first record would skip the check.
	const result = inspect(
		`${config}}`,
		`${record("!pass-keys get goblin-dev FIXTURE")}\n${record("!/usr/bin/pass-keys get goblin-dev FIXTURE")}`,
	);
	expect(result.status).not.toBe(0);
	expect(result.stdout).toBe("");
	expect(result.invoked).toBe(false);
});
