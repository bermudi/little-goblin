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
import { makePodman, type Podman, type PodmanExecOpts } from "./podman.ts";
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
	/** In-guest symlink paths — catFile must refuse these. */
	links: Set<string>;
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
	};

	const runner = async (args: string[]) => {
		calls.push([...args]);
		const [cmd, sub] = args;
		if (cmd === "inspect") {
			flags.inspectCalls += 1;
			if (flags.failInspectFrom !== undefined && flags.inspectCalls >= flags.failInspectFrom) {
				return { code: 1, stdout: "", stderr: "Error: engine connection reset" };
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
			return { stdout: "", stderr: "", exitCode: ok ? 0 : 1, timedOut: false, truncated: false };
		}
		return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
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
			};
		}
		return {
			stdout: new Uint8Array(),
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
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
	const store = openSandboxes(tmpdb());
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
		expect(store.get(conv)).toBeNull();
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
		expect(store.get(conv)).toBeNull();
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
		const timedOut = await sandboxes.exec(conv, "sleep 600", {
			timeoutMs: 5_000,
			maxOutput: 1024,
			abortSignal: AbortSignal.abort(),
		});
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
