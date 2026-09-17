import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuth } from "./auth.ts";

let dirs: string[] = [];
let prevHome: string | undefined;

function useHome(): string {
	prevHome = process.env.GOBLIN_HOME;
	const dir = mkdtempSync(join(tmpdir(), "goblin-auth-"));
	dirs.push(dir);
	process.env.GOBLIN_HOME = dir;
	return dir;
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.GOBLIN_HOME;
	else process.env.GOBLIN_HOME = prevHome;
	prevHome = undefined;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

// auth.jsonl must be mode 0600 to load at all — write, then harden.
function writeAuth(dir: string, content: string): void {
	const p = join(dir, "auth.jsonl");
	writeFileSync(p, content);
	chmodSync(p, 0o600);
}

describe("auth.jsonl", () => {
	test("ENOENT → empty store, resolve rejects", async () => {
		useHome();
		const auth = loadAuth();
		expect(auth.has("x")).toBe(false);
		await expect(auth.resolve("x")).rejects.toThrow('no secret named "x"');
	});

	test("group or world bits refuse to load", () => {
		const dir = useHome();
		const p = join(dir, "auth.jsonl");
		writeFileSync(p, '{"name":"a","value":"s3cret"}\n');
		chmodSync(p, 0o640);
		expect(() => loadAuth()).toThrow("insecure permissions");
	});

	test("literal values resolve", async () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"a","value":"s3cret"}\n');
		expect(await loadAuth().resolve("a")).toBe("s3cret");
	});

	test("!command resolves via stdout", async () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"b","value":"!echo resolved-value"}\n');
		expect(await loadAuth().resolve("b")).toBe("resolved-value");
	});

	test("failing !command rejects with the secret name, not the value", async () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"c","value":"!exit 3"}\n');
		await expect(loadAuth().resolve("c")).rejects.toThrow('"c"');
	});

	test("a failing !command's stderr stays out of the error", async () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"f","value":"!echo hunter2 >&2; exit 1"}\n');
		const err = await loadAuth()
			.resolve("f")
			.catch((e: unknown) => e);
		expect((err as Error).message).toContain("exited 1");
		expect((err as Error).message).not.toContain("hunter2");
	});

	test("a lingering child can't wedge !command resolution", async () => {
		const dir = useHome();
		// The shell exits instantly; the orphaned sleep holds the pipe's
		// write end for 60s. The cut drain means possibly-incomplete output
		// — a maybe-partial secret must fail loud, bounded in time.
		writeAuth(dir, '{"name":"d","value":"!sleep 60 & echo partial"}\n');
		const started = Date.now();
		await expect(loadAuth().resolve("d")).rejects.toThrow('"d"');
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("oversized !command output is refused, not truncated into use", async () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"e","value":"!seq 1 500000"}\n');
		await expect(loadAuth().resolve("e")).rejects.toThrow('"e"');
	});

	test("malformed line fails loud with line number", () => {
		const dir = useHome();
		writeAuth(dir, '{"name":"a","value":"x"}\nnot json\n');
		expect(() => loadAuth()).toThrow("auth.jsonl:2");
	});
});
