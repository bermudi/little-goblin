import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../src/testkit.ts";

const script = join(import.meta.dir, "comment-audit.ts");
function repo(): string {
	const dir = tmpDir();
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "Test");
	return dir;
}
function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function audit(dir: string, ...args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
}
function put(dir: string, text: string): void {
	writeFileSync(join(dir, "sample.tsx"), text);
	git(dir, "add", "sample.tsx");
}
function commit(dir: string): void {
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "fixture");
}

test("parser counts only real comments and removable whole lines", () => {
	const dir = repo();
	put(dir, 'const url = "https://example.test/x";\r\nconst regex = /\\/\\/x/;\r\nconst template = `/* no */`;\r\nconst x = <div>{"// no"}</div>;\r\n/* first */ /* second */\r\nconst y = 1; // inline\r\n/* block\r\n * next\r\n */\r\n// @ts-expect-error reason\r\nconst z = 1;\r\n// last');
	const result = audit(dir, "--report");
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("5 comments, 5 removable lines / 12 lines");
});

test("init is exclusive and check catches replacements and stale allowances", () => {
	const dir = repo();
	put(dir, "// original\n// duplicate\n// duplicate\nconst x = 1;\n");
	expect(audit(dir, "--init").status).toBe(0);
	expect(audit(dir, "--init").status).not.toBe(0);
	expect(audit(dir).status).toBe(0);
	put(dir, "// original\n// duplicate\n// duplicate\n// duplicate\nconst x = 1;\n");
	expect(audit(dir).stderr).toContain("sample.tsx:4: new or changed prose comment");
	put(dir, "// replacement\n// duplicate\nconst x = 1;\n");
	expect(audit(dir).stderr).toContain("sample.tsx:1: new or changed prose comment");
	expect(audit(dir, "--prune").status).toBe(0);
	expect(audit(dir).status).not.toBe(0);
	put(dir, "// duplicate\nconst x = 1;\n");
	expect(audit(dir).status).toBe(0);
});

test("base comparison permits adoption but prevents committed and uncommitted growth", () => {
	const dir = repo();
	put(dir, "// original\n// removed before adoption\nconst x = 1;\n");
	commit(dir);
	const before = git(dir, "rev-parse", "HEAD");
	put(dir, "// original\nconst x = 1;\n");
	expect(audit(dir, "--init").status).toBe(0);
	commit(dir);
	expect(audit(dir, "--check", "--base", before).status).toBe(0);
	const base = git(dir, "rev-parse", "HEAD");
	put(dir, "// original\n// added\nconst x = 1;\n");
	renameSync(join(dir, ".github/comment-baseline.json"), join(dir, "baseline-backup.json"));
	expect(audit(dir, "--init").status).toBe(0);
	expect(audit(dir, "--base", base).stderr).toContain("sample.tsx: comment baseline grew");
	git(dir, "commit", "-qm", "unapproved baseline growth", ".github/comment-baseline.json", "sample.tsx");
	expect(audit(dir, "--base", base).stderr).toContain("sample.tsx: comment baseline grew");
	expect(audit(dir, "--base", "invalid-ref").status).not.toBe(0);
});

test.each([
	["added", "// original\n// added during adoption\nconst x = 1;\n"],
	["rewritten", "// rewritten during adoption\nconst x = 1;\n"],
])("first adoption rejects %s prose even with a matching baseline", (_change, source) => {
	const dir = repo();
	put(dir, "// original\nconst x = 1;\n");
	commit(dir);
	const base = git(dir, "rev-parse", "HEAD");
	put(dir, source);
	expect(audit(dir, "--init").status).toBe(0);
	commit(dir);
	expect(audit(dir).status).toBe(0);
	expect(audit(dir, "--base", base).stderr).toContain("sample.tsx: comment baseline grew");
});

test("moving a comment to a new file does not transfer its allowance", () => {
	const dir = repo();
	put(dir, "// original\nconst x = 1;\n");
	expect(audit(dir, "--init").status).toBe(0);
	put(dir, "const x = 1;\n");
	writeFileSync(join(dir, "moved.ts"), "// original\nconst y = 2;\n");
	git(dir, "add", "moved.ts");
	expect(audit(dir, "--prune").status).toBe(0);
	expect(audit(dir).stderr).toContain("moved.ts:1: new or changed prose comment");
});

test("invalid baseline and syntax fail closed; semantic directives remain exempt", () => {
	const dir = repo();
	put(dir, '/// <reference types="bun" />\n// @ts-ignore reason\n/** @deprecated use other */\n/** @see not a compiler directive */\nconst x = 1;\n// ordinary\n');
	expect(audit(dir, "--init").status).toBe(0);
	expect(audit(dir, "--report").stdout).toContain("2 comments, 2 removable lines");
	writeFileSync(join(dir, ".github/comment-baseline.json"), "{}\n");
	expect(audit(dir).status).not.toBe(0);
	put(dir, "const = ;\n");
	expect(audit(dir, "--report").status).not.toBe(0);
});
