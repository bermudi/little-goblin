// The lifecycle owner's boundaries against a fake podman: every fake
// sits at the argv seam of makePodman (the runner contract), keeping a
// fake container/network store underneath. What the tests pin is the
// reconcile contract — row is intent, podman is truth — plus the
// fail-closed network rule and the idle-reap sweep. No real podman
// runs here; the real-engine integration file is gated on
// GOBLIN_TEST_PODMAN=1.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxConfigSchema, type SandboxConfig } from "./config.ts";
import { makePodman, type PodmanExecOpts } from "./podman.ts";
import type { BoundedProc, BoundedProcBytes } from "./proc.ts";
import { containerNameFor, makeSandboxes, openSandboxes } from "./sandboxes.ts";

const PREFIX = "test-sbx-";
const NETWORK = "test-sbxnet";
const IMAGE = "docker.io/library/alpine:latest";
const CONV = "dm:1";

interface FakeContainer {
	image: string;
	running: boolean;
	networks: Set<string>;
	labels: Record<string, string>;
	files: Map<string, Uint8Array>;
}

function tmpdb(): string {
	return join(mkdtempSync(join(tmpdir(), "goblin-sbx-")), "goblin.sqlite");
}

// A fake podman engine: runner routes on argv shape, holding container
// state the assertions read back. breakDisconnect simulates a
// disconnect that reports success but never detaches, failDisconnect
// one that exits nonzero — the two fail-closed triggers.
function fakeEngine(opts?: {
	containers?: Array<{
		name: string;
		image?: string;
		running?: boolean;
		networks?: string[];
		labels?: Record<string, string>;
	}>;
	breakDisconnect?: boolean;
	failDisconnect?: boolean;
}) {
	const containers = new Map<string, FakeContainer>();
	for (const c of opts?.containers ?? []) {
		containers.set(c.name, {
			image: c.image ?? IMAGE,
			running: c.running ?? true,
			networks: new Set(c.networks ?? []),
			labels: c.labels ?? { "goblin.sandbox": "1" },
			files: new Map(),
		});
	}
	const networks = new Set<string>();
	const calls: string[][] = [];
	const execCalls: string[][] = [];
	// Mutable at call time — a test arms it after the container exists,
	// since the create path's own disconnect would trip it too.
	const flags = {
		breakDisconnect: opts?.breakDisconnect ?? false,
		failDisconnect: opts?.failDisconnect ?? false,
		failRm: false,
		// Armed when an inspect should report a hard failure — the
		// fail-closed rule treats "cannot prove off" like "not off".
		failInspect: false,
		// The next exec exits as a kill (timeout/abort/output cap
		// share the flag) — the lifecycle owner must restart.
		killedExec: false,
		// Awaited before an rm is applied — the race tests park the
		// sweep here to inject ordering.
		onRm: undefined as undefined | ((name: string) => Promise<void>),
		// Fires inside a successful disconnect — arms failures that must
		// land after the network op, like the confirming inspect.
		onDisconnect: undefined as undefined | (() => void),
	};

	const runner = async (args: string[]) => {
		calls.push([...args]);
		const [cmd, sub] = args;
		if (cmd === "inspect") {
			if (flags.failInspect) {
				// A real engine error, not a miss — "[]" or a "no such
				// object" stderr would read as state:missing.
				return { code: 125, stdout: "", stderr: "Error: inspect wedged" };
			}
			const c = containers.get(args[1]!);
			if (c === undefined) {
				return { code: 125, stdout: "[]", stderr: "Error: no such object" };
			}
			return {
				code: 0,
				stdout: JSON.stringify([
					{
						Config: { Image: c.image, Labels: c.labels },
						State: { Status: c.running ? "running" : "exited", Running: c.running },
						NetworkSettings: {
							Networks: Object.fromEntries([...c.networks].map((n) => [n, {}])),
						},
					},
				]),
				stderr: "",
			};
		}
		if (cmd === "network" && sub === "inspect") {
			if (!networks.has(args[2]!)) {
				return { code: 125, stdout: "[]", stderr: "network not found" };
			}
			return { code: 0, stdout: JSON.stringify([{ options: { isolate: "strict" } }]), stderr: "" };
		}
		if (cmd === "network" && sub === "create") {
			networks.add(args.at(-1)!);
			return { code: 0, stdout: args.at(-1)! + "\n", stderr: "" };
		}
		if (cmd === "network" && sub === "connect") {
			containers.get(args[3]!)?.networks.add(args[2]!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "network" && sub === "disconnect") {
			if (flags.failDisconnect) {
				return { code: 1, stdout: "", stderr: "Error: disconnect refused" };
			}
			if (!flags.breakDisconnect) {
				containers.get(args[3]!)?.networks.delete(args[2]!);
			}
			flags.onDisconnect?.();
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "image" && sub === "exists") {
			return { code: args[2] === IMAGE ? 0 : 1, stdout: "", stderr: "" };
		}
		if (cmd === "run") {
			const name = args[args.indexOf("--name") + 1]!;
			const image = args[args.indexOf("--init") + 1]!;
			const network = args[args.indexOf("--network") + 1]!;
			const labels: Record<string, string> = {};
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--label") {
					const [k, v] = args[i + 1]!.split("=", 2);
					labels[k!] = v!;
				}
			}
			containers.set(name, {
				image,
				running: true,
				networks: new Set([network]),
				labels,
				files: new Map(),
			});
			return { code: 0, stdout: "abc123\n", stderr: "" };
		}
		if (cmd === "start") {
			containers.get(args[1]!)!.running = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "restart") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "rm") {
			if (flags.onRm !== undefined) await flags.onRm(args.at(-1)!);
			if (flags.failRm) {
				return { code: 1, stdout: "", stderr: "Error: rm refused" };
			}
			containers.delete(args.at(-1)!);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "cp") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "ps") {
			const labelIdx = args.indexOf("--filter");
			const label = labelIdx === -1 ? "" : args[labelIdx + 1]!.replace(/^label=/, "");
			const [k, v] = label.split("=", 2);
			const names = [...containers.entries()].filter(([, c]) => c.labels[k!] === v).map(([n]) => n);
			return { code: 0, stdout: names.join("\n"), stderr: "" };
		}
		throw new Error(`fake podman: unhandled argv ${JSON.stringify(args)}`);
	};

	const execRunner = async (args: string[], _opts: PodmanExecOpts): Promise<BoundedProc> => {
		execCalls.push([...args]);
		if (flags.killedExec) {
			flags.killedExec = false;
			return { stdout: "", stderr: "", exitCode: -1, timedOut: true, truncated: false, killed: true };
		}
		return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, killed: false };
	};
	const execBytesRunner = async (
		_args: string[],
		_opts: PodmanExecOpts,
	): Promise<BoundedProcBytes> => ({
		stdout: new Uint8Array(),
		stderr: "",
		exitCode: 0,
		timedOut: false,
		truncated: false,
		killed: false,
	});

	return {
		podman: makePodman({ runner, execRunner, execBytesRunner }),
		containers,
		networks,
		calls,
		execCalls,
		flags,
	};
}

function rig(engine: ReturnType<typeof fakeEngine>, config?: Partial<SandboxConfig>) {
	const store = openSandboxes(tmpdb());
	const sandboxes = makeSandboxes({
		podman: engine.podman,
		store,
		config: () => ({ ...sandboxConfigSchema.parse({}), ...config }),
		containerPrefix: PREFIX,
		networkName: NETWORK,
	});
	return { store, sandboxes };
}

const execOpts = { timeoutMs: 5_000, maxOutput: 64 * 1024 };

describe("sandboxes lifecycle", () => {
	test("nothing exists → created with config defaults, disconnected, noted", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:99";
		const out = await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		expect(out.note).toContain("created");
		const c = engine.containers.get(name)!;
		expect(c.image).toBe(IMAGE);
		expect(c.running).toBe(true);
		expect(c.labels["goblin.sandbox"]).toBe("1");
		expect(c.labels["goblin.conversation"]).toBe(conv);
		// Created ON the network, then disconnected before first use.
		expect(c.networks.size).toBe(0);
		const disconnects = engine.calls.filter((a) => a[0] === "network" && a[1] === "disconnect");
		expect(disconnects).toHaveLength(1);
		const createArgv = engine.calls.find((a) => a[0] === "run")!;
		for (const flag of [
			"--pull=never",
			"--uidmap",
			"0:40000:8192",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--init",
		]) {
			expect(createArgv).toContain(flag);
		}
		const row = store.get(conv)!;
		expect(row.container).toBe(name);
		expect(row.network).toBe(false);
	});

	test("stopped container → started and the row's network intent re-applied", async () => {
		const conv = "dm:7";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({
			containers: [{ name, running: false, networks: [NETWORK] }],
		});
		const { sandboxes, store } = rig(engine);
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		});
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("restarted");
		expect(engine.containers.get(name)!.running).toBe(true);
		// Intent wins: the row says off, the stale attachment is removed.
		expect(engine.containers.get(name)!.networks.size).toBe(0);
		expect(engine.calls.some((a) => a[0] === "network" && a[1] === "disconnect")).toBe(true);
	});

	test("a labelled container with no row is adopted from inspect", async () => {
		const conv = "dm:42";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({
			containers: [{ name, image: "docker.io/library/debian:stable-slim", networks: [NETWORK] }],
		});
		const { sandboxes, store } = rig(engine);
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("adopted");
		// The container was attached at adoption — the note must say so
		// or the model would run code believing it is isolated.
		expect(out.note).toContain("network is ON");
		const row = store.get(conv)!;
		expect(row.image).toBe("docker.io/library/debian:stable-slim");
		expect(row.network).toBe(true);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
	});

	test("missing container with a row → recreated from the row, noted as state-lost", async () => {
		const conv = "dm:5";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: true,
			createdAt: 1,
			lastUsedAt: 2,
		});
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("previous contents are lost");
		const c = engine.containers.get(name)!;
		// Recreated from the row's intent: network ON stays attached.
		expect(c.networks.has(NETWORK)).toBe(true);
		expect(store.get(conv)!.network).toBe(true);
	});

	test("an unlabelled container squatting on the name is refused, never touched", async () => {
		const conv = "dm:6";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({
			containers: [{ name, labels: {} }],
		});
		const { sandboxes } = rig(engine);
		await expect(sandboxes.exec(conv, "true", execOpts)).rejects.toThrow(/goblin\.sandbox label/);
		expect(engine.containers.has(name)).toBe(true);
	});

	test("setNetwork toggles podman and the row together", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:8";
		await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		await sandboxes.setNetwork(conv, true);
		expect(engine.containers.get(name)!.networks.has(NETWORK)).toBe(true);
		expect(store.get(conv)!.network).toBe(true);
		await sandboxes.setNetwork(conv, false);
		expect(engine.containers.get(name)!.networks.size).toBe(0);
		expect(store.get(conv)!.network).toBe(false);
	});

	test("network off is fail-closed: an unverifiable disconnect removes the container", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:9";
		await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		// Attach first — the disconnect has to be attempted and then
		// lie about having worked for the fail-closed path to trigger.
		await sandboxes.setNetwork(conv, true);
		engine.flags.breakDisconnect = true;
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(/network off/);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toBeNull();
	});

	test("network off is fail-closed: a failed disconnect removes the container", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:11";
		await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		await sandboxes.setNetwork(conv, true);
		engine.flags.failDisconnect = true;
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(/network disconnect failed/);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toBeNull();
	});

	test("an unverifiable off-state INSPECT — not just a lying one — also removes", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:14";
		await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		await sandboxes.setNetwork(conv, true);
		// The disconnect succeeds; the confirming inspect fails — the
		// engine can no longer prove the network is off.
		engine.flags.onDisconnect = () => {
			engine.flags.failInspect = true;
		};
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(/verify failed/);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toBeNull();
	});

	test("a fresh container is created attached — if its bring-to-state inspect fails, it is removed", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:15";
		const name = containerNameFor(conv, PREFIX);
		// The reconcile's own inspect reports missing (a non-missing
		// failure can't reconcile), so arm the failure only once the
		// container exists.
		engine.flags.onRm = undefined;
		let armInspect = false;
		const origInspect = engine.podman.inspect.bind(engine.podman);
		engine.podman.inspect = async (n, c) => {
			if (armInspect) throw new Error("inspect wedged");
			return origInspect(n, c);
		};
		// Create runs then applyNetwork's before-inspect hits the wedge.
		const origCreate = engine.podman.create.bind(engine.podman);
		engine.podman.create = async (a, c) => {
			const r = await origCreate(a, c);
			armInspect = true;
			return r;
		};
		await expect(sandboxes.exec(conv, "true", execOpts)).rejects.toThrow(/inspect wedged/);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toBeNull();
	});

	test("a killed exec restarts the sandbox — the in-container command cannot outlive the tool call", async () => {
		const engine = fakeEngine();
		const { sandboxes } = rig(engine);
		const conv = "dm:16";
		engine.flags.killedExec = true;
		const out = await sandboxes.exec(conv, "sleep 999", execOpts);
		// restart + a network bring-to-state, and the note says so —
		// the model must not believe the command kept running.
		expect(engine.calls.some((a) => a[0] === "restart")).toBe(true);
		expect(out.note).toContain("restarted");
	});

	test("the sweep reaps idle rows but never the caller's", async () => {
		const conv = "dm:caller";
		const staleConv = "dm:stale";
		const callerName = containerNameFor(conv, PREFIX);
		const staleName = containerNameFor(staleConv, PREFIX);
		const engine = fakeEngine({
			containers: [{ name: callerName }, { name: staleName }],
		});
		const { sandboxes, store } = rig(engine, { idleHours: 1 });
		const old = Date.now() - 2 * 3_600_000;
		for (const [c, n] of [
			[conv, callerName],
			[staleConv, staleName],
		] as const) {
			store.put({
				conversationId: c,
				container: n,
				image: IMAGE,
				network: false,
				createdAt: old,
				lastUsedAt: old,
			});
		}
		await sandboxes.exec(conv, "true", execOpts);
		expect(engine.containers.has(staleName)).toBe(false);
		expect(store.get(staleConv)).toBeNull();
		// The caller's own row survives and is refreshed.
		expect(engine.containers.has(callerName)).toBe(true);
		expect(store.get(conv)!.lastUsedAt).toBeGreaterThan(old);
	});

	test("idleHours 0 never reaps", async () => {
		const staleConv = "dm:ancient";
		const staleName = containerNameFor(staleConv, PREFIX);
		const engine = fakeEngine({ containers: [{ name: staleName }] });
		const { sandboxes, store } = rig(engine, { idleHours: 0 });
		store.put({
			conversationId: staleConv,
			container: staleName,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		await sandboxes.exec("dm:fresh", "true", execOpts);
		expect(engine.containers.has(staleName)).toBe(true);
		expect(store.get(staleConv)).not.toBeNull();
	});

	test("a missing image fails with the operator's pull line before any create", async () => {
		const engine = fakeEngine();
		const { sandboxes } = rig(engine, {
			image: "docker.io/library/debian:stable-slim",
		});
		const conv = "dm:10";
		await expect(sandboxes.exec(conv, "true", execOpts)).rejects.toThrow(
			"podman pull docker.io/library/debian:stable-slim",
		);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
	});

	test("reset validates the target image before destroying — a bad ref leaves the sandbox intact", async () => {
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine);
		const conv = "dm:12";
		await sandboxes.exec(conv, "true", execOpts);
		const name = containerNameFor(conv, PREFIX);
		const callsBefore = engine.calls.length;
		await expect(sandboxes.reset(conv, "docker.io/library/ghost:latest")).rejects.toThrow(
			"podman pull docker.io/library/ghost:latest",
		);
		// The old sandbox is untouched — no rm, no recreate, the row
		// still points at the surviving container.
		expect(engine.containers.has(name)).toBe(true);
		expect(store.get(conv)!.container).toBe(name);
		const after = engine.calls.slice(callsBefore);
		expect(after.some((a) => a[0] === "rm")).toBe(false);
		expect(after.some((a) => a[0] === "run")).toBe(false);
	});

	test("a foreign sweep re-reads inside the row's lane — a fresh touch survives the reap", async () => {
		// Two stale rows: whichever the snapshot processes first parks
		// on its rm while the other's owner "returns" (touch). The
		// recheck inside the row's lane must see the fresh timestamp
		// and skip — under the old snapshot-only reap it was destroyed.
		const convX = "dm:race-x";
		const convY = "dm:race-y";
		const nameX = containerNameFor(convX, PREFIX);
		const nameY = containerNameFor(convY, PREFIX);
		const engine = fakeEngine({ containers: [{ name: nameX }, { name: nameY }] });
		const { sandboxes, store } = rig(engine, { idleHours: 1 });
		const old = Date.now() - 2 * 3_600_000;
		for (const [c, n] of [
			[convX, nameX],
			[convY, nameY],
		] as const) {
			store.put({
				conversationId: c,
				container: n,
				image: IMAGE,
				network: false,
				createdAt: old,
				lastUsedAt: old,
			});
		}
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = () => r();
		});
		engine.flags.onRm = () => gate;
		const pending = sandboxes.exec("dm:active", "true", execOpts);
		// Wait for the sweep to reach its first rm — that name is the
		// snapshot's first victim; the other row is the one we refresh.
		for (let i = 0; i < 200 && !engine.calls.some((a) => a[0] === "rm"); i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		const firstName = engine.calls.find((a) => a[0] === "rm")!.at(-1)!;
		const returning = firstName === nameX ? convY : convX;
		const returningName = firstName === nameX ? nameY : nameX;
		store.touch(returning, Date.now());
		release();
		await pending;
		expect(engine.containers.has(firstName)).toBe(false);
		expect(engine.containers.has(returningName)).toBe(true);
		expect(store.get(returning)).not.toBeNull();
	});

	test("a failed reap keeps the row — the next call's sweep retries", async () => {
		const staleConv = "dm:flaky";
		const staleName = containerNameFor(staleConv, PREFIX);
		const engine = fakeEngine({ containers: [{ name: staleName }] });
		const { sandboxes, store } = rig(engine, { idleHours: 1 });
		const old = Date.now() - 2 * 3_600_000;
		store.put({
			conversationId: staleConv,
			container: staleName,
			image: IMAGE,
			network: false,
			createdAt: old,
			lastUsedAt: old,
		});
		engine.flags.failRm = true;
		await sandboxes.exec("dm:active", "true", execOpts);
		expect(engine.containers.has(staleName)).toBe(true);
		expect(store.get(staleConv)).not.toBeNull();
		engine.flags.failRm = false;
		await sandboxes.exec("dm:active", "true", execOpts);
		expect(engine.containers.has(staleName)).toBe(false);
		expect(store.get(staleConv)).toBeNull();
	});
});
