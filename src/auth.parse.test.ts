import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAuthFile } from "./auth.ts";

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
