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
});
