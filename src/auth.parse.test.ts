import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAuthFile, parsePassKeysGet, passKeysCommandExecutable } from "./auth.ts";

const sentinel = "SYNTHETIC_AUTH_INPUT_DO_NOT_ECHO";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

const invalid = [
	`{"name":"ref","value":${sentinel}}`,
	JSON.stringify({ name: "ref", value: { [sentinel]: `!echo ${sentinel}` } }),
	JSON.stringify({ name: [sentinel], value: `!echo ${sentinel}` }),
	JSON.stringify([sentinel]),
];

describe("auth parser safety", () => {
	test.each(invalid)("rejects synthetic invalid input without retaining it (%#)", (raw) => {
		let failure: unknown;
		try {
			parseAuthFile(`\n${raw}\n`);
		} catch (err) {
			failure = err;
		}
		expect(failure).toBeInstanceOf(Error);
		const err = failure as Error;
		expect(err.message).toContain("auth.jsonl:2: invalid");
		expect(err.message).not.toContain(sentinel);
		expect(err.stack).not.toContain(sentinel);
		expect(err).not.toHaveProperty("cause");
		expect(err).not.toHaveProperty("issues");
		expect(JSON.stringify(err)).not.toContain(sentinel);
	});

	test("blank lines, file order, duplicates and unknown-key stripping remain unchanged", () => {
		expect(
			parseAuthFile(
				'\n {"name":"ref","value":"literal","extra":true}\n\t\n{"name":"ref","value":"!echo synthetic"}\n',
			),
		).toEqual([
			{ name: "ref", value: "literal", line: 2 },
			{ name: "ref", value: "!echo synthetic", line: 4 },
		]);
	});

	test.each(invalid)(
		"install helper stderr cannot expose synthetic invalid input (%#)",
		async (raw) => {
			const dir = mkdtempSync(join(tmpdir(), "goblin-auth-parser-"));
			dirs.push(dir);
			writeFileSync(join(dir, "auth.jsonl"), `\n${raw}\n`, { mode: 0o600 });
			const child = Bun.spawn(
				[process.execPath, join(import.meta.dir, "../scripts/check-auth.ts")],
				{
					env: { ...process.env, GOBLIN_HOME: dir },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).not.toBe(0);
			expect(code).not.toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toContain("auth.jsonl:2: invalid");
			expect(stderr).not.toContain(sentinel);
		},
	);

	test("install helper still refuses a forbidden command even before a clean duplicate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-auth-parser-"));
		dirs.push(dir);
		writeFileSync(
			join(dir, "auth.jsonl"),
			JSON.stringify({ name: "ref", value: `!echo ${sentinel}; pass-cli info` }) +
				"\n" +
				JSON.stringify({ name: "ref", value: "synthetic" }) +
				"\n",
			{ mode: 0o600 },
		);
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/check-auth.ts")], {
			env: { ...process.env, GOBLIN_HOME: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(2);
		expect(stdout).toBe("ref\n");
		expect(stderr).toBe("");
		expect(stdout + stderr).not.toContain(sentinel);
	});
});

describe("pass-keys command recognition (installer/doctor shared grammar)", () => {
	test("bare and absolute-path pass-keys executables are identified", () => {
		expect(passKeysCommandExecutable("!pass-keys get goblin-dev BOT_TOKEN")).toBe("pass-keys");
		expect(passKeysCommandExecutable("!/usr/local/bin/pass-keys get goblin-dev BOT_TOKEN")).toBe(
			"/usr/local/bin/pass-keys",
		);
		expect(passKeysCommandExecutable("!pass-keys")).toBe("pass-keys");
		expect(passKeysCommandExecutable("!./bin/pass-keys get p K")).toBe("./bin/pass-keys");
	});

	test("literals, other executables and non-command values are not identified", () => {
		for (const value of [
			"literal",
			"pass-keys get goblin-dev BOT_TOKEN",
			"!pass-cli get goblin-dev BOT_TOKEN",
			"!not-pass-keys get p K",
			"!pass-keysx get p K",
			"!printf pass-keys",
			"",
		])
			expect(passKeysCommandExecutable(value)).toBeUndefined();
	});

	test("shell assignments and comments are not executable words", () => {
		for (const value of [
			"!GOBLIN_PROBE=/missing/pass-keys get goblin-dev KEY",
			"!GOBLIN_PROBE+=/missing/pass-keys get goblin-dev KEY",
			"!_PROBE_2=/missing/pass-keys get goblin-dev KEY",
			"!#/missing/pass-keys get goblin-dev KEY",
		]) {
			expect(passKeysCommandExecutable(value), value).toBeUndefined();
			expect(parsePassKeysGet(value), value).toBeNull();
		}
		expect(parsePassKeysGet("!/opt/lane=local/pass-keys get p K")).toEqual({
			executable: "/opt/lane=local/pass-keys",
			profile: "p",
			key: "K",
		});
	});

	test("a single direct get parses profile and key; digit-leading keys are valid", () => {
		expect(parsePassKeysGet("!pass-keys get goblin-dev BOT_TOKEN")).toEqual({
			executable: "pass-keys",
			profile: "goblin-dev",
			key: "BOT_TOKEN",
		});
		expect(parsePassKeysGet("!/opt/bin/pass-keys get p_2-9 1KEY")).toEqual({
			executable: "/opt/bin/pass-keys",
			profile: "p_2-9",
			key: "1KEY",
		});
		expect(parsePassKeysGet("!bin/pass-keys get p K")).toEqual({
			executable: "bin/pass-keys",
			profile: "p",
			key: "K",
		});
		expect(parsePassKeysGet("!pass-keys get a 9")).toEqual({
			executable: "pass-keys",
			profile: "a",
			key: "9",
		});
	});

	test("substitution, glob and redirection executables never parse as get", () => {
		// Generic detection still identifies the keys lane for the
		// installer's flag; only the strict get-parse refuses these —
		// an expanded executable is a different command than certified.
		expect(passKeysCommandExecutable("!$HOME/bin/pass-keys get p K")).toBe("$HOME/bin/pass-keys");
		for (const value of [
			"!$HOME/bin/pass-keys get p K",
			"!${HOME}/bin/pass-keys get p K",
			"!~/bin/pass-keys get p K",
			"!/opt/x\\y/pass-keys get p K",
			"!/opt/*/pass-keys get p K",
			"!/opt/?in/pass-keys get p K",
			"!/opt/{a,b}/pass-keys get p K",
			"!/opt/[ab]/pass-keys get p K",
			"!/opt/>in/pass-keys get p K",
			"!/opt/<in/pass-keys get p K",
		])
			expect(parsePassKeysGet(value), value).toBeNull();
	});

	test("operators, wrappers, quotes, env prefixes and non-get forms never parse", () => {
		for (const value of [
			"!pass-keys get p",
			"!pass-keys get p K extra",
			"!pass-keys get P K",
			"!pass-keys get -p K",
			"!pass-keys get 'p' K",
			'!pass-keys get p "K"',
			"!pass-keys get $(x) K",
			"!pass-keys get p K; id",
			"!pass-keys get p K && id",
			"!pass-keys get p K | cat",
			"!pass-keys warm p",
			"!pass-keys run p -- env",
			"!env F=1 pass-keys get p K",
			"!sh -c 'pass-keys get p K'",
			"!xargs pass-keys get p K",
			"!pass-keys\tget p K",
			"!pass-keys get p K\n!id",
		])
			expect(parsePassKeysGet(value), value).toBeNull();
	});
});
