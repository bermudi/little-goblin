// The herdr adapter's boundary contract: argv shape, envelope parsing,
// and the error translation — non-zero exits throw HerdrError carrying
// the stderr JSON, and agent_not_found on `get` alone maps to null.

import { describe, expect, test } from "bun:test";
import { HerdrError, makeHerdr, type HerdrRunResult } from "./herdr.ts";
import { setLogFile, setLogWriter } from "./log.ts";

function fakeRunner(results: HerdrRunResult[]) {
	const calls: string[][] = [];
	const run = async (args: string[]): Promise<HerdrRunResult> => {
		calls.push(args);
		const next = results.shift();
		if (!next) throw new Error(`unexpected herdr call: ${args.join(" ")}`);
		return next;
	};
	return { calls, run };
}

const AGENT = {
	agent: "codex",
	agent_status: "idle",
	name: "g1-test",
	pane_id: "w1:p1",
	workspace_id: "w1",
	state_change_seq: 3,
	cwd: "/w",
	interactive_ready: true,
};

const ok = (body: unknown): HerdrRunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const fail = (code: string, message: string): HerdrRunResult => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ error: { code, message }, id: "cli:x" }),
});

describe("herdr adapter", () => {
	test("a machine target prefixes --machine and never --session", async () => {
		const f = fakeRunner([
			ok({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
		]);
		const h = makeHerdr({ machine: "g7" }, f.run);
		await h.createWorkspace("/remote/x", "task one");
		expect(f.calls[0]).toEqual([
			"--machine", "g7",
			"workspace", "create", "--cwd", "/remote/x", "--label", "task one", "--no-focus",
		]);
	});

	test("createWorkspace runs under the session and parses ids", async () => {
		const f = fakeRunner([
			ok({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const ws = await h.createWorkspace("/tmp/x", "task one");
		expect(ws).toEqual({ workspaceId: "w9", paneId: "w9:p1" });
		expect(f.calls[0]).toEqual([
			"--session", "goblin",
			"workspace", "create", "--cwd", "/tmp/x", "--label", "task one", "--no-focus",
		]);
	});

	test("startAgent appends native args after -- and returns the record", async () => {
		const f = fakeRunner([ok({ result: { agent: AGENT, type: "agent_started" } })]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const info = await h.startAgent("g1-test", "codex", "w9:p1", ["--yolo"]);
		expect(info.name).toBe("g1-test");
		expect(info.agent_status).toBe("idle");
		expect(info.state_change_seq).toBe(3);
		expect(f.calls[0]).toEqual([
			"--session", "goblin",
			"agent", "start", "g1-test", "--kind", "codex", "--pane", "w9:p1",
			"--", "--yolo",
		]);
	});

	test("get returns the parsed record; extra herdr fields are stripped", async () => {
		const f = fakeRunner([
			ok({ result: { agent: { ...AGENT, terminal_id: "t1", revision: 9 }, type: "agent_info" } }),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const info = await h.get("g1-test");
		expect(info?.pane_id).toBe("w1:p1");
		expect(info).not.toHaveProperty("terminal_id");
	});

	test("get maps agent_not_found to null, other codes still throw", async () => {
		const f = fakeRunner([
			fail("agent_not_found", "agent target ghost not found"),
			fail("server_gone", "socket refused"),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		expect(await h.get("ghost")).toBeNull();
		await expect(h.get("x")).rejects.toThrow(/server_gone.*socket refused/);
	});

	test("a non-zero exit throws HerdrError carrying the stderr envelope", async () => {
		const f = fakeRunner([fail("agent_not_ready", "agent g1-x is blocked during startup")]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		try {
			await h.startAgent("g1-x", "codex", "w1:p1", []);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrError);
			expect((err as HerdrError).code).toBe("agent_not_ready");
			expect((err as Error).message).toContain("blocked during startup");
		}
	});

	test("a non-zero exit without the envelope still throws with raw stderr", async () => {
		const f = fakeRunner([{ code: 2, stdout: "", stderr: "usage: herdr agent get <target>" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		await expect(h.get("x")).rejects.toThrow(/exit_2.*usage: herdr agent get/);
	});

	test("readAgent returns the raw screen text, not the envelope", async () => {
		const f = fakeRunner([{ code: 0, stdout: "line1\nline2\n", stderr: "" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		expect(await h.readAgent("g1-x", 40)).toBe("line1\nline2\n");
		expect(f.calls[0]).toEqual([
			"--session", "goblin",
			"agent", "read", "g1-x", "--source", "recent-unwrapped", "--lines", "40",
		]);
	});

	test("garbage stdout throws with the verb attached", async () => {
		const f = fakeRunner([{ code: 0, stdout: "not json", stderr: "" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		await expect(h.createWorkspace("/x", "l")).rejects.toThrow(/workspace create.*not JSON/);
	});

	test("invalid output and runner rejection never log a successful call", async () => {
		const lines: Array<{ msg: string; outcome?: string }> = [];
		setLogFile("herdr-test.log");
		setLogWriter((_path, line) => { lines.push(JSON.parse(line) as { msg: string; outcome?: string }); });
		try {
			const invalid = makeHerdr({ session: "probe" }, async () => ({ code: 0, stdout: "not json", stderr: "" }));
			await expect(invalid.get("a")).rejects.toThrow("not JSON");
			const rejected = makeHerdr({ session: "probe" }, async () => { throw new Error("socket refused"); });
			await expect(rejected.get("a")).rejects.toThrow("socket refused");
			expect(lines.map((line) => line.msg)).toContain("herdr call returned invalid output");
			expect(lines.map((line) => line.msg)).toContain("herdr call runner failed");
			expect(lines.filter((line) => line.outcome === "ok")).toEqual([]);
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});
});
