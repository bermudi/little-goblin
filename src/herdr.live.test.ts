// Live drift check: pins the real CLI's wire behavior — envelope
// shapes, error codes, usage errors exit 2
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
	makeHerdr,
	type Herdr,
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
