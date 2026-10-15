import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		// The reader kills at the cap; its partial capture must not read as complete.
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(out.truncated).toBe(true);
		expect(out.output).toContain("output exceeded the capture cap or was cut");
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

	test("a failed spill keeps the window and exit code — the footer reports the lost save", async () => {
		// A regular file where bashcache belongs: mkdirSync can't recover.
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(join(home, "state", "bashcache"), "x");
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "seq 1 20000" }, opts)) as BashResult;
		expect(out.exit_code).toBe(0);
		expect(out.truncated).toBe(true);
		expect(out.output).toContain("[…]");
		expect(out.output).toContain("\n20000\n");
		expect(out.output).toContain("could not be saved");
		expect(out.output).not.toContain("saved to:");
	});

	test("a long newline-terminated line retains its final status in the display and spill", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!(
			{
				command: "printf '%20000sFINAL_STATUS\\n' ''",
			},
			opts,
		)) as BashResult;
		expect(out.truncated).toBe(true);
		expect(out.output).toContain("FINAL_STATUS\n");
		const file = /saved to: (\S+)/.exec(out.output!)![1]!;
		expect(readFileSync(file, "utf8")).toBe(`${" ".repeat(20_000)}FINAL_STATUS\n`);
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

	test("a pipe-drain cutoff reports incomplete capture without claiming the surviving child stopped", async () => {
		const t = bashTool("/tmp");
		const started = Date.now();
		// The shell exits instantly; the orphaned sleep would hold stdout's
		// write end open for 10s — capture must return without waiting for EOF.
		const out = (await t.execute!({ command: "sleep 10 & echo $!" }, opts)) as BashResult;
		const pid = Number(out.output!.split("\n")[0]);
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		try {
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(out.exit_code).toBe(0);
			expect(process.kill(pid, 0)).toBe(true);
			expect(out.truncated).toBe(true);
			expect(out.output).toContain("incomplete");
			expect(out.output).toContain("background processes may still be running");
			expect(out.output).not.toContain("the process was stopped");
		} finally {
			process.kill(pid, "SIGTERM");
		}
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
