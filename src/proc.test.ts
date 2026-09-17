import { describe, expect, test } from "bun:test";
import { boundedRun, spawnProc } from "./proc.ts";

const OPTS = { timeoutMs: 30_000, maxOutput: 64 * 1024 };

describe("bounded subprocess", () => {
	test("returns output and exit code", async () => {
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "echo hi; echo err >&2"]), OPTS);
		expect(p.stdout).toBe("hi\n");
		expect(p.stderr).toBe("err\n");
		expect(p.exitCode).toBe(0);
		expect(p.timedOut).toBe(false);
		expect(p.truncated).toBe(false);
	});

	test("a flooded stream is killed and flagged truncated", async () => {
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "seq 1 500000"]), {
			...OPTS,
			maxOutput: 10 * 1024,
		});
		expect(p.truncated).toBe(true);
		expect(p.stdout.length).toBeLessThanOrEqual(10 * 1024);
	});

	test("a backgrounded child holding the pipe can't outlive the command", async () => {
		const started = Date.now();
		// The shell exits instantly; the orphaned sleep would hold stdout's
		// write end open for 60s — EOF must not outlive the command.
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "sleep 60 & echo hi"]), OPTS);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(p.stdout).toContain("hi");
		expect(p.exitCode).toBe(0);
		// The drain was cut while a writer was still alive — partial output
		// must be flagged, not presented as complete.
		expect(p.truncated).toBe(true);
	});

	test("a SIGTERM-ignoring process is escalated to SIGKILL", async () => {
		const started = Date.now();
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "trap '' TERM; sleep 60"]), {
			...OPTS,
			timeoutMs: 200,
		});
		expect(p.timedOut).toBe(true);
		// timeout + TERM grace + KILL — bounded, not the 60s sleep
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test("abort kills the process", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const p = boundedRun(spawnProc(["/bin/sh", "-c", "sleep 60"]), {
			...OPTS,
			abortSignal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		await p;
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
