import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { memoryLimit } from "./test-memory-net.ts";

const repoRoot = resolve(import.meta.dir, "..");
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const CHILD_RSS_LIMIT = 768 * MiB;
const CHILD_TIMEOUT_MS = 30_000;
const ALLOC_FIXTURE = "./src/testkit/memory-net/alloc.fixture.ts";
const CALM_FIXTURE = "./src/testkit/memory-net/calm.fixture.ts";
const HOOK_FIXTURE = "./src/testkit/memory-net/hook.fixture.ts";
const EACH_FIXTURE = "./src/testkit/memory-net/each.fixture.ts";
const APP_FIXTURE = "./app/src/memory-net-dom.fixture.tsx";

type ChildRun = {
	file: string;
	exitCode: number;
	signalCode: NodeJS.Signals | number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
	peakRssBytes: number;
	guardFailure: string | null;
};

function readVmRss(pid: number): number | null {
	const path = `/proc/${pid}/status`;
	let status: string;
	try {
		status = readFileSync(path, "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ESRCH")
		) {
			return null;
		}
		throw error;
	}
	const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
	if (match === null) {
		if (/^State:\s+[ZX]\s+\((?:zombie|dead)\)\s*$/m.test(status)) return null;
		throw new Error(`memory net child status has no VmRSS: ${path}`);
	}
	return Number(match[1]) * 1024;
}

async function runFixture(file: string, parallel = false): Promise<ChildRun> {
	const startedAt = performance.now();
	const args = parallel
		? [process.execPath, "test", "--parallel", CALM_FIXTURE, ALLOC_FIXTURE]
		: [process.execPath, "test", file];
	// bun hides "(pass)" lines when it detects an AI agent (CLAUDECODE set),
	// and the probes read those lines: give the child plain reporter output.
	const { CLAUDECODE: _agent, ...env } = process.env;
	const child = Bun.spawn(args, {
		cwd: repoRoot,
		env: { ...env, GOBLIN_TEST_RSS_LIMIT_MB: "256" },
		stdout: "pipe",
		stderr: "pipe",
	});
	let finished = false;
	const exitPromise = child.exited.then((exitCode) => {
		finished = true;
		return exitCode;
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	let peakRssBytes = 0;
	let guardFailure: string | null = null;
	let killRequested = false;

	try {
		while (!finished) {
			const rss = readVmRss(child.pid);
			if (rss !== null) {
				peakRssBytes = Math.max(peakRssBytes, rss);
				if (rss > CHILD_RSS_LIMIT) {
					guardFailure = `parent safety guard killed child above ${CHILD_RSS_LIMIT} bytes`;
					child.kill("SIGKILL");
					killRequested = true;
					break;
				}
			}
			if (performance.now() - startedAt >= CHILD_TIMEOUT_MS) {
				guardFailure = `parent safety guard killed child after ${CHILD_TIMEOUT_MS} ms`;
				child.kill("SIGKILL");
				killRequested = true;
				break;
			}
			await Bun.sleep(100);
		}
	} finally {
		if (!finished && !killRequested) {
			child.kill("SIGKILL");
			killRequested = true;
		}
	}

	const [exitCode, stdout, stderr] = await Promise.all([
		exitPromise,
		stdoutPromise,
		stderrPromise,
	]);
	const result: ChildRun = {
		file,
		exitCode,
		signalCode: child.signalCode,
		stdout,
		stderr,
		elapsedMs: performance.now() - startedAt,
		peakRssBytes,
		guardFailure,
	};
	writeSync(
		2,
		`memory net child ${file} elapsed_ms=${Math.round(result.elapsedMs)} peak_rss_bytes=${result.peakRssBytes} exit=${result.signalCode ?? result.exitCode}\n`,
	);
	return result;
}

function diagnostic(run: ChildRun): string {
	return [
		`elapsed_ms=${Math.round(run.elapsedMs)}`,
		`peak_rss_bytes=${run.peakRssBytes}`,
		`exit=${run.signalCode ?? run.exitCode}`,
		run.guardFailure === null ? "" : `guard=${run.guardFailure}`,
		`stdout:\n${run.stdout.slice(-4_000)}`,
		`stderr:\n${run.stderr.slice(-4_000)}`,
	]
		.filter((line) => line !== "")
		.join("\n");
}

function requireCondition(condition: boolean, detail: string, run: ChildRun): void {
	if (!condition) throw new Error(`${detail}\n${diagnostic(run)}`);
}

function hasSigkill(run: ChildRun): boolean {
	return run.signalCode === "SIGKILL" || run.exitCode === 137;
}

describe("memory net child probes", () => {
	test("T1 stops a synchronous server allocation runaway", async () => {
		const run = await runFixture(ALLOC_FIXTURE);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(hasSigkill(run), "runaway child was not SIGKILLed", run);
		requireCondition(output.includes("memory runaway:"), "missing worker report", run);
		requireCondition(
			output.includes("running: runaway > allocates forever in synchronous code"),
			"missing current test name",
			run,
		);
		requireCondition(
			output.includes("registered at src/testkit/memory-net/alloc.fixture.ts:"),
			"missing registration file",
			run,
		);
		requireCondition(
			output.includes("(pass) runaway > a calm test passes first"),
			"calm test did not pass before the runaway",
			run,
		);
		requireCondition(run.elapsedMs < 10_000, "server runaway took 10 seconds or more", run);
		requireCondition(run.peakRssBytes < 400 * MiB, "server runaway exceeded 400 MiB", run);
	});

	test("T2 stops a mounted happy-dom app assertion runaway", async () => {
		const run = await runFixture(APP_FIXTURE);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(hasSigkill(run), "app runaway child was not SIGKILLed", run);
		requireCondition(output.includes("memory runaway:"), "missing worker report", run);
		requireCondition(
			output.includes("running: app runaway > a failed diff on a mounted node"),
			"missing current app test name",
			run,
		);
		requireCondition(
			output.includes("registered at app/src/memory-net-dom.fixture.tsx:"),
			"missing app fixture path",
			run,
		);
		requireCondition(run.elapsedMs < 15_000, "app runaway took 15 seconds or more", run);
		requireCondition(run.peakRssBytes < 400 * MiB, "app runaway exceeded 400 MiB", run);
	});

	test("T3 reports a runaway from a parallel test worker", async () => {
		const run = await runFixture(ALLOC_FIXTURE, true);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(run.exitCode !== 0, "parallel test coordinator exited successfully", run);
		requireCondition(output.includes("memory runaway:"), "parallel output hid worker report", run);
		requireCondition(
			output.includes("running: runaway > allocates forever in synchronous code"),
			"parallel output omitted the runaway test name",
			run,
		);
	});

	test("T4 calm and done-callback tests pass without a worker report", async () => {
		const run = await runFixture(CALM_FIXTURE);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(run.exitCode === 0, "calm fixture failed", run);
		requireCondition(!output.includes("memory runaway:"), "calm fixture hit the memory limit", run);
		requireCondition((output.match(/\(pass\)/g) ?? []).length >= 3, "fewer than 3 tests passed", run);
		requireCondition(output.includes("(pass) done style"), "done callback test did not pass", run);
	});

	test("T7 names a runaway beforeEach hook and its previous test", async () => {
		const run = await runFixture(HOOK_FIXTURE);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(hasSigkill(run), "runaway hook child was not SIGKILLed", run);
		requireCondition(
			output.includes("running: beforeEach hook registered at src/testkit/memory-net/hook.fixture.ts:"),
			"missing hook registration location",
			run,
		);
		requireCondition(output.includes('last test: "first"'), "missing previous test name", run);
		requireCondition(output.includes("(pass) first"), "first test did not pass before the hook", run);
	});

	test("T8 formats each-row names inside nested describes", async () => {
		const run = await runFixture(EACH_FIXTURE);
		const output = run.stdout + run.stderr;
		requireCondition(run.guardFailure === null, "parent safety guard fired", run);
		requireCondition(hasSigkill(run), "runaway each-row child was not SIGKILLed", run);
		requireCondition(
			output.includes("running: outer > inner > case 2"),
			"missing formatted nested test name",
			run,
		);
		requireCondition(
			output.includes("(pass) outer > inner > case 1"),
			"first each row did not pass before the runaway row",
			run,
		);
	});
});

describe("memoryLimit", () => {
	test("T5 uses a positive integer environment limit first", () => {
		expect(memoryLimit("256", 2 * GiB)).toEqual({
			bytes: 256 * MiB,
			why: "GOBLIN_TEST_RSS_LIMIT_MB=256",
		});
	});

	test.each(["0", "-1", "1.5", "abc", ""] as const)(
		"T5 rejects invalid environment value %j",
		(value) => {
			expect(() => memoryLimit(value, null)).toThrow(
				`GOBLIN_TEST_RSS_LIMIT_MB must be a positive integer string; received ${JSON.stringify(value)}`,
			);
		},
	);

	test("T5 uses 75 percent of a 2 GiB cgroup limit", () => {
		expect(memoryLimit(undefined, 2 * GiB)).toEqual({
			bytes: 1.5 * GiB,
			why: "75% of the 2.00 GiB cgroup limit",
		});
	});

	test("T5 caps large cgroup limits at the default 3 GiB", () => {
		expect(memoryLimit(undefined, 25 * GiB)).toEqual({
			bytes: 3 * GiB,
			why: "default 3 GiB",
		});
	});

	test("T5 uses the default 3 GiB when cgroup limits are unavailable", () => {
		expect(memoryLimit(undefined, null)).toEqual({
			bytes: 3 * GiB,
			why: "default 3 GiB",
		});
	});
});
