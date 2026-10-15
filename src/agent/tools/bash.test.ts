import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config.ts";
import { bashTool } from "./bash.ts";

const opts = { toolCallId: "t1", messages: [], context: {} };

interface BashResult {
	exit_code?: number | null;
	timed_out?: boolean;
	truncated?: boolean;
	output?: string;
}

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "goblin-bash-"));
	process.env.GOBLIN_HOME = home;
});
afterEach(() => {
	delete process.env.GOBLIN_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("bash", () => {
	test("advertises the read-only doctor — the workspace form keeps ../doctor, other cwds get the shim absolute", () => {
		// The workspace form: ../doctor resolves from the deployment
		// workspace only.
		const ws = bashTool(paths.workspace());
		expect(ws.description).toContain("../doctor --json");
		expect(ws.description).toContain("does not authorize repairs or restarts");

		// Any other cwd is a project dir — the shim must be absolute, and
		// nothing embeds the cwd itself: two project dirs render the same
		// bytes.
		const tool = bashTool("/tmp");
		expect(tool.description).toContain(`${paths.doctorShim()} --json`);
		expect(tool.description).toContain("does not authorize repairs or restarts");
		expect(tool.description).toBe(bashTool("/another-workspace").description);
		expect(tool.description).not.toBe(ws.description);
	});

	test("returns output and exit code", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "echo hello" }, opts)) as BashResult;
		expect(out.output).toBe("hello\n");
		expect(out.exit_code).toBe(0);
		expect(out.truncated).toBeUndefined();
	});

	test("a flooded stream is reported as truncated, not silently cut", async () => {
		const t = bashTool("/tmp");
		const started = Date.now();
		// ~15 MB of output — the 4 MiB per-stream capture cap kills the
		// process long before it finishes.
		const out = (await t.execute!({ command: "seq 1 2000000" }, opts)) as BashResult;
		// The reader kills the process at the cap — the result must say so,
		// or the model reads partial output as complete.
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(out.truncated).toBe(true);
		expect(out.output).toContain("the process was stopped");
		expect(out.output).toContain("incomplete");
		// The capture still spills — the model gets a window plus the file.
		expect(out.output).toContain("[TRUNCATED");
		const file = /saved to: (\S+)/.exec(out.output!)?.[1] ?? "";
		expect(file.startsWith(join(home, "state", "bashcache"))).toBe(true);
		// The saved file is the partial capture — under the cap.
		expect(readFileSync(file, "utf8").length).toBeLessThanOrEqual(4 * 1024 * 1024);
	});

	test("over-budget output is windowed head+tail and spills the full text to state/bashcache", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "seq 1 20000" }, opts)) as BashResult;
		expect(out.truncated).toBe(true);
		// Tail-heavy window: the head survives (the old tail cut dropped it
		// for good), the middle elides on line boundaries.
		expect(out.output!.startsWith("1\n")).toBe(true);
		expect(out.output).toContain("[…]");
		expect(out.output).toContain("\n20000\n");
		expect(out.output).not.toContain("the process was stopped");
		const match = /saved to: (\S+)/.exec(out.output!);
		expect(match).not.toBeNull();
		const file = match![1]!;
		expect(file.startsWith(join(home, "state", "bashcache"))).toBe(true);
		expect(file.endsWith(".txt")).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(
			`${Array.from({ length: 20000 }, (_, i) => `${i + 1}`).join("\n")}\n`,
		);
	});

	test("small output stays whole — no footer, and the cache dir is never created", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "echo hi" }, opts)) as BashResult;
		expect(out.output).toBe("hi\n");
		expect(out.truncated).toBeUndefined();
		expect(existsSync(join(home, "state", "bashcache"))).toBe(false);
	});

	test("nonzero exit propagates", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "exit 3" }, opts)) as BashResult;
		expect(out.exit_code).toBe(3);
	});

	test("a backgrounded child holding the pipe can't outlive the command", async () => {
		const t = bashTool("/tmp");
		const started = Date.now();
		// The shell exits instantly; the orphaned sleep would hold stdout's
		// write end open for 60s — EOF must not outlive the command.
		const out = (await t.execute!({ command: "sleep 60 & echo hi" }, opts)) as BashResult;
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(out.output).toContain("hi");
		expect(out.exit_code).toBe(0);
		// The drain was cut while a writer was still alive — partial output
		// must be flagged, not presented as complete.
		expect(out.truncated).toBe(true);
	});

	test("a SIGTERM-ignoring process is escalated to SIGKILL", async () => {
		const t = bashTool("/tmp");
		const started = Date.now();
		const out = (await t.execute!(
			{ command: "trap '' TERM; sleep 60", timeout_ms: 200 },
			opts,
		)) as BashResult;
		expect(out.timed_out).toBe(true);
		expect(out.exit_code).toBeNull();
		// timeout + TERM grace + KILL — bounded, not the 60s sleep
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test("abort kills the process", async () => {
		const t = bashTool("/tmp");
		const controller = new AbortController();
		const started = Date.now();
		const p = (async () =>
			(await t.execute!(
				{ command: "sleep 60" },
				{ ...opts, abortSignal: controller.signal },
			)) as BashResult)();
		setTimeout(() => controller.abort(), 100);
		const out = await p;
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
