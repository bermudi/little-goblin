import { describe, expect, test } from "bun:test";
import { bashTool } from "./bash.ts";

const opts = { toolCallId: "t1", messages: [] };

interface BashResult {
	exit_code?: number | null;
	timed_out?: boolean;
	truncated?: boolean;
	output?: string;
}

describe("bash", () => {
	test("returns output and exit code", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "echo hello" }, opts)) as BashResult;
		expect(out.output).toBe("hello\n");
		expect(out.exit_code).toBe(0);
		expect(out.truncated).toBeUndefined();
	});

	test("a flooded stream is reported as truncated, not silently cut", async () => {
		const t = bashTool("/tmp");
		const out = (await t.execute!({ command: "seq 1 500000" }, opts)) as BashResult;
		// The reader kills the process at the cap — the result must say so,
		// or the model reads partial output as complete.
		expect(out.truncated).toBe(true);
		expect(out.output!.length).toBeLessThanOrEqual(100 * 1024);
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
		const out = (await t.execute!(
			{ command: "sleep 60 & echo hi" },
			opts,
		)) as BashResult;
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
