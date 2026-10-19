// Live drift check: pins the real CLI's wire behavior — envelope
// shapes, pane run's silent success, error codes, usage errors exit 2
// with non-JSON stderr.
//     GOBLIN_HERDR_LIVE=1 bun test src/herdr.live.test.ts
// Boots a disposable session — never `default` or `goblin` — and the
// tests are a scripted sequence building on the first test's
// workspace.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HerdrError,
	HerdrRefusal,
	makeHerdr,
	makeOperatorHerdr,
	type Herdr,
	type HerdrCallOpts,
	type HerdrRunResult,
	type OperatorHerdr,
} from "./herdr.ts";
import { setLogFile } from "./log.ts";
import { boundedRun } from "./proc.ts";

// Throwaway name, unique per run — the operator owns `default`, prod
// delegation owns `goblin`. `string` keeps the guard below a live
// invariant: editing SESSION to a live name must fail the run, not
// boot prod.
const SESSION: string = `goblin-drift-${process.pid}-${Date.now().toString(36)}`;
if (SESSION === "default" || SESSION === "goblin") {
	throw new Error("herdr.live.test.ts: SESSION must be a throwaway name");
}

const LIVE = process.env.GOBLIN_HERDR_LIVE === "1";
// Regex-safe (alphanumerics only) — paneWaitOutput's --match is a
// substring match today, but staying regex-safe costs nothing.
const MARKER = `DRIFT${Date.now().toString(36).toUpperCase()}`;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

// Inherited HERDR_* env (socket paths, session/caller ids) must not
// leak into the throwaway server or its CLI calls.
const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_")),
) as Record<string, string>;
const spawnClean = (argv: string[]): Bun.ReadableSubprocess =>
	Bun.spawn(argv, {
		env: CLEAN_ENV,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});

async function cli(args: string[], timeoutMs = 15_000): Promise<CliResult> {
	const r = await boundedRun(spawnClean(["herdr", "--session", SESSION, ...args]), {
		timeoutMs,
		maxOutput: 1 << 20,
	});
	return { code: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
}

async function expectHerdrError(p: Promise<unknown>, code: string): Promise<void> {
	try {
		await p;
		expect.unreachable();
	} catch (err) {
		expect(err).toBeInstanceOf(HerdrError);
		if (!(err instanceof HerdrError)) throw err;
		expect(err.code).toBe(code);
	}
}

let server: Bun.Subprocess | null = null;
let h: Herdr | null = null;
let ready = false;
let workspaceId = "";
let paneId = "";
let cwd = "";

describe.skipIf(!LIVE)("herdr live drift (GOBLIN_HERDR_LIVE=1)", () => {
	beforeAll(async () => {
		// Ignored stdio: the server outlives this process's interest in
		// its logs, and piped-but-undrained streams would fill and block.
		server = Bun.spawn(["herdr", "--session", SESSION, "server"], {
			env: CLEAN_ENV,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		// Readiness needs a session-local verb — session list is a
		// registry view and would answer before this socket exists.
		const deadline = Date.now() + 20_000;
		let last = "no probe yet";
		for (;;) {
			try {
				const r = await cli(["workspace", "list"]);
				if (r.code === 0) {
					ready = true;
					break;
				}
				last = `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`;
			} catch (err) {
				last = String(err).slice(0, 200);
			}
			if (Date.now() > deadline) {
				throw new Error(`herdr drift session not ready after 20s (${last})`);
			}
			await Bun.sleep(250);
		}
		h = makeHerdr({ session: SESSION });
		cwd = mkdtempSync(join(tmpdir(), "goblin-herdr-drift-"));
		setLogFile(join(cwd, "drift.log"));
	}, 30_000);

	test("workspace create: the real envelope yields ids and the expanded cwd", async () => {
		const ws = await h!.createWorkspace(cwd, "drift-test");
		workspaceId = ws.workspaceId;
		paneId = ws.paneId;
		expect(workspaceId).toMatch(/^w\d+$/);
		expect(paneId).toMatch(new RegExp(`^${workspaceId}:p\\d+$`));
		expect(ws.cwd).toBe(cwd);
	}, 30_000);

	test("pane run: real success is silent — resolves with no envelope", async () => {
		// The CLI prints nothing on success — the adapter must not
		// demand JSON.
		await h!.paneRun(paneId, `printf '${MARKER}\\n'`);
	}, 30_000);

	test("pane wait-output and read: match envelope, then raw screen text", async () => {
		await h!.paneWaitOutput(paneId, MARKER, 5_000);
		const text = await h!.readPane(paneId, 40);
		expect(text).toContain(MARKER);
	}, 30_000);

	test("agent get on a missing agent maps to null", async () => {
		expect(await h!.get("drift-nope")).toBeNull();
	}, 30_000);

	test("agent prompt on a missing agent throws the envelope code", async () => {
		await expectHerdrError(h!.prompt("drift-nope", "hi"), "agent_not_found");
	}, 30_000);

	test("agent send-keys on a missing agent throws the envelope code", async () => {
		await expectHerdrError(h!.sendKey("drift-nope", "enter"), "agent_not_found");
	}, 30_000);

	test("agent read on a missing agent throws the envelope code", async () => {
		await expectHerdrError(h!.readAgent("drift-nope", 5), "agent_not_found");
	}, 30_000);

	test("agent start on a missing pane throws agent_pane_not_found", async () => {
		// The missing pane fails before any harness launches — kind
		// `pi` is named but never started.
		await expectHerdrError(h!.startAgent("drift-x", "pi", "w99:p99", []), "agent_pane_not_found");
	}, 30_000);

	test("usage errors exit 2 with non-JSON stderr (the fallback contract)", async () => {
		const r = await cli(["agent", "get"]);
		expect(r.code).toBe(2);
		expect(() => JSON.parse(r.stderr)).toThrow();
		expect(r.stderr).toContain("the following required arguments were not provided:");
		expect(r.stderr).toContain("Usage: herdr agent get <TARGET>");
	}, 15_000);

	test("prompt argv: a --help body is a literal positional, never a flag", async () => {
		// On a missing pane the server rejects before consuming text —
		// agent_not_found proves the CLI parsed `--help` as TEXT.
		const r = await cli([
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
			"w99:p99",
			"--help",
		]);
		expect(r.code).toBe(1);
		expect(JSON.parse(r.stderr).error.code).toBe("agent_not_found");
	}, 15_000);

	// ---- operator adapter (the `herdr` tool's backend) ----
	//
	// makeOperatorHerdr pins --session default; this runner rewrites it
	// to the throwaway session — the only seam the adapter leaves open.
	let opHerdr: OperatorHerdr;
	const opCalls: string[][] = [];
	{
		const run = async (args: string[], opts?: HerdrCallOpts): Promise<HerdrRunResult> => {
			opCalls.push(args);
			expect(args[0]).toBe("--session");
			expect(args[1]).toBe("default");
			const rewritten = ["--session", SESSION, ...args.slice(2)];
			const r = await boundedRun(spawnClean(["herdr", ...rewritten]), {
				timeoutMs: opts?.timeoutMs ?? 45_000,
				maxOutput: 1 << 20,
				...(opts?.signal !== undefined ? { abortSignal: opts.signal } : {}),
			});
			return { code: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
		};
		opHerdr = makeOperatorHerdr(run);
	}

	test("operator list: empty session yields [] with a single call", async () => {
		opCalls.length = 0;
		expect(await opHerdr.list()).toEqual([]);
		expect(opCalls.map((c) => c.slice(2).join(" "))).toEqual(["agent list"]);
	}, 30_000);

	test("operator prompt on a missing pane refuses agent_not_found and never sends", async () => {
		opCalls.length = 0;
		try {
			await opHerdr.prompt("w99:p99", "pi", "never sent");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrRefusal);
			expect((err as HerdrRefusal).code).toBe("agent_not_found");
		}
		expect(opCalls.some((c) => c.slice(2, 4).join(" ") === "agent prompt")).toBe(false);
	}, 30_000);

	test("operator read on a missing agent throws the envelope code", async () => {
		await expectHerdrError(opHerdr.read("w99:p99", 5), "agent_not_found");
	}, 30_000);

	test("operator prompt on the drift workspace's shell pane: topology parsed, then agent_not_found refusal", async () => {
		// The root pane (set by the create test) is a shell — agent get
		// must refuse it AFTER the topology reads; nothing is sent.
		opCalls.length = 0;
		try {
			await opHerdr.prompt(paneId, "pi", "never sent");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(HerdrRefusal);
			expect((err as HerdrRefusal).code).toBe("agent_not_found");
		}
		const verbs = opCalls.map((c) => c.slice(2).join(" "));
		expect(verbs).toContain(`tab list --workspace ${workspaceId}`);
		expect(opCalls.some((c) => c.slice(2, 4).join(" ") === "agent prompt")).toBe(false);
	}, 30_000);

	// ---- dispatch identity: the takeover contract's wire facts ----
	//
	// A take-over attachment compares these fields across polls:
	// terminal_id names the terminal (it survives an agent replacement in
	// the same pane), agent_session the harness session (it does not),
	// and targets are name-or-pane only. Keep this section pinned — the
	// adapter's contract comment rides on it.

	let firstTerminalId = "";
	let firstAgentSession = "";
	let firstStateSeq = -1;

	test("a real pi agent carries terminal_id and agent_session; name and pane both resolve", async () => {
		const started = await cli(
			["agent", "start", "drift-a", "--kind", "pi", "--pane", paneId, "--timeout", "60000"],
			90_000,
		);
		expect(started.code).toBe(0);
		const a = JSON.parse(started.stdout).result.agent;
		firstTerminalId = a.terminal_id;
		firstAgentSession = a.agent_session?.value ?? "";
		firstStateSeq = a.state_change_seq;
		expect(firstTerminalId).toMatch(/^term_/);
		expect(firstAgentSession).not.toBe("");
		expect(a.pane_id).toBe(paneId);
		expect(a.name).toBe("drift-a");
		expect(a.agent).toBe("pi");

		// One record, two targets.
		for (const target of ["drift-a", paneId]) {
			const got = await cli(["agent", "get", target]);
			expect(got.code).toBe(0);
			const rec = JSON.parse(got.stdout).result.agent;
			expect(rec.terminal_id).toBe(firstTerminalId);
			expect(rec.agent_session?.value ?? "").toBe(firstAgentSession);
		}

		// A terminal id is not a target — agent commands take name or pane.
		const notTarget = await cli(["agent", "get", firstTerminalId]);
		expect(notTarget.code).toBe(1);
		expect(JSON.parse(notTarget.stderr).error.code).toBe("agent_not_found");
	}, 120_000);

	test("ctrl+d releases the agent; name and pane refuse until a replacement starts", async () => {
		const sent = await cli(["agent", "send-keys", "drift-a", "ctrl+d"]);
		expect(sent.code).toBe(0);
		// Release detection is asynchronous — poll until both targets refuse.
		const deadline = Date.now() + 20_000;
		for (;;) {
			const byName = await cli(["agent", "get", "drift-a"]);
			const byPane = await cli(["agent", "get", paneId]);
			if (byName.code === 1 && byPane.code === 1) break;
			if (Date.now() > deadline) throw new Error("agent did not release after ctrl+d");
			await Bun.sleep(250);
		}
	}, 30_000);

	test("a same-kind replacement keeps terminal_id — only agent_session changes", async () => {
		const started = await cli(
			["agent", "start", "drift-b", "--kind", "pi", "--pane", paneId, "--timeout", "60000"],
			90_000,
		);
		expect(started.code).toBe(0);
		const b = JSON.parse(started.stdout).result.agent;
		expect(b.terminal_id).toBe(firstTerminalId); // the terminal survives the swap
		expect(b.name).toBe("drift-b");
		expect(b.agent_session?.value ?? "").not.toBe(firstAgentSession);
		// The sequence cursor continues across the replacement — a poller
		// must namespace cursors by attachment generation, never assume a reset.
		expect(b.state_change_seq).toBeGreaterThanOrEqual(firstStateSeq);
		const quit = await cli(["agent", "send-keys", "drift-b", "ctrl+d"]);
		expect(quit.code).toBe(0);
	}, 120_000);

	test("workspace close resolves the ok envelope", async () => {
		await h!.closeWorkspace(workspaceId);
		workspaceId = "";
	}, 30_000);

	afterAll(async () => {
		setLogFile(null);
		const failures: string[] = [];
		// A failed test above can leave the workspace open — close it so
		// the session stops with no live panes.
		if (h !== null && workspaceId !== "") {
			try {
				await h.closeWorkspace(workspaceId);
			} catch (err) {
				failures.push(`workspace close: ${String(err).slice(0, 200)}`);
			}
		}
		// Strict when the server came up — teardown must hold; best
		// effort when beforeAll never reached ready.
		try {
			const stop = await cli(["session", "stop", SESSION]);
			if (ready && stop.code !== 0) {
				failures.push(`session stop exit ${stop.code}: ${stop.stderr.trim().slice(0, 200)}`);
			}
			const del = await cli(["session", "delete", SESSION]);
			if (ready && del.code !== 0) {
				failures.push(`session delete exit ${del.code}: ${del.stderr.trim().slice(0, 200)}`);
			}
		} catch (err) {
			failures.push(`session teardown: ${String(err).slice(0, 200)}`);
		}
		try {
			server?.kill();
		} catch {
			// session stop already reaped it
		}
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`herdr drift teardown failed: ${failures.join("; ")}`);
		}
	}, 60_000);
});
