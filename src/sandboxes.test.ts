// The lifecycle owner's boundaries against a fake podman: every fake
// sits at the argv seam of makePodman (the runner contract), keeping a
// fake container/network store underneath. What the tests pin is the
// reconcile contract — row is intent, podman is truth — plus the
// fail-closed network rule and the idle-reap sweep. No real podman
// runs here; the real-engine integration file is gated on
// GOBLIN_TEST_PODMAN=1.

import { describe, expect, test } from "bun:test";
import { sandboxConfigSchema, type SandboxConfig } from "./config.ts";
import { makePodman, type Podman, type PodmanExecOpts } from "./podman.ts";
import { boundedRun, spawnProc, type BoundedProc, type BoundedProcBytes } from "./proc.ts";
import { containerNameFor, makeSandboxes, openSandboxes } from "./sandboxes.ts";
import { tmpDb } from "./testkit.ts";

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
	/** In-guest symlink paths — catFile must refuse these. */
	links: Set<string>;
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
	/** Image refs the fake store holds beyond the default IMAGE. */
	images?: string[];
}) {
	const images = new Set([IMAGE, ...(opts?.images ?? [])]);
	const containers = new Map<string, FakeContainer>();
	for (const c of opts?.containers ?? []) {
		containers.set(c.name, {
			image: c.image ?? IMAGE,
			running: c.running ?? true,
			networks: new Set(c.networks ?? []),
			labels: c.labels ?? { "goblin.sandbox": "1" },
			files: new Map(),
			links: new Set(),
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
		// Inspect fails once the ordinal count reaches this (relative
		// arming: flags.failInspectFrom = flags.inspectCalls + k).
		inspectCalls: 0,
		failInspectFrom: undefined as number | undefined,
		failRm: false,
		failNetworkCreate: false,
		// Canned exec results — the output-cap restart tests.
		execResult: undefined as BoundedProc | undefined,
		execBytesResult: undefined as BoundedProcBytes | undefined,
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
		// Takes over the exec seam entirely — the abort tests run a real
		// boundedRun subprocess through it.
		execImpl: undefined as
			| undefined
			| ((args: string[], opts: PodmanExecOpts) => Promise<BoundedProc>),
	};

	const runner = async (args: string[]) => {
		calls.push([...args]);
		const [cmd, sub] = args;
		if (cmd === "inspect") {
			flags.inspectCalls += 1;
			if (flags.failInspectFrom !== undefined && flags.inspectCalls >= flags.failInspectFrom) {
				return { code: 1, stdout: "", stderr: "Error: engine connection reset" };
			}
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
			if (flags.failNetworkCreate) {
				return { code: 1, stdout: "", stderr: "Error: network backend down" };
			}
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
			return { code: images.has(args[2]!) ? 0 : 1, stdout: "", stderr: "" };
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
				links: new Set(),
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
				return { code: 1, stdout: "", stderr: "Error: rm wedged on a locked layer" };
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
		if (flags.execImpl !== undefined) return flags.execImpl(args, _opts);
		if (flags.killedExec) {
			flags.killedExec = false;
			return {
				stdout: "",
				stderr: "",
				exitCode: null,
				timedOut: true,
				truncated: false,
				killed: true,
			};
		}
		if (flags.execResult !== undefined) return flags.execResult;
		// catFile's regular-file probe: `test -f "$1" && ! test -L "$1"`.
		// exec argv is ["exec",-flags…, name, ...argv] — the container
		// name is the element before the inner argv's head.
		const checkIdx = args.indexOf("sb-check");
		if (checkIdx !== -1) {
			const name = args[args.indexOf("/bin/sh") - 1]!;
			const c = containers.get(name);
			const path = args[checkIdx + 1]!;
			const ok = c !== undefined && c.files.has(path) && !c.links.has(path);
			return {
				stdout: "",
				stderr: "",
				exitCode: ok ? 0 : 1,
				timedOut: false,
				truncated: false,
				killed: false,
			};
		}
		return {
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
			killed: false,
		};
	};
	const execBytesRunner = async (
		args: string[],
		_opts: PodmanExecOpts,
	): Promise<BoundedProcBytes> => {
		if (flags.execBytesResult !== undefined) return flags.execBytesResult;
		// catFile's read: `cat -- <path>` — name sits before "cat".
		const catIdx = args.indexOf("cat");
		const c = catIdx === -1 ? undefined : containers.get(args[catIdx - 1]!);
		if (catIdx !== -1 && c !== undefined) {
			const data = c.files.get(args.at(-1)!);
			return {
				stdout: data ?? new Uint8Array(),
				stderr: "",
				exitCode: data === undefined ? 1 : 0,
				timedOut: false,
				truncated: false,
				killed: false,
			};
		}
		return {
			stdout: new Uint8Array(),
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
			killed: false,
		};
	};

	return {
		podman: makePodman({ runner, execRunner, execBytesRunner }),
		containers,
		networks,
		calls,
		execCalls,
		flags,
	};
}

function rig(
	engine: ReturnType<typeof fakeEngine>,
	config?: Partial<SandboxConfig>,
	extra?: {
		runLease?: (conversationId: string) => { id: number; status: string } | null;
		onLifecycle?: (conversationId: string, note: string) => void;
	},
) {
	const store = openSandboxes(tmpDb("goblin-sbx-"));
	const sandboxes = makeSandboxes({
		podman: engine.podman,
		store,
		config: () => ({ ...sandboxConfigSchema.parse({}), ...config }),
		containerPrefix: PREFIX,
		networkName: NETWORK,
		...(extra?.runLease !== undefined ? { runLease: extra.runLease } : {}),
		...(extra?.onLifecycle !== undefined ? { onLifecycle: extra.onLifecycle } : {}),
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
		// The row survives the removal — it carries the image and the
		// network intent the next call's recreate restores.
		expect(store.get(conv)).toMatchObject({ container: name, image: IMAGE, network: true });
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
		// The row survives the removal — the failed toggle never wrote
		// network=off, so intent is still on.
		expect(store.get(conv)).toMatchObject({ container: name, image: IMAGE, network: true });
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
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(
			/after disconnect could not be inspected/,
		);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toMatchObject({ container: name, image: IMAGE, network: true });
	});

	test("a fail-closed removal keeps the row — the next call recreates its image and network intent", async () => {
		const CUSTOM = "docker.io/library/debian:stable-slim";
		const conv = "dm:keep-row";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({
			containers: [{ name, image: CUSTOM, networks: [NETWORK] }],
			images: [CUSTOM],
		});
		const { sandboxes, store } = rig(engine);
		// A custom-image sandbox recorded mid-life: the row is the only
		// place that image and intent survive on.
		store.put({
			conversationId: conv,
			container: name,
			image: CUSTOM,
			network: true,
			createdAt: 1,
			lastUsedAt: 2,
		});
		engine.flags.failDisconnect = true;
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(/network disconnect failed/);
		expect(engine.containers.has(name)).toBe(false);
		// Fail-closed removes the container — and keeps the intent row.
		expect(store.get(conv)).toMatchObject({ image: CUSTOM, network: true });
		// The next call recreates FROM the row — not from config defaults.
		engine.flags.failDisconnect = false;
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("recreated");
		const c = engine.containers.get(name)!;
		expect(c.image).toBe(CUSTOM);
		expect(c.networks.has(NETWORK)).toBe(true);
	});

	test("a stale row whose container is already gone reaps clean", async () => {
		// Rows kept after fail-closed removals point at nothing — podman's
		// rm is idempotent on a missing name, so the sweep deletes the row
		// without a warn-and-retry loop.
		const staleConv = "dm:ghost";
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine, { idleHours: 1 });
		store.put({
			conversationId: staleConv,
			container: containerNameFor(staleConv, PREFIX),
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		await sandboxes.exec("dm:active", "true", execOpts);
		expect(store.get(staleConv)).toBeNull();
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

	test("network off is fail-closed: a failed confirming inspect removes the container", async () => {
		const conv = "dm:12";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name, networks: [NETWORK] }] });
		const { sandboxes, store } = rig(engine);
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: true,
			createdAt: 1,
			lastUsedAt: 1,
		});
		// ensureLocked inspect, the want-true reconcile inspect, the
		// desired-off pre-inspect, then the post-disconnect
		// confirmation — that fourth one throws.
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 4;
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(
			/could not be inspected.*container was removed/s,
		);
		// The disconnect ran first — the removal is the fail-closed
		// verdict, not a skipped-off ramp.
		const calls = engine.calls;
		const disconnect = calls.findLastIndex((a) => a[0] === "network" && a[1] === "disconnect");
		const rm = calls.findLastIndex((a) => a[0] === "rm");
		expect(disconnect).toBeGreaterThanOrEqual(0);
		expect(rm).toBeGreaterThan(disconnect);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toMatchObject({ image: IMAGE, network: true });
	});

	test("network off is fail-closed: a failed initial inspect removes the container", async () => {
		const conv = "dm:13";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name, networks: [NETWORK] }] });
		const { sandboxes, store } = rig(engine);
		// Attached container, off intent — ensureLocked inspects fine,
		// then applyNetwork's own inspect throws before any verdict.
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 2;
		await expect(sandboxes.exec(conv, "true", execOpts)).rejects.toThrow(
			/could not be inspected.*container was removed/s,
		);
		expect(engine.containers.has(name)).toBe(false);
		expect(store.get(conv)).toMatchObject({ image: IMAGE, network: false });
	});

	test("a failed fail-closed removal surfaces the rm error and keeps the row", async () => {
		const conv = "dm:14";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name, networks: [NETWORK] }] });
		const { sandboxes, store } = rig(engine);
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: true,
			createdAt: 1,
			lastUsedAt: 1,
		});
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 4;
		engine.flags.failRm = true;
		await expect(sandboxes.setNetwork(conv, false)).rejects.toThrow(
			/could not be inspected.*could not be removed.*rm wedged/s,
		);
		// rm never landed — container and row both survive for the
		// next call's retry, and the original inspect failure is the
		// cause, not hidden behind the rm error.
		expect(engine.containers.has(name)).toBe(true);
		expect(store.get(conv)).not.toBeNull();
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

	test("a reset landing mid-teardown skips the restart — the new container keeps its work", async () => {
		const engine = fakeEngine();
		const { sandboxes } = rig(engine);
		const conv = "dm:20";
		engine.flags.killedExec = true;
		// The killed exec's restart enters the lane after its client
		// finishes; reset fires in that gap — between ensure and the
		// restart check — replacing the container under the same name.
		const origExec = engine.podman.exec.bind(engine.podman);
		engine.podman.exec = async (name, argv, o, c) => {
			const r = await origExec(name, argv, o, c);
			if (r.killed) await sandboxes.reset(conv);
			return r;
		};
		const out = await sandboxes.exec(conv, "sleep 999", execOpts);
		// Restarting the replacement would reap work this exec never
		// shared — the generation check skips it and the note is honest
		// about the lost filesystem.
		expect(engine.calls.some((a) => a[0] === "restart")).toBe(false);
		expect(out.note).toContain("replaced");
		expect(out.note).toContain("files are gone");
		const name = containerNameFor(conv, PREFIX);
		expect(engine.containers.get(name)!.running).toBe(true);
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
		// on its rm while the other's owner returns through a real call. The
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
		const resumed = sandboxes.exec(returning, "true", execOpts);
		await new Promise((r) => setImmediate(r));
		// beginOp must refresh before queuing behind the blocked sweep.
		expect(store.get(returning)!.lastUsedAt).toBeGreaterThan(old);
		release();
		await Promise.all([pending, resumed]);
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

describe("reset preflight happens before destruction", () => {
	function seededSandbox(conv: string) {
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		const rigged = rig(engine);
		rigged.store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		engine.containers.get(name)!.files.set("/work/keep.txt", new TextEncoder().encode("k"));
		return { engine, ...rigged, name };
	}

	test("an unavailable replacement image refuses before rm — container, files and row survive", async () => {
		const conv = "dm:reset-image";
		const { engine, sandboxes, store, name } = seededSandbox(conv);
		await expect(sandboxes.reset(conv, "docker.io/library/busybox:latest")).rejects.toThrow(
			"podman pull docker.io/library/busybox:latest",
		);
		expect(engine.calls.some((a) => a[0] === "rm")).toBe(false);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
		const c = engine.containers.get(name)!;
		expect(c.image).toBe(IMAGE);
		expect(c.files.has("/work/keep.txt")).toBe(true);
		expect(store.get(conv)!.container).toBe(name);
		expect(store.get(conv)!.image).toBe(IMAGE);
	});

	test("a failed replacement network preflight leaves the existing sandbox intact", async () => {
		const conv = "dm:reset-net";
		const { engine, sandboxes, store, name } = seededSandbox(conv);
		engine.flags.failNetworkCreate = true;
		await expect(sandboxes.reset(conv)).rejects.toThrow(/network create/);
		expect(engine.calls.some((a) => a[0] === "rm")).toBe(false);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
		expect(engine.containers.get(name)!.files.has("/work/keep.txt")).toBe(true);
		expect(store.get(conv)!.container).toBe(name);
	});

	test("a clean preflight still destroys and recreates, network off", async () => {
		const conv = "dm:reset-ok";
		const { engine, sandboxes, store, name } = seededSandbox(conv);
		const out = await sandboxes.reset(conv);
		expect(out.note).toContain("previous contents are gone");
		const c = engine.containers.get(name)!;
		expect(c.networks.size).toBe(0);
		expect(c.files.has("/work/keep.txt")).toBe(false);
		expect(store.get(conv)!.container).toBe(name);
		expect(engine.calls.some((a) => a[0] === "rm")).toBe(true);
	});
});

describe("catFile regular-file contract", () => {
	async function seeded(): Promise<{
		engine: ReturnType<typeof fakeEngine>;
		sandboxes: ReturnType<typeof rig>["sandboxes"];
		name: string;
	}> {
		const conv = CONV;
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		const { sandboxes } = rig(engine);
		engine.containers.get(name)!.files.set("/work/ok.txt", new TextEncoder().encode("data"));
		return { engine, sandboxes, name };
	}

	test("a regular file exports", async () => {
		const { sandboxes } = await seeded();
		const out = await sandboxes.catFile(CONV, "/work/ok.txt");
		expect(new TextDecoder().decode(out.data)).toBe("data");
	});

	test("a leaf symlink is refused — test -L guards what -f follows", async () => {
		const { engine, sandboxes, name } = await seeded();
		engine.containers.get(name)!.files.set("/work/link.txt", new TextEncoder().encode("data"));
		engine.containers.get(name)!.links.add("/work/link.txt");
		await expect(sandboxes.catFile(CONV, "/work/link.txt")).rejects.toThrow(/not a regular file/);
	});

	test("missing paths and dirs are refused", async () => {
		const { sandboxes } = await seeded();
		await expect(sandboxes.catFile(CONV, "/work/nope")).rejects.toThrow(/not a regular file/);
	});
});

describe("run leases pin the sandbox", () => {
	test("reset refuses while a run lease is live", async () => {
		const conv = "dm:20";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		const { sandboxes, store } = rig(engine, undefined, {
			runLease: (c) => (c === conv ? { id: 4, status: "running" } : null),
		});
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		await expect(sandboxes.reset(conv)).rejects.toThrow(/run #4/);
		expect(engine.containers.has(name)).toBe(true);
		// The lease is only claimed by live statuses — done frees it.
		const { sandboxes: freed } = rig(engine, undefined, {
			runLease: () => null,
		});
		await freed.reset(conv);
	});

	test("the sweep skips a leased sandbox even past idleHours", async () => {
		const staleConv = "dm:leased";
		const staleName = containerNameFor(staleConv, PREFIX);
		const engine = fakeEngine({ containers: [{ name: staleName }] });
		const { sandboxes, store } = rig(
			engine,
			{ idleHours: 1 },
			{
				runLease: (c) => (c === staleConv ? { id: 9, status: "needs_input" } : null),
			},
		);
		const old = Date.now() - 2 * 3_600_000;
		store.put({
			conversationId: staleConv,
			container: staleName,
			image: IMAGE,
			network: false,
			createdAt: old,
			lastUsedAt: old,
		});
		await sandboxes.exec("dm:caller2", "true", execOpts);
		expect(engine.containers.has(staleName)).toBe(true);
		expect(store.get(staleConv)).not.toBeNull();
	});

	test("a live lease announces itself on exec results", async () => {
		const conv = "dm:21";
		const engine = fakeEngine();
		const { sandboxes } = rig(engine, undefined, {
			runLease: (c) => (c === conv ? { id: 2, status: "running" } : null),
		});
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("run #2 holds this sandbox");
	});
});

describe("onLifecycle", () => {
	test("recreate after a missing container reports the note", async () => {
		const conv = "dm:30";
		const name = containerNameFor(conv, PREFIX);
		const notes: string[] = [];
		const engine = fakeEngine();
		const { sandboxes, store } = rig(engine, undefined, {
			onLifecycle: (c, note) => {
				if (c === conv) notes.push(note);
			},
		});
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		const out = await sandboxes.exec(conv, "true", execOpts);
		expect(out.note).toContain("previous contents are lost");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("previous contents are lost");
	});

	test("a killed exec's restart reports the note", async () => {
		const conv = "dm:31";
		const name = containerNameFor(conv, PREFIX);
		const notes: string[] = [];
		const engine = fakeEngine({ containers: [{ name }] });
		const { sandboxes, store } = rig(engine, undefined, {
			onLifecycle: (c, note) => {
				if (c === conv) notes.push(note);
			},
		});
		store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		const controller = new AbortController();
		engine.flags.execImpl = async () => {
			controller.abort();
			return {
				stdout: "",
				stderr: "",
				exitCode: null,
				timedOut: false,
				truncated: false,
				killed: true,
			};
		};
		const timedOut = await sandboxes.exec(conv, "sleep 600", {
			timeoutMs: 5_000,
			maxOutput: 1024,
			abortSignal: controller.signal,
		});
		expect(timedOut.note).toContain("was aborted");
		expect(timedOut.note).toContain("restarted");
		expect(notes.some((n) => n.includes("restarted"))).toBe(true);
	});
});

describe("output-capped execs restart the sandbox", () => {
	// A stream-cap kill is not a deadline: the container restarts (the
	// in-container command may outlive its client), the note names the
	// cap, and the filesystem survives.
	function rigCapped(notes: string[]) {
		const conv = "dm:60";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		engine.containers.get(name)!.files.set("/work/keep.txt", new TextEncoder().encode("k"));
		const { sandboxes, store } = rig(engine, undefined, {
			onLifecycle: (c, note) => {
				if (c === conv) notes.push(note);
			},
		});
		return { engine, sandboxes, store, conv, name };
	}

	function expectRestarted(
		engine: ReturnType<typeof fakeEngine>,
		name: string,
		note: string | undefined,
		notes: string[],
	) {
		expect(note).toContain("output cap");
		expect(note).not.toContain("deadline");
		expect(engine.calls.some((a) => a[0] === "restart")).toBe(true);
		// Files and the row survive the restart — only processes died.
		expect(engine.containers.get(name)!.files.has("/work/keep.txt")).toBe(true);
		expect(notes.some((n) => n.includes("output cap"))).toBe(true);
	}

	test("text exec", async () => {
		const notes: string[] = [];
		const { engine, sandboxes, conv, name } = rigCapped(notes);
		engine.flags.execResult = {
			stdout: "x".repeat(70_000),
			stderr: "",
			exitCode: null,
			timedOut: false,
			truncated: true,
			killed: true,
			outputCapped: true,
		};
		const out = await sandboxes.exec(conv, "seq 1 500000", execOpts);
		expectRestarted(engine, name, out.note, notes);
	});

	test("argv exec", async () => {
		const notes: string[] = [];
		const { engine, sandboxes, conv, name } = rigCapped(notes);
		engine.flags.execResult = {
			stdout: "",
			stderr: "flooded",
			exitCode: null,
			timedOut: false,
			truncated: true,
			killed: true,
			outputCapped: true,
		};
		const out = await sandboxes.execArgv(conv, ["seq", "1", "500000"], execOpts);
		expectRestarted(engine, name, out.note, notes);
	});

	test("binary argv exec", async () => {
		const notes: string[] = [];
		const { engine, sandboxes, conv, name } = rigCapped(notes);
		engine.flags.execBytesResult = {
			stdout: new Uint8Array(70_000),
			stderr: "",
			exitCode: null,
			timedOut: false,
			truncated: true,
			killed: true,
			outputCapped: true,
		};
		const out = await sandboxes.execBytesArgv(conv, ["cat", "big.bin"], execOpts);
		expectRestarted(engine, name, out.note, notes);
	});
});

// Cancellation: a signal that lands while a call is parked — inside a
// deferred preflight or queued on the conversation lane — must stop the
// call before any mutation dispatches, not after.
describe("aborted lifecycle calls never start a mutation", () => {
	function seeded(conv: string) {
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		const rigged = rig(engine);
		rigged.store.put({
			conversationId: conv,
			container: name,
			image: IMAGE,
			network: false,
			createdAt: 1,
			lastUsedAt: 1,
		});
		engine.containers.get(name)!.files.set("/work/keep.txt", new TextEncoder().encode("k"));
		return { engine, ...rigged, name };
	}

	const until = async (cond: () => boolean): Promise<void> => {
		for (let i = 0; i < 200 && !cond(); i++) {
			await new Promise((r) => setImmediate(r));
		}
	};

	// A podman read parked on a gate: `entered` flips when the op
	// reaches it, `release()` lets it complete.
	function hold(
		podman: Podman,
		method: "inspect" | "imageExists",
	): { entered: () => boolean; release: () => void } {
		let entered = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		if (method === "inspect") {
			const orig = podman.inspect.bind(podman);
			podman.inspect = async (n, c) => {
				entered = true;
				await gate;
				return orig(n, c);
			};
		} else {
			const orig = podman.imageExists.bind(podman);
			podman.imageExists = async (ref, c) => {
				entered = true;
				await gate;
				return orig(ref, c);
			};
		}
		return { entered: () => entered, release };
	}

	test("cancellation during start still reconciles the stored network-off intent", async () => {
		const conv = "dm:abort-start";
		const { engine, sandboxes, name } = seeded(conv);
		const container = engine.containers.get(name)!;
		container.running = false;
		container.networks.add(NETWORK);
		const ctl = new AbortController();
		const start = engine.podman.start.bind(engine.podman);
		engine.podman.start = async (...args) => {
			await start(...args);
			ctl.abort();
		};
		await expect(
			sandboxes.catFile(conv, "/work/keep.txt", { abortSignal: ctl.signal }),
		).rejects.toThrow();
		expect(container.running).toBe(true);
		expect(container.networks.size).toBe(0);
	});

	test("reset rechecks a lease acquired during replacement preflight", async () => {
		const conv = "dm:lease-preflight";
		const name = containerNameFor(conv, PREFIX);
		const engine = fakeEngine({ containers: [{ name }] });
		let leased = false;
		const { sandboxes } = rig(engine, undefined, {
			runLease: () => (leased ? { id: 9, status: "queued" } : null),
		});
		const gate = hold(engine.podman, "imageExists");
		const pending = sandboxes.reset(conv);
		await until(gate.entered);
		leased = true;
		gate.release();
		await expect(pending).rejects.toThrow(/run #9/);
		expect(engine.calls.some((args) => args[0] === "rm")).toBe(false);
		expect(engine.containers.has(name)).toBe(true);
	});

	test("reset aborted inside a deferred preflight never rms or recreates", async () => {
		const conv = "dm:abort-preflight";
		const { engine, sandboxes, store, name } = seeded(conv);
		const gate = hold(engine.podman, "imageExists");
		const ctl = new AbortController();
		const pending = sandboxes.reset(conv, undefined, { abortSignal: ctl.signal });
		await until(gate.entered);
		ctl.abort();
		gate.release();
		await expect(pending).rejects.toThrow();
		expect(engine.calls.some((a) => a[0] === "rm")).toBe(false);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
		expect(engine.containers.get(name)!.files.has("/work/keep.txt")).toBe(true);
		expect(store.get(conv)!.container).toBe(name);
	});

	test("reset aborted while parked behind the lane never rms or recreates", async () => {
		const conv = "dm:abort-lane";
		const { engine, sandboxes, store, name } = seeded(conv);
		// Park a network toggle inside the lane; the reset queues behind it.
		const gate = hold(engine.podman, "inspect");
		const first = sandboxes.setNetwork(conv, true);
		await until(gate.entered);
		const ctl = new AbortController();
		const pending = sandboxes.reset(conv, undefined, { abortSignal: ctl.signal });
		await new Promise((r) => setImmediate(r));
		ctl.abort();
		gate.release();
		await expect(pending).rejects.toThrow();
		await first;
		expect(engine.calls.some((a) => a[0] === "rm")).toBe(false);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
		expect(engine.containers.get(name)!.files.has("/work/keep.txt")).toBe(true);
	});

	test("setNetwork aborted mid-reconcile never connects or disconnects", async () => {
		const conv = "dm:abort-net";
		const { engine, sandboxes, store, name } = seeded(conv);
		const gate = hold(engine.podman, "inspect");
		const ctl = new AbortController();
		const pending = sandboxes.setNetwork(conv, true, { abortSignal: ctl.signal });
		await until(gate.entered);
		ctl.abort();
		gate.release();
		await expect(pending).rejects.toThrow();
		expect(
			engine.calls.some((a) => a[0] === "network" && (a[1] === "connect" || a[1] === "disconnect")),
		).toBe(false);
		expect(engine.containers.get(name)!.networks.size).toBe(0);
		expect(store.get(conv)!.network).toBe(false);
	});

	test("cpIn aborted while parked behind the lane never copies", async () => {
		const conv = "dm:abort-import";
		const { engine, sandboxes } = seeded(conv);
		const gate = hold(engine.podman, "inspect");
		const first = sandboxes.setNetwork(conv, true);
		await until(gate.entered);
		const ctl = new AbortController();
		const pending = sandboxes.cpIn(conv, "/tmp/nope", "/work/x", { abortSignal: ctl.signal });
		await new Promise((r) => setImmediate(r));
		ctl.abort();
		gate.release();
		await expect(pending).rejects.toThrow();
		await first;
		expect(engine.calls.some((a) => a[0] === "cp")).toBe(false);
	});
});

describe("catFile", () => {
	test("an abort during the test -f probe surfaces AbortError, not a read failure", async () => {
		const engine = fakeEngine();
		const { sandboxes } = rig(engine);
		const conv = "dm:abort";
		const controller = new AbortController();
		// The real subprocess boundary: an aborted boundedRun resolves
		// killed (it never rejects) — the probe exits non-zero, and
		// without an abort check that reads as "not a regular file".
		engine.flags.execImpl = (_args, opts) => {
			const proc = spawnProc(["/bin/sh", "-c", "sleep 30"]);
			controller.abort();
			return boundedRun(proc, opts);
		};
		const err = await sandboxes.catFile(conv, "/work/any", { abortSignal: controller.signal }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe("AbortError");
		// Only the probe ran — the export read never started.
		expect(engine.execCalls).toHaveLength(1);
		expect(engine.execCalls[0]).toContain("sb-check");
	});

	test("a failed probe without an abort still reports not-a-regular-file", async () => {
		const engine = fakeEngine();
		const { sandboxes } = rig(engine);
		engine.flags.execImpl = async () => ({
			stdout: "",
			stderr: "",
			exitCode: 1,
			timedOut: false,
			truncated: false,
			killed: false,
		});
		await expect(sandboxes.catFile("dm:x", "/work/missing")).rejects.toThrow(/not a regular file/);
	});
});

describe("all exec variants share recovery and cancellation fences", () => {
	const variants = ["exec", "execArgv", "execBytesArgv"] as const;
	function dispatch(
		sandboxes: ReturnType<typeof makeSandboxes>,
		variant: (typeof variants)[number],
		signal?: AbortSignal,
	) {
		const opts = { ...execOpts, ...(signal ? { abortSignal: signal } : {}) };
		return variant === "exec"
			? sandboxes.exec(CONV, "sleep 999", opts)
			: variant === "execArgv"
				? sandboxes.execArgv(CONV, ["sleep", "999"], opts)
				: sandboxes.execBytesArgv(CONV, ["sleep", "999"], opts);
	}

	for (const variant of variants) {
		test(`${variant}: a killed call cannot restart a reset replacement`, async () => {
			const engine = fakeEngine();
			const notes: string[] = [];
			const { sandboxes } = rig(engine, undefined, { onLifecycle: (_c, n) => notes.push(n) });
			const stopped = {
				stderr: "",
				exitCode: null,
				timedOut: true,
				truncated: false,
				killed: true,
			};
			engine.podman.exec = async () => {
				await sandboxes.reset(CONV);
				return { ...stopped, stdout: "" };
			};
			engine.podman.execBytes = async () => {
				await sandboxes.reset(CONV);
				return { ...stopped, stdout: new Uint8Array() };
			};
			const out = await dispatch(sandboxes, variant);
			expect(out.note).toContain("outlived its deadline");
			expect(out.note).toContain("replaced meanwhile");
			expect(out.note).toContain("files are gone");
			expect(engine.calls.some((a) => a[0] === "restart")).toBe(false);
			expect(notes).toEqual([]);
		});

		test(`${variant}: killed siblings share one restart and lifecycle notification`, async () => {
			const engine = fakeEngine();
			const notes: string[] = [];
			const { sandboxes } = rig(engine, undefined, { onLifecycle: (_c, n) => notes.push(n) });
			const releases: Array<() => void> = [];
			const wait = () => new Promise<void>((resolve) => releases.push(resolve));
			const stopped = {
				stderr: "",
				exitCode: null,
				timedOut: true,
				truncated: false,
				killed: true,
			};
			engine.podman.exec = async () => {
				await wait();
				return { ...stopped, stdout: "" };
			};
			engine.podman.execBytes = async () => {
				await wait();
				return { ...stopped, stdout: new Uint8Array() };
			};
			const first = dispatch(sandboxes, "exec");
			const sibling = dispatch(sandboxes, variant);
			for (let i = 0; i < 200 && releases.length < 2; i++) {
				await new Promise((r) => setImmediate(r));
			}
			expect(releases).toHaveLength(2);
			releases[0]!();
			await first;
			releases[1]!();
			const out = await sibling;
			expect(out.note).toContain("sibling command already restarted");
			expect(engine.calls.filter((a) => a[0] === "restart")).toHaveLength(1);
			expect(notes).toHaveLength(1);
		});

		test(`${variant}: a late abort after normal completion never restarts`, async () => {
			const engine = fakeEngine();
			const { sandboxes } = rig(engine);
			const controller = new AbortController();
			const completed = {
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
				killed: false,
			};
			engine.podman.exec = async () => {
				controller.abort();
				return { ...completed, stdout: "" };
			};
			engine.podman.execBytes = async () => {
				controller.abort();
				return { ...completed, stdout: new Uint8Array() };
			};
			await dispatch(sandboxes, variant, controller.signal);
			expect(engine.calls.some((a) => a[0] === "restart")).toBe(false);
		});

		test(`${variant}: already-cancelled calls never reach the engine`, async () => {
			const engine = fakeEngine();
			const { sandboxes } = rig(engine);
			await expect(dispatch(sandboxes, variant, AbortSignal.abort())).rejects.toThrow();
			expect(engine.calls).toEqual([]);
			expect(engine.execCalls).toEqual([]);
		});
	}
});
