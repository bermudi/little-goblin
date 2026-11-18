import { describe, expect, test } from "bun:test";
import { T3Error, makeT3, t3CutShort, t3Waiting, t3Working, type T3RunResult } from "./t3.ts";
import { setLogFile, setLogWriter } from "./log.ts";

// The t3 CLI is faked at the process edge: the runner seam records the
// argv it was handed and replays canned results, so the tests pin the
// wire contract (flags, parsing, error mapping) without a server.

function fakeRunner(results: T3RunResult[]) {
	const calls: { args: string[]; opts: unknown }[] = [];
	const run = async (args: string[], opts?: unknown): Promise<T3RunResult> => {
		calls.push({ args, opts });
		const next = results.shift();
		if (!next) throw new Error(`unexpected t3 call: ${args.join(" ")}`);
		return next;
	};
	return { calls, run };
}

const ok = (body: unknown): T3RunResult => ({
	code: 0,
	stdout: JSON.stringify(body),
	stderr: "",
});

const THREAD = {
	threadId: "mcp:11111111-2222-3333-4444-555555555555",
	projectId: "proj-1",
	title: "do the thing",
	link: "https://t3.example/t/11111111",
	status: "running",
	createdAt: "2026-11-16T10:00:00.000Z",
	updatedAt: "2026-11-16T10:05:00.000Z",
};

describe("t3 adapter verbs", () => {
	test("start builds the pinned argv and parses the result", async () => {
		const f = fakeRunner([ok({ threadId: "t-1", projectId: "proj-9", runId: "run-1" })]);
		const t3 = makeT3(f.run);
		const out = await t3.startThread({
			project: "/repo",
			message: "fix the bug",
			provider: "codex",
			model: "gpt-6-luna",
		});
		expect(out).toEqual({ threadId: "t-1", projectId: "proj-9", runId: "run-1" });
		expect(f.calls[0]!.args).toEqual([
			"thread",
			"start",
			"/repo",
			"fix the bug",
			"--provider",
			"codex",
			"--model",
			"gpt-6-luna",
			"--json",
		]);
	});

	test("start appends title, worktree and branch only when given", async () => {
		const f = fakeRunner([ok({ threadId: "t-1", projectId: "p", runId: "r" })]);
		await makeT3(f.run).startThread({
			project: "/repo",
			message: "m",
			provider: "prov",
			model: "m-1",
			title: "deleg-3 fix",
			worktree: "main",
			branch: "issue/9",
		});
		expect(f.calls[0]!.args).toEqual([
			"thread",
			"start",
			"/repo",
			"m",
			"--provider",
			"prov",
			"--model",
			"m-1",
			"--json",
			"--title",
			"deleg-3 fix",
			"--worktree",
			"main",
			"--branch",
			"issue/9",
		]);
	});

	test("start sends sorted model options after the model", async () => {
		const f = fakeRunner([ok({ threadId: "t-1", projectId: "p", runId: "r" })]);
		await makeT3(f.run).startThread({
			project: "/repo",
			message: "m",
			provider: "prov",
			model: "m-1",
			options: { fastMode: false, effort: "low" },
		});
		expect(f.calls[0]!.args).toEqual([
			"thread", "start", "/repo", "m", "--provider", "prov",
			"--model", "m-1", "--option", "effort=low", "--option",
			"fastMode=false", "--json",
		]);
	});

	test("send addresses the thread and parses the delivery record", async () => {
		const f = fakeRunner([
			ok({
				threadId: "t-1",
				link: "https://t3.example/t/t-1",
				messageId: "m-7",
				runId: "run-2",
				status: "queued",
				delivery: "queued",
			}),
		]);
		const out = await makeT3(f.run).sendThread("t-1", "operator says yes");
		expect(out.runId).toBe("run-2");
		expect(f.calls[0]!.args).toEqual(["thread", "send", "t-1", "operator says yes", "--json"]);
	});

	test("show requests N messages and returns the parsed record", async () => {
		const f = fakeRunner([
			ok({
				thread: THREAD,
				messages: [
					{ role: "user", runId: "run-1", text: "go" },
					{ role: "assistant", runId: "run-1", text: "done: it works" },
				],
			}),
		]);
		const out = await makeT3(f.run).showThread(THREAD.threadId, 5);
		expect(f.calls[0]!.args).toEqual([
			"thread",
			"show",
			THREAD.threadId,
			"--messages",
			"5",
			"--json",
		]);
		expect(out!.messages.map((m) => m.text)).toEqual(["go", "done: it works"]);
	});

	test("list filters by project and parses the row array", async () => {
		const f = fakeRunner([ok([{ ...THREAD, status: "completed" }])]);
		const rows = await makeT3(f.run).listThreads("/repo");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("completed");
		expect(f.calls[0]!.args).toEqual(["thread", "list", "--project", "/repo", "--json"]);
	});
});

describe("t3 error mapping", () => {
	test("list's unknown project sentence maps to project_not_found", async () => {
		const f = fakeRunner([
			{
				code: 1,
				stdout: "",
				stderr: "No T3 Code project matches '/not-registered'. Pass a project id or a path inside a project.",
			},
		]);
		const err = await makeT3(f.run).listThreads("/not-registered").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(T3Error);
		expect((err as T3Error).code).toBe("project_not_found");
		expect((err as T3Error).kind).toBe("missing");
	});

	test("send's thread-gone sentence maps to thread_not_found", async () => {
		const f = fakeRunner([{ code: 1, stdout: "", stderr: "Thread t-1 was not found.\n" }]);
		const err = await makeT3(f.run).sendThread("t-1", "x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(T3Error);
		expect((err as T3Error).code).toBe("thread_not_found");
		expect((err as T3Error).kind).toBe("missing");
		expect((err as T3Error).message).toContain("t3 thread send failed (thread_not_found)");
	});

	test("show's thread-gone sentence resolves null, not a throw", async () => {
		const f = fakeRunner([
			{ code: 1, stdout: "", stderr: "Thread t-1 is no longer available.\n" },
		]);
		await expect(makeT3(f.run).showThread("t-1", 3)).resolves.toBeNull();
	});

	test("any other failure keeps its exit code and a capped stderr excerpt", async () => {
		const long = "x".repeat(500);
		const f = fakeRunner([{ code: 1, stdout: "", stderr: long }]);
		const err = await makeT3(f.run).listThreads("/repo").catch((e: unknown) => e);
		expect((err as T3Error).code).toBe("exit_1");
		expect((err as T3Error).kind).toBe("fatal");
		const msg = (err as T3Error).message;
		expect(msg.length).toBeLessThan(300);
		expect(msg).not.toContain(long);
	});

	test("non-JSON stdout on success fails loud, quoting no raw output", async () => {
		const f = fakeRunner([{ code: 0, stdout: "not json at all", stderr: "" }]);
		const err = await makeT3(f.run)
			.startThread({ project: "/r", message: "m", provider: "p", model: "m" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(T3Error);
		expect((err as T3Error).kind).toBe("fatal");
		expect((err as Error).message).not.toContain("not json at all");
	});

	test("a rejected runner is transient", async () => {
		const original = new Error("spawn");
		const err = await makeT3(async () => { throw original; })
			.listThreads("/repo").catch((e: unknown) => e);
		expect(err).toMatchObject({ boundary: "t3", kind: "transient" });
		expect(err).toMatchObject({ cause: original });
	});

	test("a result missing required fields fails zod, not silence", async () => {
		const f = fakeRunner([ok({ threadId: "t-1", projectId: "p" })]);
		await expect(
			makeT3(f.run).startThread({ project: "/r", message: "m", provider: "p", model: "m" }),
		).rejects.toThrow();
	});

	test("a pre-aborted signal refuses before the CLI runs", async () => {
		const f = fakeRunner([]);
		const ctrl = new AbortController();
		ctrl.abort(new Error("turn ended"));
		await expect(
			makeT3(f.run).sendThread("t-1", "x", { signal: ctrl.signal }),
		).rejects.toThrow("turn ended");
		expect(f.calls).toHaveLength(0);
	});

	test("a signal aborted mid-run reports the abort, not a CLI error", async () => {
		const f = fakeRunner([{ code: 1, stdout: "", stderr: "some cli error" }]);
		const ctrl = new AbortController();
		ctrl.abort();
		const err = await makeT3(f.run)
			.sendThread("t-1", "x", { signal: ctrl.signal })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).not.toContain("some cli error");
	});
});

describe("t3 logging", () => {
	test("every call logs one boundary line — ok and error outcomes", async () => {
		const lines: Record<string, unknown>[] = [];
		setLogFile("t3-test.log");
		setLogWriter((_p, line) => lines.push(JSON.parse(line) as Record<string, unknown>));
		try {
			const f = fakeRunner([
				ok({ threadId: "t-1", projectId: "p", runId: "r" }),
				{ code: 1, stdout: "", stderr: "Thread t-1 was not found.\n" },
			]);
			const t3 = makeT3(f.run);
			await t3.startThread({ project: "/r", message: "m", provider: "p", model: "m" });
			await t3.sendThread("t-1", "x").catch(() => {});
			const calls = lines.filter((l) => l.msg === "t3 call" || l.msg === "t3 call failed");
			expect(calls.map((l) => l.msg)).toEqual(["t3 call", "t3 call failed"]);
			expect(calls[0]).toMatchObject({ verb: "thread start", target: "/r", outcome: "ok" });
			expect(calls[1]).toMatchObject({
				verb: "thread send", target: "t-1", code: "thread_not_found",
				boundary: "t3", kind: "missing",
			});
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});
});

describe("thread status classifiers", () => {
	test("working covers the in-flight statuses only", () => {
		for (const s of ["preparing", "queued", "starting", "running"]) expect(t3Working(s)).toBe(true);
		for (const s of ["waiting", "idle", "completed", "failed", "interrupted", "weird"]) {
			expect(t3Working(s)).toBe(false);
		}
	});
	test("waiting is exactly the waiting status", () => {
		expect(t3Waiting("waiting")).toBe(true);
		expect(t3Waiting("running")).toBe(false);
	});
	test("cut short covers interrupted, cancelled and rolled_back", () => {
		for (const s of ["interrupted", "cancelled", "rolled_back"]) expect(t3CutShort(s)).toBe(true);
		expect(t3CutShort("failed")).toBe(false);
	});
});
