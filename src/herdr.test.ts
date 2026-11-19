import { describe, expect, test } from "bun:test";
import {
	HerdrError,
	WorkspaceCreateError,
	makeHerdr,
	type HerdrCallOpts,
	type HerdrRunResult,
} from "./herdr.ts";
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

const ok = (body: unknown): HerdrRunResult => ({
	code: 0,
	stdout: JSON.stringify(body),
	stderr: "",
});
const fail = (code: string, message: string): HerdrRunResult => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ error: { code, message }, id: "cli:x" }),
});

describe("herdr adapter", () => {

	test("createWorkspace runs under the session and parses ids", async () => {
		const f = fakeRunner([
			ok({
				result: {
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1", cwd: "/tmp/x" },
				},
			}),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const ws = await h.createWorkspace("/tmp/x", "task one");
		expect(ws).toEqual({ workspaceId: "w9", paneId: "w9:p1", cwd: "/tmp/x" });
		expect(f.calls[0]).toEqual([
			"--session",
			"goblin",
			"workspace",
			"create",
			"--cwd",
			"/tmp/x",
			"--label",
			"task one",
			"--no-focus",
		]);
	});

	test.each([
		[{ pane_id: "w9:p1" }, "root pane cwd unavailable"],
		[{ pane_id: "w9:p1", cwd: 42 }, "invalid root pane response"],
		[{ cwd: "/w" }, "invalid root pane response"],
	] as const)(
		"unusable created pane %j retains its workspace identity",
		async (rootPane, reason) => {
			const f = fakeRunner([
				ok({
					result: { workspace: { workspace_id: "w9" }, root_pane: rootPane },
				}),
			]);
			const h = makeHerdr({ session: "probe" }, f.run);
			try {
				await h.createWorkspace("~/requested", "task");
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(WorkspaceCreateError);
				if (!(err instanceof WorkspaceCreateError)) throw err;
				expect(err.workspaceId).toBe("w9");
				expect(err.message).toContain(reason);
				expect(err.message).not.toContain("~/requested");
			}
		},
	);

	test("startAgent appends native args after -- and returns the record", async () => {
		const f = fakeRunner([ok({ result: { agent: AGENT, type: "agent_started" } })]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const info = await h.startAgent("g1-test", "codex", "w9:p1", ["--yolo"]);
		expect(info.name).toBe("g1-test");
		expect(info.agent_status).toBe("idle");
		expect(info.state_change_seq).toBe(3);
		expect(f.calls[0]).toEqual([
			"--session",
			"goblin",
			"agent",
			"start",
			"g1-test",
			"--kind",
			"codex",
			"--pane",
			"w9:p1",
			"--",
			"--yolo",
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

	test("an agent record without state_change_seq fails loud: the server is too old", async () => {
		const f = fakeRunner([ok({ result: { agent: { ...AGENT, state_change_seq: undefined } } })]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		try {
			await h.get("g1-test");
			expect.unreachable();
		} catch (err) {
			// JSON.stringify drops the undefined key — the wire omits the field.
			expect((err as Error).message).toContain("state_change_seq");
			expect((err as Error).message).toContain("the herdr server is too old");
		}
	});

	test("an agent record without completion_seq parses — absent means no completed work", async () => {
		const f = fakeRunner([ok({ result: { agent: AGENT } })]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		const info = await h.get("g1-test");
		expect(info?.completion_seq).toBeUndefined();
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
			"--session",
			"goblin",
			"agent",
			"read",
			"g1-x",
			"--source",
			"recent-unwrapped",
			"--lines",
			"40",
		]);
	});

	// Screen text is data, never an error message — a cap-killed read
	// must not pour raw stdout into the error.
	test("a killed agent read never quotes stdout in the error", async () => {
		const screen = `agent screen flood\n${"x".repeat(200_000)}`;
		const f = fakeRunner([{ code: -1, stdout: screen, stderr: "" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		try {
			await h.readAgent("g1-x", 40);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrError);
			const message = (err as Error).message;
			expect(message).not.toContain("agent screen flood");
			expect(message).not.toContain("xxxx");
			expect(message.length).toBeLessThan(200);
		}
	});

	test("a killed pane read never quotes stdout in the error either", async () => {
		const f = fakeRunner([{ code: -1, stdout: "y".repeat(500_000), stderr: "" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		try {
			await h.readPane("w1:p1", 80);
			expect.unreachable();
		} catch (err) {
			const message = (err as Error).message;
			expect(message).not.toContain("yyyy");
			expect(message.length).toBeLessThan(200);
		}
	});

	test("a non-envelope fallback message is capped", async () => {
		const flood = `usage: herdr agent get <target>\n${"e".repeat(100_000)}`;
		const f = fakeRunner([{ code: 2, stdout: "", stderr: flood }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		try {
			await h.get("x");
			expect.unreachable();
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("usage: herdr agent get <target>");
			expect(message.length).toBeLessThan(300);
		}
	});

	test("garbage stdout throws with the verb attached", async () => {
		const f = fakeRunner([{ code: 0, stdout: "not json", stderr: "" }]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		await expect(h.createWorkspace("/x", "l")).rejects.toThrow(/workspace create.*not JSON/);
	});

	test("invalid output and runner rejection never log a successful call", async () => {
		const lines: Array<{ msg: string; outcome?: string }> = [];
		setLogFile("herdr-test.log");
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as { msg: string; outcome?: string });
		});
		try {
			const invalid = makeHerdr({ session: "probe" }, async () => ({
				code: 0,
				stdout: "not json",
				stderr: "",
			}));
			await expect(invalid.get("a")).rejects.toThrow("not JSON");
			const rejected = makeHerdr({ session: "probe" }, async () => {
				throw new Error("socket refused");
			});
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

// Prompt verifies pane+kind immediately before one send — nothing is
// ever retried or re-read after a send.

const OP_AGENT = {
	agent: "pi",
	agent_status: "idle",
	pane_id: "w1:p1",
	workspace_id: "w1",
	tab_id: "w1:t1",
	terminal_title: "π - tmp",
	state_change_seq: 1,
	cwd: "/tmp",
};

const opOk = (body: unknown): HerdrRunResult => ({
	code: 0,
	stdout: JSON.stringify(body),
	stderr: "",
});
const opFail = (code: string, message: string): HerdrRunResult => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ error: { code, message }, id: "cli:x" }),
});

function opRunner(results: Array<HerdrRunResult | ((args: string[]) => HerdrRunResult)>) {
	const calls: { args: string[]; opts?: HerdrCallOpts | undefined }[] = [];
	const run = async (args: string[], opts?: HerdrCallOpts): Promise<HerdrRunResult> => {
		calls.push({ args, opts });
		const next = results.shift();
		if (!next) throw new Error(`unexpected herdr call: ${args.join(" ")}`);
		return typeof next === "function" ? next(args) : next;
	};
	return { calls, run };
}

const verbOf = (args: string[]): string => args.slice(2, 4).join(" ");
const prompts = (calls: { args: string[] }[]): string[][] =>
	calls.filter((c) => verbOf(c.args) === "agent prompt").map((c) => c.args);

const TOPOLOGY = [
	opOk({
		result: {
			workspaces: [
				{ workspace_id: "w1", label: "main" },
				{ workspace_id: "w8B", label: "scratch" },
			],
		},
	}),
	opOk({ result: { tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "work" }] } }),
	opOk({ result: { tabs: [{ tab_id: "w8B:t1", workspace_id: "w8B", label: "other" }] } }),
];

describe("herdr adapter — prompt delivery", () => {
	const agent = (status: string, seq: number) => ok({ result: { agent: { ...AGENT, agent_status: status, state_change_seq: seq } } });
	const sent = ok({ id: "cli:agent:prompt", result: {} });
	const noSleep = async () => {};
	const verbs = (calls: string[][]) => calls.map((c) => c.slice(2, 4).join(" "));

	test("an idle agent that starts working needs no recovery", async () => {
		const f = fakeRunner([agent("idle", 3), sent, agent("working", 4)]);
		await makeHerdr({ session: "goblin" }, f.run, 1000, noSleep).prompt("g1-test", "task");
		expect(verbs(f.calls)).toEqual(["agent get", "agent prompt", "agent get"]);
	});

	test("an unsent draft gets one recovery Enter", async () => {
		const idle = Array.from({ length: 8 }, () => agent("idle", 3));
		const f = fakeRunner([agent("idle", 3), sent, ...idle.slice(0, 8), ok({ id: "k", result: {} }), agent("working", 4)]);
		await makeHerdr({ session: "goblin" }, f.run, 1000, noSleep).prompt("g1-test", "task");
		expect(f.calls.some((c) => c.includes("send-keys") && c.includes("enter"))).toBe(true);
	});

	test("still idle after the recovery Enter fails loud", async () => {
		const idle = Array.from({ length: 16 }, () => agent("idle", 3));
		const f = fakeRunner([agent("idle", 3), sent, ...idle.slice(0, 8), ok({ id: "k", result: {} }), ...idle.slice(8)]);
		await expect(
			makeHerdr({ session: "goblin" }, f.run, 1000, noSleep).prompt("g1-test", "task"),
		).rejects.toMatchObject({ code: "agent_prompt_unsubmitted" });
	});

	test("a working agent is not probed for a draft", async () => {
		const f = fakeRunner([agent("working", 3), sent]);
		await makeHerdr({ session: "goblin" }, f.run, 1000, noSleep).prompt("g1-test", "task");
		expect(verbs(f.calls)).toEqual(["agent get", "agent prompt"]);
	});

	test("a leading-dash task text rides after --, never parsed as a flag", async () => {
		const f = opRunner([agent("idle", 3), sent, agent("working", 4)]);
		await makeHerdr({ session: "goblin" }, f.run, 1000, noSleep).prompt("g1-test", "--help me");
		expect(prompts(f.calls)).toHaveLength(1);
		expect(prompts(f.calls)[0]!.slice(-3)).toEqual(["--", "g1-test", "--help me"]);
	});
});
