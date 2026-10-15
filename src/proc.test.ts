import { describe, expect, test } from "bun:test";
import { boundedRun, boundedRunBinary, spawnProc } from "./proc.ts";

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

	test("inherited mode terminates only the probe, never the caller group", async () => {
		const controller = new AbortController();
		const proc = spawnProc(["/bin/sh", "-c", "exec sleep 60"], undefined, undefined, "inherit");
		const pending = boundedRun(proc, {
			...OPTS,
			processGroup: "inherit",
			abortSignal: controller.signal,
		});
		controller.abort();
		expect((await pending).exitCode).not.toBe(0);
		expect(process.pid).toBeGreaterThan(0);
	});

	test("a flooded stream is killed and flagged truncated", async () => {
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "seq 1 500000"]), {
			...OPTS,
			maxOutput: 10 * 1024,
		});
		expect(p.truncated).toBe(true);
		expect(p.stdout.length).toBeLessThanOrEqual(10 * 1024);
	});

	test("a flooded stdout is flagged outputCapped — not timedOut", async () => {
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "seq 1 500000"]), {
			...OPTS,
			maxOutput: 10 * 1024,
		});
		expect(p.outputCapped).toBe(true);
		expect(p.truncated).toBe(true);
		expect(p.timedOut).toBe(false);
	});

	test("a flooded stderr is flagged outputCapped too", async () => {
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "seq 1 500000 >&2"]), {
			...OPTS,
			maxOutput: 10 * 1024,
		});
		expect(p.outputCapped).toBe(true);
		expect(p.truncated).toBe(true);
		expect(p.timedOut).toBe(false);
		expect(p.stderr.length).toBeLessThanOrEqual(10 * 1024);
	});

	test("the binary collector reports the same outputCapped verdict", async () => {
		const p = await boundedRunBinary(spawnProc(["/bin/sh", "-c", "seq 1 500000"]), {
			...OPTS,
			maxOutput: 10 * 1024,
		});
		expect(p.outputCapped).toBe(true);
		expect(p.truncated).toBe(true);
		expect(p.timedOut).toBe(false);
		expect(p.stdout.byteLength).toBeLessThanOrEqual(10 * 1024);
	});

	test("a post-exit drain cutoff is truncated but not outputCapped", async () => {
		// The shell exits instantly; the orphaned writer keeps stdout
		// open, so the drain window cuts it — no stream cap was hit.
		const p = await boundedRun(spawnProc(["/bin/sh", "-c", "sleep 60 & echo hi"]), OPTS);
		expect(p.truncated).toBe(true);
		expect(p.outputCapped).not.toBe(true);
		expect(p.timedOut).toBe(false);
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
