import { makeSandboxEnv } from "./subagents/env.ts";
// Local real-environment gate: a REAL Podman sandbox (cached alpine,
// no pulls, no external network) + real Pi Durable harness against the
// localhost fake model — the worker's read/write/edit/bash/file
// boundary executes in an actual container and is verified through
// catFile/execArgv, not by what the model claims:
//
//     GOBLIN_SUBAGENTS_PODMAN_LIVE=1 bun test src/subagents.podman.test.ts
//
// Store safety mirrors the drift check: a unique per-run token means
// "exists" == "created by this run"; preflight refuses on collision
// and afterAll removes only token-owned names. No external calls; the
// model endpoint is a localhost fake.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentsConfigSchema } from "./config.ts";
import type { Desktops, DesktopRow } from "./desktops.ts";
import { setLogFile } from "./log.ts";
import { makePodman, type Podman } from "./podman.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import { containerNameFor, makeSandboxes, openSandboxes, type Sandboxes } from "./sandboxes.ts";
import type { Context } from "@earendil-works/chord";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { openSubagentRuns, type SubagentRuns } from "./subagent-runs.ts";
import { openSubagents, type Subagents } from "./subagents.ts";

const LIVE = process.env.GOBLIN_SUBAGENTS_PODMAN_LIVE === "1";
const TOKEN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const SBX_PREFIX = `goblin-subenv-${TOKEN}-sbx-`;
const NETWORK = `goblin-subenv-${TOKEN}-net`;
const CONV = `subenv-${TOKEN}:w`;
const CONTAINER = containerNameFor(CONV, SBX_PREFIX);
const EVIDENCE_DIR = `/tmp/goblin-subenv-evidence-${TOKEN}`;

// ---------- localhost OpenAI-completions fake ----------

function sse(events: object[]): Response {
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(lines, { headers: { "content-type": "text/event-stream" } });
}
function toolReply(calls: { name: string; args: Record<string, unknown> }[]): Response {
	return sse([
		{
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: calls.map((c, j) => ({
							index: j,
							id: `call_1_${j}`,
							type: "function",
							function: { name: c.name, arguments: JSON.stringify(c.args) },
						})),
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	]);
}

const replies: Response[] = [];
const seen: { tools: string[]; messages: unknown }[] = [];
// The server starts inside the live-gated beforeAll — a skipped gate
// must not leave a listener behind on a plain `bun test`.
let server: ReturnType<typeof Bun.serve> | undefined;
const push = (...rs: Response[]) => replies.push(...rs);
const tools = (...calls: { name: string; args: Record<string, unknown> }[]) => toolReply(calls);

let cwd = "";
let podman: Podman | null = null;
let sandboxes: Sandboxes | null = null;
let sandboxStore: ReturnType<typeof openSandboxes> | null = null;
let runs: SubagentRuns | null = null;
let owner: Subagents | null = null;
// Sweeps that fail inside a test's own finally — masking a test
// failure is worse than reporting the leak twice.
const sweepFailures: string[] = [];
// Only names whose create call succeeded enter these sets; cleanup
// removes exactly them — a refused preflight or a partial adapter
// failure can never sweep another run's same-named resource.
const createdContainers = new Set<string>();
const createdNetworks = new Set<string>();

// The ownership-tracking wrapper the live gate puts over the real
// adapter: a name joins the sweep sets only after its create returned.
// The fake-edge tests below exercise this exact function — a re-stated
// copy would pin the test, not the gate.
function trackCreatedPodman(base: Podman, containers: Set<string>, networks: Set<string>): Podman {
	return {
		...base,
		create: async (spec, conv) => {
			await base.create(spec, conv);
			containers.add(spec.name);
		},
		networkEnsure: async (name, conv) => {
			await base.networkEnsure(name, conv);
			networks.add(name);
		},
	};
}

// The collision probe — a unique per-run token makes "exists" mean
// "created by another run". Same extraction rule as the tracker.
async function refuseCollision(what: string, exists: () => Promise<boolean>): Promise<void> {
	if (await exists()) throw new Error(`probe ${what} already exists — refusing`);
}

async function probeExists(name: string): Promise<boolean> {
	const r = await boundedRun(spawnProc(["podman", "inspect", name]), {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
	});
	return r.exitCode === 0;
}

async function until(fn: () => boolean, what: string, ms = 120_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

const drow: DesktopRow = {
	name: "d",
	container: "fake",
	image: "fake",
	network: false,
	reserved: false,
	leaseKind: null,
	leaseId: null,
	leaseExpiresAt: null,
	lastObsId: null,
	lastObsUsed: false,
	lastObsHash: null,
	lastActSig: null,
	lastActFrameHash: null,
	shotSeq: 0,
	createdAt: 0,
	lastUsedAt: 0,
};
const desktops: Desktops = {
	allocate: async () => ({ row: drow }),
	list: () => [drow],
	get: () => drow,
	claim: async () => drow,
	release: async () => {},
	handoff: async () => {},
	reserve: async () => {},
	setNetwork: async () => {},
	destroy: async () => {},
	screenshot: async () => ({ id: "o", path: "/tmp/x", bytes: new Uint8Array([0]) }),
	inspect: async () => ({ id: "o", state: {} }),
	act: async () => ({ result: {} }),
	cpIn: async () => ({}),
	catFile: async () => ({ data: new Uint8Array() }),
};

// The preflight/ownership invariant itself, on a fake edge — exercised
// against the real helpers the live beforeAll runs, not a re-statement
// of them (the previous inline copies could never fail).
describe("env-gate ownership regression (fake edge)", () => {
	test("a preexisting candidate is refused by the real collision probe", async () => {
		await expect(refuseCollision("container c", async () => true)).rejects.toThrow(
			"already exists",
		);
		// A clear probe must pass — the refusal is the probe's verdict,
		// not a fixed answer.
		await refuseCollision("container c", async () => false);
	});

	test("ownership is marked only after a successful create — a failed create is not swept", async () => {
		const containers = new Set<string>();
		const networks = new Set<string>();
		const failing = trackCreatedPodman(
			{
				create: async () => {
					throw new Error("create failed after container start");
				},
				networkEnsure: async () => {
					throw new Error("network create failed");
				},
			} as unknown as Podman,
			containers,
			networks,
		);
		await expect(failing.create({ name: "partial" } as never, "conv")).rejects.toThrow("failed");
		await expect(failing.networkEnsure("partial-net", "conv")).rejects.toThrow("failed");
		expect(containers.size).toBe(0);
		expect(networks.size).toBe(0);
		// And the same wrapper DOES mark a create that lands.
		const ok = trackCreatedPodman(
			{
				create: async () => {},
				networkEnsure: async () => {},
			} as unknown as Podman,
			containers,
			networks,
		);
		await ok.create({ name: "landed" } as never, "conv");
		await ok.networkEnsure("net-landed", "conv");
		expect([...containers]).toEqual(["landed"]);
		expect([...networks]).toEqual(["net-landed"]);
	});
});

describe.skipIf(!LIVE)("subagent real-env gate (GOBLIN_SUBAGENTS_PODMAN_LIVE=1)", () => {
	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as {
					messages?: unknown;
					tools?: { function?: { name?: string } }[];
				};
				seen.push({
					tools: (body.tools ?? []).map((t) => t.function?.name ?? "?"),
					messages: body.messages,
				});
				return replies.shift() ?? toolReply([{ name: "finish", args: { result: "unscripted" } }]);
			},
		});
		cwd = mkdtempSync(join(tmpdir(), "goblin-subenv-"));
		mkdirSync(EVIDENCE_DIR, { recursive: true });
		setLogFile(join(EVIDENCE_DIR, "env.log"));
		const base = makePodman();
		podman = trackCreatedPodman(base, createdContainers, createdNetworks);
		await refuseCollision(`container ${CONTAINER}`, () => probeExists(CONTAINER));
		await refuseCollision(`network ${NETWORK}`, async () => {
			const net = await boundedRun(spawnProc(["podman", "network", "inspect", NETWORK]), {
				timeoutMs: 30_000,
				maxOutput: 1 << 20,
			});
			return net.exitCode === 0;
		});
		sandboxStore = openSandboxes(join(cwd, "sandboxes.sqlite"));
		sandboxes = makeSandboxes({
			podman,
			store: sandboxStore,
			config: () => undefined,
			containerPrefix: SBX_PREFIX,
			networkName: NETWORK,
		});
		runs = openSubagentRuns(join(cwd, "goblin.sqlite"));
		owner = await openSubagents({
			config: subagentsConfigSchema.parse({
				maxRuns: 1,
				worker: {
					model: {
						auth: "test",
						id: "glm-5.3",
						baseUrl: `http://127.0.0.1:${server!.port}`,
						api: "openai-completions",
						thinking: "low",
					},
				},
				computer: {
					model: {
						auth: "test",
						id: "glm-5.3-flash",
						baseUrl: `http://127.0.0.1:${server!.port}`,
						api: "openai-completions",
						thinking: "low",
					},
				},
			}),
			runs,
			auth: { resolve: async () => "k" },
			sandboxes,
			desktops,
			storagePath: join(cwd, "subagents.sqlite"),
			transferRoot: join(cwd, "transfer"),
			wake: () => true,
		});
		await owner.resume();
	}, 90_000);

	test("worker env in a real container: write/read/edit/bash/import/export", async () => {
		// Import a real workspace file through the inbox boundary.
		const ws = join(cwd, "ws");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "seed.txt"), "SEED-42");
		push(
			tools({ name: "read", args: { path: `/inbox/subagents/1/01-seed.txt` } }),
			tools({ name: "write", args: { path: "/work/deep/nested/f.txt", content: "nested-ok" } }),
			tools({
				name: "edit",
				args: { path: "/work/deep/nested/f.txt", oldText: "nested", newText: "edited" },
			}),
			tools({
				name: "bash",
				args: {
					command: "printf '\\x00\\xffAB\\n' > /work/b.bin; cat /work/b.bin; echo exit-was-$?",
				},
			}),
			tools({ name: "finish", args: { result: "env-ok", files: ["/work/b.bin"] } }),
		);
		const run = await owner!.start({
			kind: "worker",
			conversationId: CONV,
			workspace: ws,
			task: "exercise the sandbox",
			files: ["seed.txt"],
		});
		await until(() => runs!.get(run.id)?.status === "done", "run done");
		const row = runs!.get(run.id)!;
		// Independently verified through the real sandbox, not the model.
		const nested = await sandboxes!.catFile(CONV, "/work/deep/nested/f.txt");
		expect(new TextDecoder().decode(nested.data)).toBe("edited-ok");
		const bin = await sandboxes!.catFile(CONV, "/work/b.bin");
		expect([...bin.data.slice(0, 4)]).toEqual([0, 255, 65, 66]);
		const inbox = await sandboxes!.catFile(CONV, "/inbox/subagents/1/01-seed.txt");
		expect(new TextDecoder().decode(inbox.data)).toBe("SEED-42");
		// The bash result visible to the model carried real output.
		expect(JSON.stringify(seen.at(-1)!.messages)).toContain("AB");
		// The export landed in the workspace.
		expect(row.exportedFiles.length).toBe(1);
		expect([...readFileSync(join(ws, row.exportedFiles[0]!)).slice(0, 4)]).toEqual([
			0, 255, 65, 66,
		]);
		writeFileSync(
			join(EVIDENCE_DIR, "REPORT.md"),
			`# podman env gate — ${new Date().toISOString()}\n\ncontainer: ${CONTAINER}\nnetwork: ${NETWORK}\nrun: #${run.id} ${row.status} result=${row.result}\nexports: ${row.exportedFiles.join(", ")}\nrequests: ${seen.length}\ntoolsets: ${JSON.stringify(seen.map((s) => s.tools[0]))}\n`,
		);
	}, 180_000);

	// Direct conformance against the REAL sandbox env — no model, no
	// virtual shell: every call below is a real podman exec.
	test("env conformance in a real container", async () => {
		const env = makeSandboxEnv(sandboxes!, join(cwd, "transfer2"), CONV);
		const CTX = {} as Context; // no abortSignal, no scope
		// Filenames that used to corrupt the line protocol.
		for (const name of ["a|b.txt", "with space.txt", "line\nbreak.txt"]) {
			const w = await env.writeFile(`weird/${name}`, "x", CTX);
			if (!w.ok) throw new Error(`write ${JSON.stringify(name)}: ${w.error.message}`);
		}
		const listed = await env.listDir("/work/weird", CTX);
		if (!listed.ok) throw new Error(`listDir: ${listed.error.message}`);
		expect(listed.value.map((f) => f.name).sort()).toEqual(
			["a|b.txt", "with space.txt", "line\nbreak.txt"].sort(),
		);
		// Missing vs not-a-directory are distinct, honest errors.
		const missing = await env.listDir("/work/nope-nope", CTX);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe("not_found");
		const notDir = await env.listDir("/work/weird/a|b.txt", CTX);
		expect(notDir.ok).toBe(false);
		// canonicalPath strips only realpath's own newline — a trailing
		// newline IN the name survives.
		const canon = await env.canonicalPath("/work/weird/line\nbreak.txt", CTX);
		if (!canon.ok) throw new Error(`canonicalPath: ${canon.error.message}`);
		expect(canon.value).toBe("/work/weird/line\nbreak.txt");
		// readTextLines boundaries match openTextLineReader.
		for (const [content, want] of [
			["", []],
			["x", ["x"]],
			["x\n", ["x"]],
			["x\ny", ["x", "y"]],
		] as const) {
			const w = await env.writeFile("lines.txt", content, CTX);
			if (!w.ok) throw new Error(w.error.message);
			const r = await env.readTextLines("lines.txt", undefined, CTX);
			if (!r.ok) throw new Error(r.error.message);
			expect(r.value).toEqual([...want]);
		}
		// A pre-aborted context performs ZERO sandbox calls — counted at
		// the real Podman edge, not just asserted by side effect.
		let edgeCalls = 0;
		const counting = new Proxy(sandboxes!, {
			get(t, p, recv) {
				const v = Reflect.get(t, p, recv);
				if (typeof v !== "function") return v;
				return (...a: unknown[]) => {
					edgeCalls++;
					return (v as (...x: unknown[]) => unknown).apply(t, a);
				};
			},
		});
		const env2 = makeSandboxEnv(counting, join(cwd, "transfer3"), CONV);
		const abortedCtx = { abortSignal: AbortSignal.abort() } as Context;
		const w = await env2.writeFile("must-not-exist.txt", "no", abortedCtx);
		expect(w.ok).toBe(false);
		const abortedExec = await env2.exec("echo no", undefined, abortedCtx);
		expect(abortedExec.ok).toBe(false);
		expect(edgeCalls).toBe(0);
		const ex = await sandboxes!.exec(CONV, "test -e /work/must-not-exist.txt; echo $?", {
			timeoutMs: 30_000,
			maxOutput: 1024,
		});
		expect(ex.result.stdout.trim()).toBe("1");
		// Nonzero bash reports the real exit code and streamed output.
		let streamed = "";
		const sh = await env.exec(
			"echo out-$((1+1)); echo err >&2; exit 3",
			{ onOutput: (s) => (streamed += s) },
			CTX,
		);
		if (!sh.ok) throw new Error(sh.error.message);
		expect(sh.value.exitCode).toBe(3);
		expect(streamed).toContain("out-2");
		// A timed-out command reports timeout and its advertised spill
		// file is a real, readable guest file — never a phantom path.
		const t = await env.exec("sleep 30; echo late", { timeout: 1 }, CTX);
		expect(t.ok).toBe(false);
		if (!t.ok) {
			expect(t.error.code).toBe("timeout");
			const spill = (t.error as { spillPath?: string }).spillPath;
			expect(spill).toBeDefined();
			await sandboxes!.catFile(CONV, spill!);
		}
	}, 180_000);

	// The upstream conformance runner against the same real sandbox:
	// every case gets a fresh /work directory as its cwd, and every call
	// inside is a real podman exec. `it` floors the case budget at 60 s —
	// the runner's own 30 s watch budget stays — because a real exec is
	// ~200 ms and bun's 5 s default kills mid-case, restarts cascading.
	let confSeq = 0;
	registerEnvConformance(
		{
			describe,
			it: (name: string, fn: () => Promise<void>, timeoutMs?: number) =>
				test(name, fn, timeoutMs ?? 60_000),
			expect,
		},
		"ExecutionEnv conformance (real sandbox)",
		async (run) => {
			const seq = confSeq++;
			const dir = `/work/conf-${seq}`;
			const mk = await sandboxes!.exec(CONV, `mkdir -p -- ${dir}`, {
				timeoutMs: 30_000,
				maxOutput: 1024,
			});
			if (mk.result.exitCode !== 0) {
				throw new Error(
					`conformance mkdir ${dir}: exit ${mk.result.exitCode ?? "killed"}: ${mk.result.stderr.trim()}`,
				);
			}
			const env = makeSandboxEnv(sandboxes!, join(cwd, `transfer-conf-${seq}`), CONV);
			env.cwd = dir;
			await run(env);
		},
	);

	// The crash-gap promise against a real container: the owner process
	// dies mid-bash, recovery reports the call interrupted, and the
	// replay-unsafe command never re-executes — proven by the guest
	// marker file, not by what the transcript claims (phase-5 check 2).
	test("kill -9 mid-bash recovers without replaying the tool call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-subkill-"));
		const ws = join(dir, "ws");
		mkdirSync(ws, { recursive: true });
		const readyFile = join(dir, "ready");
		push(
			tools({
				name: "bash",
				args: { command: "echo hit >> /work/marker.txt; sleep 45" },
			}),
			tools({ name: "finish", args: { result: "recovered" } }),
		);
		const proc = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "subagents-kill.driver.ts"),
				dir,
				`http://127.0.0.1:${server!.port}`,
				CONV,
				ws,
				SBX_PREFIX,
				NETWORK,
				readyFile,
			],
			// inherit, never pipe: an undrained pipe stalls the driver
			// mid-run once its log fills the buffer.
			{ stdout: "inherit", stderr: "inherit" },
		);
		let owner2: Subagents | null = null;
		let runs2: SubagentRuns | null = null;
		let store2: ReturnType<typeof openSandboxes> | null = null;
		let killed = false;
		const poll = async (fn: () => Promise<boolean>, what: string, ms = 90_000) => {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				if (await fn()) return;
				await Bun.sleep(150);
			}
			// A stuck run usually means the tool result carried an error —
			// surface what the model actually saw.
			const last = seen[seen.length - 1];
			throw new Error(
				`timed out waiting for: ${what}\nlast request tail: ${JSON.stringify(last?.messages).slice(-1500)}`,
			);
		};
		try {
			await poll(async () => existsSync(readyFile), "driver ready file", 60_000);
			const [pidStr, runIdStr] = readFileSync(readyFile, "utf8").trim().split("\t");
			const pid = Number(pidStr);
			const runId = Number(runIdStr);
			// A second adapter over the driver's own store resolves the
			// same container row — the marker file IS the guest fs.
			store2 = openSandboxes(join(dir, "sandboxes.sqlite"));
			const sandboxes2 = makeSandboxes({
				podman: podman!,
				store: store2,
				config: () => undefined,
				containerPrefix: SBX_PREFIX,
				networkName: NETWORK,
			});
			await poll(async () => {
				const r = await sandboxes2.exec(CONV, "cat /work/marker.txt 2>/dev/null || true", {
					timeoutMs: 30_000,
					maxOutput: 1024,
				});
				return r.result.stdout.includes("hit");
			}, "marker written in container");
			process.kill(pid, "SIGKILL");
			killed = true;
			await proc.exited;
			// The durable row still claims running — the crash gap is on disk.
			runs2 = openSubagentRuns(join(dir, "goblin.sqlite"));
			expect(runs2.get(runId)?.status).toBe("running");
			owner2 = await openSubagents({
				config: subagentsConfigSchema.parse({
					maxRuns: 1,
					worker: {
						model: {
							auth: "test",
							id: "glm-5.3",
							baseUrl: `http://127.0.0.1:${server!.port}`,
							api: "openai-completions",
							thinking: "low",
						},
					},
				}),
				runs: runs2,
				auth: { resolve: async () => "k" },
				sandboxes: sandboxes2,
				desktops,
				storagePath: join(dir, "subagents.sqlite"),
				transferRoot: join(dir, "transfer"),
				wake: () => true,
			});
			await owner2.resume();
			await poll(async () => runs2!.get(runId)?.status === "done", "recovered run done");
			// Exactly one request carried the interrupted tool result — and
			// it was reported, not re-executed.
			const interrupted = seen.filter((s) =>
				JSON.stringify(s.messages).includes("was interrupted"),
			);
			expect(interrupted.length).toBe(1);
			const marker = await sandboxes2.exec(CONV, "cat /work/marker.txt", {
				timeoutMs: 30_000,
				maxOutput: 1024,
			});
			expect(marker.result.stdout).toBe("hit\n");
		} finally {
			if (!killed) proc.kill("SIGKILL");
			await owner2?.close();
			runs2?.close();
			store2?.close();
			try {
				if (await probeExists(CONTAINER)) await podman!.rm(CONTAINER);
			} catch {
				/* sweep races are reported by afterAll's own cleanup */
			}
			// The driver creates the network through its own adapter —
			// afterAll's tracked set never sees it. A failed sweep is
			// reported through afterAll, never a finally throw that would
			// mask the test result.
			const net = await boundedRun(spawnProc(["podman", "network", "rm", NETWORK]), {
				timeoutMs: 30_000,
				maxOutput: 1 << 20,
			});
			if (net.exitCode !== 0 && !/does not exist|not found/i.test(net.stderr)) {
				sweepFailures.push(`network rm ${NETWORK} exit ${net.exitCode}: ${net.stderr.trim()}`);
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);

	afterAll(async () => {
		setLogFile(null);
		server?.stop(true);
		const failures: string[] = [...sweepFailures];
		try {
			await owner?.close();
		} catch (err) {
			failures.push(`owner close: ${String(err).slice(0, 200)}`);
		}
		if (podman !== null) {
			for (const name of createdContainers) {
				try {
					if (await probeExists(name)) await podman.rm(name);
				} catch (err) {
					failures.push(`rm ${name}: ${String(err).slice(0, 200)}`);
				}
			}
			for (const net of createdNetworks) {
				const r = await boundedRun(spawnProc(["podman", "network", "rm", net]), {
					timeoutMs: 30_000,
					maxOutput: 1 << 20,
				});
				if (r.exitCode !== 0 && !/does not exist|not found/i.test(r.stderr)) {
					failures.push(`network rm ${net} exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`);
				}
			}
		}
		runs?.close();
		sandboxStore?.close();
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`podman env-gate teardown failed: ${failures.join("; ")}`);
		}
	}, 120_000);
});
