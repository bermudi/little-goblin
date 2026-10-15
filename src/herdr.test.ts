// The herdr adapter's boundary contract: argv shape, envelope parsing,
// and the error translation — non-zero exits throw HerdrError carrying
// the stderr JSON, and agent_not_found on `get` alone maps to null.

import { describe, expect, test } from "bun:test";
import {
	HerdrError,
	HerdrRefusal,
	WorkspaceCreateError,
	makeHerdr,
	makeOperatorHerdr,
	type HerdrCallOpts,
	type HerdrRunResult,
	type OperatorHerdr,
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
	test("a machine target prefixes --machine and never --session", async () => {
		const f = fakeRunner([
			ok({
				result: {
					workspace: { workspace_id: "w9" },
					root_pane: { pane_id: "w9:p1", cwd: "/tmp/x" },
				},
			}),
		]);
		const h = makeHerdr({ machine: "g7" }, f.run);
		await h.createWorkspace("/remote/x", "task one");
		expect(f.calls[0]).toEqual([
			"--machine",
			"g7",
			"workspace",
			"create",
			"--cwd",
			"/remote/x",
			"--label",
			"task one",
			"--no-focus",
		]);
	});

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

	test("paneRun takes the CLI's silent success and a future envelope", async () => {
		const f = fakeRunner([
			{ code: 0, stdout: "", stderr: "" },
			ok({ id: "cli:pane:run", result: { type: "ok" } }),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		await h.paneRun("w1:p1", "printf seed");
		await h.paneRun("w1:p1", "printf seed");
		expect(f.calls[0]).toEqual(["--session", "goblin", "pane", "run", "w1:p1", "printf seed"]);
	});

	test("paneWaitOutput sends the match/timeout argv and takes any envelope", async () => {
		const f = fakeRunner([
			ok({ id: "cli:pane:wait-output", result: { type: "output_matched", matched_line: "SEED" } }),
		]);
		const h = makeHerdr({ session: "goblin" }, f.run);
		await h.paneWaitOutput("w1:p1", "SEED", 5_000);
		expect(f.calls[0]).toEqual([
			"--session",
			"goblin",
			"pane",
			"wait-output",
			"w1:p1",
			"--match",
			"SEED",
			"--timeout",
			"5000",
		]);
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

	// #98: a cap-killed read (output > 1 MiB → SIGKILL → empty stderr)
	// used to fall back to stdout — up to 1 MiB of raw agent screen
	// text poured into the error string, goblin.log, and the model as
	// unfenced prose. Screen text is data, never an error message.
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

	// Non-read verbs may quote non-envelope CLI text, but bounded: a
	// usage flood on stderr is an excerpt for a human, not a relay.
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

// The operator adapter's boundary contract (design/delegation.md → "A
// herdr tool reaches the operator's session"): every call pins
// --session default, list joins agent/workspace/tab records, prompt
// verifies pane+kind immediately before one send, and abort/timeout
// semantics are checked — nothing is ever retried or re-read after a
// send. The runner is the fake edge; calls also record the opts.

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

describe("operator herdr adapter", () => {
	test("every verb runs under --session default", async () => {
		const f = opRunner([
			opOk({ result: { agents: [] } }),
			opOk({ result: { workspaces: [] } }), // prompt's topology
			// get + prompt for the success path:
			opOk({ result: { agent: { ...OP_AGENT, agent_status: "working" } } }),
			opOk({ result: { agent: { ...OP_AGENT, agent_status: "working" } } }),
			{ code: 0, stdout: "screen text\n", stderr: "" }, // read
		]);
		const h: OperatorHerdr = makeOperatorHerdr(f.run);
		expect(await h.list()).toEqual([]);
		await h.prompt("w1:p1", "pi", "hello");
		expect(await h.read("w1:p1", 10)).toBe("screen text\n");
		for (const c of f.calls) expect(c.args.slice(0, 2)).toEqual(["--session", "default"]);
		expect(f.calls.map((c) => verbOf(c.args))).toEqual([
			"agent list",
			"workspace list",
			"agent get",
			"agent prompt",
			"agent read",
		]);
	});

	test("list with no agents skips the topology joins entirely", async () => {
		const f = opRunner([opOk({ result: { agents: [] } })]);
		const h = makeOperatorHerdr(f.run);
		expect(await h.list()).toEqual([]);
		expect(f.calls).toHaveLength(1);
		expect(verbOf(f.calls[0]!.args)).toBe("agent list");
	});

	test("list joins labels across workspaces; unnamed agents omit name", async () => {
		const f = opRunner([
			opOk({
				result: {
					agents: [
						OP_AGENT,
						{ ...OP_AGENT, pane_id: "w1:p2", name: "dev-review" },
						{ ...OP_AGENT, pane_id: "w8B:p1", workspace_id: "w8B", tab_id: "w8B:t1" },
					],
				},
			}),
			...TOPOLOGY,
		]);
		const h = makeOperatorHerdr(f.run);
		const agents = await h.list();
		// Same kind + same cwd, three distinct panes — IDs carry identity.
		expect(agents.map((a) => a.pane_id)).toEqual(["w1:p1", "w1:p2", "w8B:p1"]);
		expect(agents[0]).not.toHaveProperty("name");
		expect(agents[0]).toMatchObject({
			agent: "pi",
			workspace_label: "main",
			tab_label: "work",
			cwd: "/tmp",
			terminal_title: "π - tmp",
		});
		expect(agents[1]!.name).toBe("dev-review");
		expect(agents[2]).toMatchObject({ workspace_label: "scratch", tab_label: "other" });
		// The second workspace's tabs came from its own scoped call.
		expect(f.calls[3]!.args).toEqual(["--session", "default", "tab", "list", "--workspace", "w8B"]);
	});

	test("an agent whose topology rows vanished mid-list gets null labels, not invented ones", async () => {
		const f = opRunner([
			opOk({
				result: {
					agents: [{ ...OP_AGENT, workspace_id: "wGone", tab_id: "wGone:t9" }],
				},
			}),
			opOk({ result: { workspaces: [{ workspace_id: "w1", label: "main" }] } }),
			opOk({ result: { tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "work" }] } }),
		]);
		const h = makeOperatorHerdr(f.run);
		const agents = await h.list();
		expect(agents[0]).toMatchObject({
			pane_id: "w1:p1",
			workspace_id: "wGone",
			tab_id: "wGone:t9",
			workspace_label: null,
			tab_label: null,
		});
	});

	test("list skips a workspace closed during tab collection and continues joining labels", async () => {
		const other = { ...OP_AGENT, pane_id: "w8B:p1", workspace_id: "w8B", tab_id: "w8B:t1" };
		const f = opRunner([
			opOk({ result: { agents: [OP_AGENT, other] } }),
			TOPOLOGY[0]!,
			opFail("workspace_not_found", "workspace w1 not found"),
			TOPOLOGY[2]!,
		]);
		const agents = await makeOperatorHerdr(f.run).list();
		expect(agents).toHaveLength(2);
		expect(agents[0]).toMatchObject({
			pane_id: "w1:p1",
			workspace_label: null,
			tab_label: null,
		});
		expect(agents[1]).toMatchObject({
			pane_id: "w8B:p1",
			workspace_label: "scratch",
			tab_label: "other",
		});
		expect(f.calls.map((c) => c.args)).toEqual([
			["--session", "default", "agent", "list"],
			["--session", "default", "workspace", "list"],
			["--session", "default", "tab", "list", "--workspace", "w1"],
			["--session", "default", "tab", "list", "--workspace", "w8B"],
		]);
	});

	test("prompt still sends once to an unaffected pane when another workspace closes during topology collection", async () => {
		const other = {
			...OP_AGENT,
			pane_id: "w8B:p1",
			workspace_id: "w8B",
			tab_id: "w8B:t1",
			agent_status: "working",
		};
		const f = opRunner([
			TOPOLOGY[0]!,
			opFail("workspace_not_found", "workspace w1 not found"),
			TOPOLOGY[2]!,
			opOk({ result: { agent: other } }),
			opOk({ result: { agent: other } }),
		]);
		const out = await makeOperatorHerdr(f.run).prompt("w8B:p1", "pi", "hello");
		expect(out).toMatchObject({
			pane_id: "w8B:p1",
			workspace_label: "scratch",
			tab_label: "other",
		});
		expect(f.calls.map((c) => verbOf(c.args))).toEqual([
			"workspace list",
			"tab list",
			"tab list",
			"agent get",
			"agent prompt",
		]);
		expect(prompts(f.calls)).toHaveLength(1);
		expect(prompts(f.calls)[0]!.slice(-2)).toEqual(["w8B:p1", "hello"]);
	});

	test.each(["list", "prompt"] as const)(
		"%s fails fast on other tab-list errors and malformed topology",
		async (verb) => {
			for (const failure of [
				opFail("timeout", "workspace_not_found"),
				{ code: 0, stdout: "not json", stderr: "" },
				opOk({ result: { tabs: null } }),
			]) {
				const f = opRunner([
					...(verb === "list" ? [opOk({ result: { agents: [OP_AGENT] } })] : []),
					TOPOLOGY[0]!,
					failure,
				]);
				const h = makeOperatorHerdr(f.run);
				const result = verb === "list" ? h.list() : h.prompt("w1:p1", "pi", "hello");
				if (failure.code !== 0) await expect(result).rejects.toMatchObject({ code: "timeout" });
				else await expect(result).rejects.toThrow();
				expect(f.calls.map((c) => verbOf(c.args))).toEqual([
					...(verb === "list" ? ["agent list"] : []),
					"workspace list",
					"tab list",
				]);
				expect(prompts(f.calls)).toEqual([]);
			}
		},
	);

	test("read sends the bounded argv and returns raw screen text", async () => {
		const f = opRunner([{ code: 0, stdout: "a\nb\n", stderr: "" }]);
		const h = makeOperatorHerdr(f.run);
		expect(await h.read("w8B:p8", 400)).toBe("a\nb\n");
		expect(f.calls[0]!.args).toEqual([
			"--session",
			"default",
			"agent",
			"read",
			"w8B:p8",
			"--source",
			"recent-unwrapped",
			"--lines",
			"400",
		]);
	});

	test("prompt: topology, then get, then one send — text rides as ONE argv element", async () => {
		const text = "line one\nline two $(rm -rf ~) `tick` ; & | > <\n/new-style text";
		const f = opRunner([
			...TOPOLOGY,
			opOk({ result: { agent: OP_AGENT } }),
			opOk({ result: { agent: { ...OP_AGENT, agent_status: "working" } } }),
		]);
		const h = makeOperatorHerdr(f.run);
		const out = await h.prompt("w1:p1", "pi", text);
		expect(f.calls.map((c) => verbOf(c.args))).toEqual([
			"workspace list",
			"tab list",
			"tab list",
			"agent get",
			"agent prompt",
		]);
		expect(f.calls[4]!.args).toEqual([
			"--session",
			"default",
			"agent",
			"prompt",
			"--wait",
			"--until",
			"working",
			"--until",
			"blocked",
			"--timeout",
			"120000",
			"--",
			"w1:p1",
			text,
		]);
		// The prompt's process budget rides above the CLI's own wait.
		expect(f.calls[4]!.opts?.timeoutMs).toBe(125_000);
		// The echo is the record herdr returned from the matched wait
		// (status is validated to working|blocked by the response check).
		expect(out).toMatchObject({
			pane_id: "w1:p1",
			agent: "pi",
			agent_status: "working",
			workspace_label: "main",
			tab_label: "work",
		});
	});

	test("prompt on a mismatched kind refuses before any send", async () => {
		const f = opRunner([...TOPOLOGY, opOk({ result: { agent: { ...OP_AGENT, agent: "devin" } } })]);
		const h = makeOperatorHerdr(f.run);
		try {
			await h.prompt("w1:p1", "pi", "text");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrRefusal);
			expect((err as HerdrRefusal).code).toBe("kind_mismatch");
			expect((err as Error).message).toContain("devin");
		}
		expect(prompts(f.calls)).toEqual([]);
	});

	test("prompt on a rerouted pane id refuses before any send", async () => {
		const f = opRunner([
			...TOPOLOGY,
			opOk({ result: { agent: { ...OP_AGENT, pane_id: "w1:p9" } } }),
		]);
		const h = makeOperatorHerdr(f.run);
		await expect(h.prompt("w1:p1", "pi", "text")).rejects.toBeInstanceOf(HerdrRefusal);
		expect(prompts(f.calls)).toEqual([]);
	});

	test("prompt on a missing or non-agent pane refuses with agent_not_found", async () => {
		const f = opRunner([...TOPOLOGY, opFail("agent_not_found", "agent target w9:p9 not found")]);
		const h = makeOperatorHerdr(f.run);
		try {
			await h.prompt("w9:p9", "pi", "text");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrRefusal);
			expect((err as HerdrRefusal).code).toBe("agent_not_found");
		}
		expect(prompts(f.calls)).toEqual([]);
	});

	test("a malformed get fails loud — nothing is sent", async () => {
		const f = opRunner([...TOPOLOGY, { code: 0, stdout: "not json", stderr: "" }]);
		const h = makeOperatorHerdr(f.run);
		await expect(h.prompt("w1:p1", "pi", "text")).rejects.toThrow(/not JSON/);
		expect(prompts(f.calls)).toEqual([]);
	});

	test.each([
		["agent_blocked", "agent w1:p1 is blocked and requires interactive input"],
		["agent_prompt_stalled", "agent prompt produced no observed working or blocked state"],
		["timeout", "timed out waiting for agent status"],
	] as const)(
		"a %s send failure propagates code+message, once, with no post-send reads",
		async (code, message) => {
			const f = opRunner([
				...TOPOLOGY,
				opOk({ result: { agent: OP_AGENT } }),
				opFail(code, message),
			]);
			const h = makeOperatorHerdr(f.run);
			try {
				await h.prompt("w1:p1", "pi", "text");
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(HerdrError);
				expect((err as HerdrError).code).toBe(code);
				expect((err as Error).message).toContain(message);
			}
			expect(prompts(f.calls)).toHaveLength(1);
			// The failed send is the last call — nothing re-read topology after it.
			expect(verbOf(f.calls[f.calls.length - 1]!.args)).toBe("agent prompt");
		},
	);

	test("an already-aborted signal runs nothing; abort between get and send prevents the send", async () => {
		const controller = new AbortController();
		controller.abort();
		const f = opRunner([]);
		const h = makeOperatorHerdr(f.run);
		await expect(h.list(controller.signal)).rejects.toThrow();
		expect(f.calls).toEqual([]);

		const mid = new AbortController();
		const g = opRunner([
			...TOPOLOGY,
			(args) => {
				// Abort lands while `agent get` is in flight — the prompt
				// call's own boundary check must stop the send.
				mid.abort();
				return opOk({ result: { agent: OP_AGENT } });
			},
		]);
		const h2 = makeOperatorHerdr(g.run);
		await expect(h2.prompt("w1:p1", "pi", "text", mid.signal)).rejects.toThrow();
		expect(prompts(g.calls)).toEqual([]);
	});

	test("an in-flight abort surfaces the abort, not a CLI error", async () => {
		const mid = new AbortController();
		const f = opRunner([
			opOk({
				result: { agents: [] },
			}),
		]);
		const run = async (args: string[], opts?: HerdrCallOpts) => {
			f.calls.push({ args, opts } as { args: string[]; opts?: HerdrCallOpts | undefined });
			// The kill lands mid-run — a killed result then the abort check.
			mid.abort();
			return { code: -1, stdout: "", stderr: "" };
		};
		const h = makeOperatorHerdr(run);
		try {
			await h.list(mid.signal);
			expect.unreachable();
		} catch (err) {
			expect(err).not.toBeInstanceOf(HerdrError);
			expect((err as Error).name).toBe("AbortError");
		}
	});
});

describe("operator herdr adapter — post-send response checks", () => {
	const TOPO = TOPOLOGY;
	test.each([
		[
			"wrong pane",
			opOk({ result: { agent: { ...OP_AGENT, pane_id: "w1:p9", agent_status: "working" } } }),
		],
		[
			"wrong kind",
			opOk({ result: { agent: { ...OP_AGENT, agent: "devin", agent_status: "working" } } }),
		],
		["unmatched status", opOk({ result: { agent: { ...OP_AGENT, agent_status: "idle" } } })],
		["non-JSON", { code: 0, stdout: "junk", stderr: "" } as HerdrRunResult],
	])(
		"a code-0 prompt response with %s is agent_prompt_invalid_response — never 'not sent'",
		async (_l, res) => {
			const f = opRunner([...TOPO, opOk({ result: { agent: OP_AGENT } }), res]);
			const h = makeOperatorHerdr(f.run);
			try {
				await h.prompt("w1:p1", "pi", "t");
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(HerdrError);
				expect((err as HerdrError).code).toBe("agent_prompt_invalid_response");
			}
			expect(prompts(f.calls)).toHaveLength(1);
		},
	);

	test("the preflight line records the verified identity — allow and refuse", async () => {
		const lines: Record<string, unknown>[] = [];
		setLogFile("herdr-op.log");
		setLogWriter((_p, line) => lines.push(JSON.parse(line) as Record<string, unknown>));
		try {
			const bad = opRunner([
				...TOPOLOGY,
				opOk({ result: { agent: { ...OP_AGENT, agent: "devin", cwd: "/o" } } }),
			]);
			await makeOperatorHerdr(bad.run)
				.prompt("w1:p1", "pi", "t")
				.catch(() => {});
			const pf = lines.find((l) => l.msg === "herdr prompt preflight");
			expect(pf).toMatchObject({ outcome: "refuse:kind_mismatch", agent: "devin", cwd: "/o" });
			expect(JSON.stringify(pf)).not.toContain('"t"');
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});
});
