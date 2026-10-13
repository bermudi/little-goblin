// The desktop pool's boundaries against a fake podman at the argv
// seam (the sandboxes.test.ts pattern): what the tests pin is the
// single-controller lease, the observation-binding invariant (an input
// action must name the newest, unconsumed frame, and an identical
// action against an unchanged screen is refused), the idle-reap
// sweep, and the fail-closed network. No real podman runs here; the
// real-engine check is gated on GOBLIN_DESKTOP_LIVE=1.

import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { desktopsConfigSchema, type DesktopsConfig } from "./config.ts";
import { makePodman, type PodmanExecOpts } from "./podman.ts";
import type { BoundedProc, BoundedProcBytes } from "./proc.ts";
import {
	DesktopError,
	containerNameForDesktop,
	makeDesktops,
	openDesktops,
	type DesktopRow,
	type Desktops,
	type LeaseHolder,
} from "./desktops.ts";
import { setLogFile, setLogWriter } from "./log.ts";

const NETWORK = "test-desknet";
const IMAGE = "localhost/goblin-desktop:test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const RUN_A: LeaseHolder = { kind: "run", id: "a" };
const RUN_B: LeaseHolder = { kind: "run", id: "b" };

interface FakeContainer {
	image: string;
	running: boolean;
	networks: Set<string>;
	labels: Record<string, string>;
}

function tmpdb(): string {
	return join(mkdtempSync(join(tmpdir(), "goblin-desk-")), "goblin.sqlite");
}

// A fake podman engine: the runner keeps container/network state, the
// exec runners answer scrot (PNG bytes), the cua-driver calls
// (list_windows / get_window_state / effects), and goblin-launch.
// varyFrames makes successive screenshots differ — the "unchanged
// screen" refusal needs identical bytes across observations.
function fakeEngine(opts?: {
	containers?: Array<{
		name: string;
		image?: string;
		running?: boolean;
		networks?: string[];
		labels?: Record<string, string>;
	}>;
	varyFrames?: boolean;
	/** cua act calls fail — the dispatch burn-through test. */
	failCua?: boolean;
	/** cua act calls fail with empty stderr and this stdout — the
	 *  driver reports structured errors on stdout too. */
	failCuaStdout?: string;
	/** cua act calls hold until this resolves — lane-interleave tests. */
	execGate?: Promise<void>;
	/** Guest paths that exist as directories — the cpIn pre-check. */
	existingDirs?: Set<string>;
	/** Guest dirs desk cannot write — the cpIn desk-governance model. */
	rootDirs?: Set<string>;
}) {
	const containers = new Map<string, FakeContainer>();
	for (const c of opts?.containers ?? []) {
		containers.set(c.name, {
			image: c.image ?? IMAGE,
			running: c.running ?? true,
			networks: new Set(c.networks ?? []),
			labels: c.labels ?? {},
		});
	}
	const networks = new Set<string>();
	const calls: string[][] = [];
	const execCalls: string[][] = [];
	let frame = 0;
	// Mutable at call time — fail-closed network tests arm these after
	// the create path's own inspects have run.
	const flags = {
		// Inspect fails once the ordinal count reaches this (relative
		// arming: flags.failInspectFrom = flags.inspectCalls + k).
		inspectCalls: 0,
		failInspectFrom: undefined as number | undefined,
		failRm: false,
		failDisconnect: false,
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
			containers.get(args[3]!)?.networks.delete(args[2]!);
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
			});
			return { code: 0, stdout: "abc123\n", stderr: "" };
		}
		if (cmd === "start") {
			containers.get(args[1]!)!.running = true;
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
		throw new Error(`fake podman: unhandled argv ${JSON.stringify(args)}`);
	};

	const execRunner = async (args: string[], execOpts: PodmanExecOpts): Promise<BoundedProc> => {
		execCalls.push([...args]);
		// The cpIn pre-check / post-check shell probes: the last
		// positional arg before/after the marker is the guest path.
		const marker = args.indexOf("pre");
		if (marker !== -1 && opts?.existingDirs?.has(args[marker + 1] ?? "")) {
			return {
				stdout: "",
				stderr: "exists as directory",
				exitCode: 3,
				timedOut: false,
				truncated: false,
			};
		}
		if (
			args.includes("mkdir") ||
			args.includes("chown") ||
			args.includes("stat") ||
			args.includes("chmod")
		) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		// The cpIn post-verify probe (regular file, not a symlink).
		if (args.some((a) => a.startsWith("{ [ -f"))) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		// The desk-side stage→dest copy: desk cannot write under a
		// rootDirs parent — that refusal is the import's governance.
		if (args.includes("cp")) {
			const dest = args.at(-1) ?? "";
			if (execOpts.user === "desk" && opts?.rootDirs?.has(posix.dirname(dest)) === true) {
				return {
					stdout: "",
					stderr: "Permission denied",
					exitCode: 1,
					timedOut: false,
					truncated: false,
				};
			}
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args[0] === "/bin/sh" && args[1] === "-c" && args[2]?.startsWith("if [ -e")) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args[0] === "/bin/sh" && args[1] === "-c" && args[2]?.includes("chown")) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args.includes("scrot")) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args.includes("rm")) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args.includes("goblin-launch")) {
			return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
		}
		if (args.includes("list_windows")) {
			return {
				stdout: JSON.stringify({
					windows: [{ pid: 100, app_name: "Chromium", title: "w", z_index: 5 }],
				}),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
			};
		}
		if (args.includes("get_window_state")) {
			return {
				stdout: JSON.stringify({ elements: [{ role: "button", label: "b" }] }),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
			};
		}
		// cua act calls: report a driver-claimed effect.
		if (opts?.execGate !== undefined) await opts.execGate;
		if (opts?.failCua === true || opts?.failCuaStdout !== undefined) {
			return {
				stdout: opts.failCuaStdout ?? "",
				stderr: opts.failCuaStdout !== undefined ? "" : "driver exploded",
				exitCode: 1,
				timedOut: false,
				truncated: false,
			};
		}
		return {
			stdout: JSON.stringify({ status: "done", effect: "unverifiable" }),
			stderr: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
		};
	};

	const execBytesRunner = async (
		_args: string[],
		_opts: PodmanExecOpts,
	): Promise<BoundedProcBytes> => {
		frame += 1;
		return {
			stdout: opts?.varyFrames === true ? new Uint8Array([...PNG, frame & 0xff]) : PNG,
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

function rig(engine: ReturnType<typeof fakeEngine>, config?: Partial<DesktopsConfig>) {
	const root = mkdtempSync(join(tmpdir(), "goblin-desk-shots-"));
	const store = openDesktops(tmpdb());
	const desktops = makeDesktops({
		podman: engine.podman,
		store,
		config: () => ({
			...desktopsConfigSchema.parse({}),
			image: IMAGE,
			...config,
		}),
		shotsRoot: root,
		networkName: NETWORK,
	});
	return { store, desktops, shotsRoot: root };
}

async function fresh(engine: ReturnType<typeof fakeEngine>, name = "d1") {
	const { store, desktops, shotsRoot } = rig(engine);
	await desktops.allocate(name);
	return { store, desktops, name, shotsRoot };
}

const CLICK = {
	kind: "cua",
	tool: "click",
	args: { pid: 100, element_token: "s00000001:9" },
} as const;

describe("desktops pool", () => {
	test("allocate creates a disconnected session container with desktop labels", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		const c = engine.containers.get(containerNameForDesktop(name))!;
		expect(c.running).toBe(true);
		expect(c.labels["goblin.desktop"]).toBe("1");
		expect(c.labels["goblin.desktop.name"]).toBe(name);
		expect(c.labels["goblin.sandbox"]).toBeUndefined();
		expect(c.networks.size).toBe(0);
		const createArgv = engine.calls.find((a) => a[0] === "run")!;
		for (const flag of [
			"--pull=never",
			"--uidmap",
			"0:40000:8192",
			"--cap-drop",
			"ALL",
			"--cap-add",
			"CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID,SYS_CHROOT",
			"--security-opt",
			"no-new-privileges",
			"--init",
			"--shm-size",
			"1g",
			"--hostname",
			"desktop",
			"/usr/local/bin/goblin-desktop-session",
		]) {
			expect(createArgv).toContain(flag);
		}
		expect(engine.networks.has(NETWORK)).toBe(true);
	});

	test("invalid names are refused", async () => {
		const engine = fakeEngine();
		const { desktops } = rig(engine);
		await expect(desktops.allocate("Has_Caps")).rejects.toThrow(/invalid desktop name/);
		await expect(desktops.allocate("-bad")).rejects.toThrow(/invalid desktop name/);
	});

	test("allocate refuses at max and names the pool", async () => {
		const engine = fakeEngine();
		const { desktops } = rig(engine, { max: 1 });
		await desktops.allocate("d1");
		await expect(desktops.allocate("d2")).rejects.toThrow(/pool is full.*d1/s);
	});

	test("a racing allocation counts the in-flight one — parallel allocate can't exceed the pool cap", async () => {
		const gate = Promise.withResolvers<void>();
		const engine = fakeEngine();
		const { desktops, store } = rig(engine, { max: 1 });
		// Park the create so d1's reservation is held but its row is
		// not yet visible — only the pending set can count it.
		const origCreate = engine.podman.create.bind(engine.podman);
		engine.podman.create = async (spec, conv) => {
			await gate.promise;
			return origCreate(spec, conv);
		};
		const first = desktops.allocate("d1");
		const second = desktops.allocate("d2");
		// d2 rejects while d1's create is still parked — the pending
		// reservation is what counted it.
		const b = await second.catch((e: unknown) => e);
		gate.resolve();
		const a = await first;
		expect(a.row.name).toBe("d1");
		expect(b).toBeInstanceOf(DesktopError);
		expect((b as Error).message).toMatch(/pool is full/);
		// Exactly one container, exactly one row — the reservation
		// never let both pass.
		expect(engine.containers.has(containerNameForDesktop("d1"))).toBe(true);
		expect(engine.containers.has(containerNameForDesktop("d2"))).toBe(false);
		expect(store.get("d1")).not.toBeNull();
		expect(store.get("d2")).toBeNull();
	});

	test("a failed allocation releases the reservation; a same-name duplicate is refused while held", async () => {
		const gate = Promise.withResolvers<void>();
		const engine = fakeEngine();
		const { desktops, store } = rig(engine, { max: 1 });
		const origCreate = engine.podman.create.bind(engine.podman);
		let failCreate = true;
		engine.podman.create = async (spec, conv) => {
			await gate.promise;
			if (failCreate) throw new Error("podman exploded");
			return origCreate(spec, conv);
		};
		const first = desktops.allocate("d1");
		// The same name is refused outright while the reservation
		// holds, and the pool still counts it against capacity.
		await expect(desktops.allocate("d1")).rejects.toThrow(/already being allocated/);
		await expect(desktops.allocate("d2")).rejects.toThrow(/pool is full/);
		gate.resolve();
		await expect(first).rejects.toThrow(/podman exploded/);
		// Reservation released with the failure — the retry succeeds.
		failCreate = false;
		await desktops.allocate("d1");
		expect(store.get("d1")).not.toBeNull();
	});

	test("a missing image fails with the build line before any create", async () => {
		const engine = fakeEngine();
		const { desktops } = rig(engine, { image: "localhost/goblin-desktop:nope" });
		await expect(desktops.allocate("d1")).rejects.toThrow(
			"podman build -t localhost/goblin-desktop:nope deploy/desktop",
		);
		expect(engine.calls.some((a) => a[0] === "run")).toBe(false);
	});

	test("a second claim is refused while a lease is live; expiry frees it; release is holder-only", async () => {
		const engine = fakeEngine();
		const { desktops, store, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		await expect(desktops.claim(name, RUN_B)).rejects.toThrow(/controlled by run a/);
		// Re-claim by the holder renews.
		await desktops.claim(name, RUN_A);
		// Expire the lease by rewinding the row.
		const row = store.get(name)!;
		row.leaseExpiresAt = Date.now() - 1000;
		store.put(row);
		await desktops.claim(name, RUN_B);
		await expect(desktops.release(name, RUN_A)).rejects.toThrow(/only the holder/);
		await desktops.release(name, RUN_B);
		expect(store.get(name)!.leaseKind).toBeNull();
	});

	test("act requires the newest, unconsumed observation", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const { desktops, name } = await fresh(engine);
		// No lease.
		await expect(desktops.act(name, RUN_A, "d1:0", CLICK)).rejects.toThrow(/no live lease/);
		await desktops.claim(name, RUN_A);
		// Stale obs id (never minted).
		await expect(desktops.act(name, RUN_A, "d1:0", CLICK)).rejects.toThrow(/fresh screenshot/);
		const shot = await desktops.screenshot(name);
		const out = await desktops.act(name, RUN_A, shot.id, CLICK);
		expect(out.result).toMatchObject({ effect: "unverifiable" });
		// Same observation can only be consumed once.
		await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/fresh screenshot/);
		// A fresh screenshot unlocks.
		const shot2 = await desktops.screenshot(name);
		await desktops.act(name, RUN_A, shot2.id, CLICK);
		// The holder's lease is renewed by acting; another holder is refused.
		await expect(desktops.act(name, RUN_B, shot2.id, CLICK)).rejects.toThrow(/controlled by run a/);
	});

	test("an identical action against an unchanged frame is refused", async () => {
		const engine = fakeEngine(); // frames never vary
		const { desktops, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const s1 = await desktops.screenshot(name);
		await desktops.act(name, RUN_A, s1.id, CLICK);
		const s2 = await desktops.screenshot(name);
		await expect(desktops.act(name, RUN_A, s2.id, CLICK)).rejects.toThrow(/unchanged screen/);
		// A different action is not the same signature — allowed.
		await desktops.act(name, RUN_A, s2.id, {
			kind: "cua",
			tool: "click",
			args: { pid: 100, element_token: "s00000001:10" },
		});
	});

	test("a changed frame unblocks an identical action", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const { desktops, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const s1 = await desktops.screenshot(name);
		await desktops.act(name, RUN_A, s1.id, CLICK);
		const s2 = await desktops.screenshot(name);
		await desktops.act(name, RUN_A, s2.id, CLICK);
	});

	test("a restart invalidates the pre-restart observation before any input dispatch", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const { desktops, store, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		// A host-side stop kills whatever that frame showed.
		engine.containers.get(containerNameForDesktop(name))!.running = false;
		const execBefore = engine.execCalls.length;
		await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/fresh screenshot/);
		// The container restarted, but no input was dispatched and the
		// dead frame is persisted-invalidated while the lease survives.
		expect(engine.containers.get(containerNameForDesktop(name))!.running).toBe(true);
		expect(engine.execCalls.length).toBe(execBefore);
		const row = store.get(name)!;
		expect(row.lastObsId).toBeNull();
		expect(row.lastObsHash).toBeNull();
		expect(row.lastActSig).toBeNull();
		expect(row.leaseKind).toBe("run");
		expect(row.shotSeq).toBe(1);
		// A fresh observation mints a new id and dispatches under the same lease.
		const shot2 = await desktops.screenshot(name);
		expect(shot2.id).not.toBe(shot.id);
		const out = await desktops.act(name, RUN_A, shot2.id, CLICK);
		expect(out.result).toMatchObject({ effect: "unverifiable" });
	});

	test("a failed restart still persists the invalidation — the dead frame can't ride a later act", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const { desktops, store, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		engine.containers.get(containerNameForDesktop(name))!.running = false;
		const realStart = engine.podman.start.bind(engine.podman);
		engine.podman.start = async () => {
			engine.podman.start = realStart;
			throw new Error("start exploded");
		};
		await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/start exploded/);
		expect(store.get(name)!.lastObsId).toBeNull();
		// The retry restarts for real, tells the caller the frame is
		// gone, and mints a fresh observation id.
		const obs = await desktops.screenshot(name);
		expect(obs.note).toContain("fresh screenshot");
		expect(obs.id).not.toBe(shot.id);
	});

	test("destroy is refused while another holder's lease is live", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		await expect(desktops.destroy(name, { kind: "operator" })).rejects.toThrow(/controlled by/);
		await desktops.destroy(name, RUN_A);
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(false);
	});

	test("the sweep skips leased, reserved and the caller; idleHours 0 never reaps", async () => {
		const engine = fakeEngine();
		const { desktops, store } = rig(engine, { idleHours: 1 });
		const old = Date.now() - 2 * 3_600_000;
		const mk = (name: string) => {
			engine.containers.set(containerNameForDesktop(name), {
				image: IMAGE,
				running: true,
				networks: new Set(),
				labels: { "goblin.desktop": "1", "goblin.desktop.name": name },
			});
			store.put({
				name,
				container: containerNameForDesktop(name),
				image: IMAGE,
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
				createdAt: old,
				lastUsedAt: old,
			});
		};
		for (const n of ["stale", "leased", "pinned", "caller"]) mk(n);
		// Leased-but-live and reserved are exempt.
		const leased = store.get("leased")!;
		leased.leaseKind = "run";
		leased.leaseId = "r1";
		leased.leaseExpiresAt = Date.now() + 60_000;
		store.put(leased);
		const pinned = store.get("pinned")!;
		pinned.reserved = true;
		store.put(pinned);
		await desktops.screenshot("caller");
		expect(engine.containers.has(containerNameForDesktop("stale"))).toBe(false);
		expect(store.get("stale")).toBeNull();
		for (const kept of ["leased", "pinned", "caller"]) {
			expect(engine.containers.has(containerNameForDesktop(kept))).toBe(true);
			expect(store.get(kept)).not.toBeNull();
		}
	});

	test("idleHours 0 never reaps", async () => {
		const engine = fakeEngine();
		const { desktops, store } = rig(engine, { idleHours: 0 });
		const name = "ancient";
		engine.containers.set(containerNameForDesktop(name), {
			image: IMAGE,
			running: true,
			networks: new Set(),
			labels: { "goblin.desktop": "1", "goblin.desktop.name": name },
		});
		store.put({
			name,
			container: containerNameForDesktop(name),
			image: IMAGE,
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
			createdAt: 1,
			lastUsedAt: 1,
		});
		await desktops.allocate("fresh");
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
		expect(store.get(name)).not.toBeNull();
	});

	test("a missing container with a row is recreated and says state is gone", async () => {
		const engine = fakeEngine();
		const { desktops, store, name } = await fresh(engine);
		engine.containers.delete(containerNameForDesktop(name));
		const shot = await desktops.screenshot(name);
		expect(shot.id).toMatch(/^d1:/);
		// Recreated: same name row, same audit generation — the shot
		// sequence carries over so pre-loss obs ids stay dead.
		const row = store.get(name)!;
		expect(row.shotSeq).toBe(1);
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
	});

	test("an unlabelled container squatting on the name is refused", async () => {
		const engine = fakeEngine({
			containers: [{ name: containerNameForDesktop("d1"), labels: {} }],
		});
		const { desktops } = rig(engine);
		await expect(desktops.allocate("d1")).rejects.toThrow(/not a goblin desktop/);
		await expect(desktops.screenshot("d1")).rejects.toThrow(/not a goblin desktop/);
		expect(engine.containers.has(containerNameForDesktop("d1"))).toBe(true);
	});

	test("the screenshot audit file lands durably under shotsRoot", async () => {
		const engine = fakeEngine();
		const { desktops, name, shotsRoot } = await fresh(engine);
		const shot = await desktops.screenshot(name);
		const createdAt = desktops.get(name)!.createdAt;
		expect(dirname(shot.path)).toBe(join(shotsRoot, name, "shots"));
		// The obs id's uuid rides the audit basename: createdAt-seq-uuid.
		expect(basename(shot.path)).toMatch(
			new RegExp(`^${createdAt}-1-${shot.id.split(":")[2]}\\.png$`),
		);
		expect(shot.bytes).toEqual(PNG);
		expect(await Bun.file(shot.path).exists()).toBe(true);
	});

	test("a recreated container continues the shot sequence — no audit clobber", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		const first = await desktops.screenshot(name);
		// Engine-level loss → ensureLocked recreates; the shots dir is
		// shared across the recreate, so both frames must survive.
		engine.containers.delete(containerNameForDesktop(name));
		const second = await desktops.screenshot(name);
		expect(second.id).toMatch(/^d1:2:[0-9a-f-]{36}$/);
		expect(second.path).not.toBe(first.path);
		expect(await Bun.file(first.path).exists()).toBe(true);
		expect(await Bun.file(second.path).exists()).toBe(true);
	});

	test("a destroy/re-allocate generation cannot clobber frames or reuse obs ids", async () => {
		// Pin the clock so createdAt collides exactly across the
		// recreation — the uuid is what keeps ids and frames apart.
		const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const engine = fakeEngine();
			const { desktops, name } = await fresh(engine);
			await desktops.claim(name, RUN_A);
			const first = await desktops.screenshot(name);
			const firstId = first.id;
			const firstCreatedAt = desktops.get(name)!.createdAt;
			await desktops.destroy(name, RUN_A);
			await desktops.allocate(name);
			expect(desktops.get(name)!.createdAt).toBe(firstCreatedAt);
			const second = await desktops.screenshot(name);
			expect(second.id).not.toBe(firstId);
			expect(second.id).toMatch(/^d1:1:[0-9a-f-]{36}$/);
			expect(second.path).not.toBe(first.path);
			expect(await Bun.file(first.path).exists()).toBe(true);
			expect(await Bun.file(second.path).exists()).toBe(true);
			// The previous generation's obs id can never bind to the new
			// desktop's frame; the fresh id acts.
			await desktops.claim(name, RUN_A);
			await expect(desktops.act(name, RUN_A, firstId, CLICK)).rejects.toThrow(/fresh screenshot/);
			await desktops.act(name, RUN_A, second.id, CLICK);
		} finally {
			clock.mockRestore();
		}
	});

	test("launch refuses flag-shaped and non-web urls before any exec", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		// A refused url is validation, not dispatch — the observation
		// is not consumed, so the same id binds each attempt.
		for (const url of [
			"--remote-debugging-port=9222",
			"--load-extension=/x",
			"--user-data-dir=/tmp/x",
			"--gpu-launcher=sh -c id",
			"javascript:alert(1)",
			"chrome://flags",
			"https://example.com/a b",
		]) {
			await expect(
				desktops.act(name, RUN_A, shot.id, {
					kind: "launch",
					app: "chromium",
					url,
				}),
			).rejects.toThrow(/not allowed/);
		}
		expect(engine.execCalls.some((a) => a.includes("goblin-launch"))).toBe(false);
		// The allowlist passes through as the single trailing arg.
		for (const url of ["https://example.com/", "file:///tmp/probe.html", "about:blank"]) {
			const s = await desktops.screenshot(name);
			await desktops.act(name, RUN_A, s.id, { kind: "launch", app: "chromium", url });
		}
		const launches = engine.execCalls.filter((a) => a.includes("goblin-launch"));
		expect(launches.map((a) => a.at(-1))).toEqual([
			"https://example.com/",
			"file:///tmp/probe.html",
			"about:blank",
		]);
		// The launcher always runs as desk with the fixed session env —
		// never as root, never inheriting container-writable state.
		const launch = launches[0]!;
		expect(launch[launch.indexOf("-u") + 1]).toBe("desk");
		expect(launch[launch.indexOf("-w") + 1]).toBe("/run/desk");
		const envPairs = launch.filter((_, i) => launch[i - 1] === "-e");
		for (const pair of [
			"HOME=/home/desk",
			"DISPLAY=:99",
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/desk/bus",
			"XDG_RUNTIME_DIR=/home/desk/.runtime",
		]) {
			expect(envPairs).toContain(pair);
		}
	});

	test("a failed dispatch consumes its observation — input is never replayed", async () => {
		const lines: Record<string, unknown>[] = [];
		setLogFile("capture");
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		try {
			const engine = fakeEngine({ failCua: true });
			const { desktops, name } = await fresh(engine);
			await desktops.claim(name, RUN_A);
			const shot = await desktops.screenshot(name);
			const err = await desktops.act(name, RUN_A, shot.id, CLICK).then(
				() => {
					throw new Error("unreachable");
				},
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(DesktopError);
			expect((err as Error).message).toMatch(/may have partially run.*fresh screenshot/s);
			// The dispatch error rides as the cause for debugging.
			expect((err as Error).cause).toBeInstanceOf(DesktopError);
			// The obs burned with the attempt; the same id cannot retry.
			await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/fresh screenshot/);
			const logged = lines.find((l) => l.msg === "desktop act failed");
			expect(logged).toMatchObject({
				desktop: name,
				holder: "run a",
				obs: shot.id,
				action: "cua:click",
			});
			expect(typeof logged?.ms).toBe("number");
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});

	test("a driver error reported on stdout survives into the act diagnostic", async () => {
		const lines: Record<string, unknown>[] = [];
		setLogFile("capture");
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		try {
			const diag = "target_required: pass scope desktop or a window target";
			const engine = fakeEngine({ failCuaStdout: JSON.stringify({ error: diag }) });
			const { desktops, name } = await fresh(engine);
			await desktops.claim(name, RUN_A);
			const shot = await desktops.screenshot(name);
			const err = await desktops.act(name, RUN_A, shot.id, CLICK).then(
				() => {
					throw new Error("unreachable");
				},
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(DesktopError);
			// The driver reported on stdout with stderr empty — the cause
			// must still carry its diagnostic.
			expect((err as Error).cause).toBeInstanceOf(DesktopError);
			expect((err as Error).cause).toMatchObject({ message: expect.stringContaining(diag) });
			// The observation still burned with the attempt.
			await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/fresh screenshot/);
			const logged = lines.find((l) => l.msg === "desktop act failed");
			expect(logged).toMatchObject({ desktop: name, action: "cua:click" });
			// Plain-text stdout diagnostics survive the same way.
			const engine2 = fakeEngine({ failCuaStdout: `${diag}\n` });
			const { desktops: d2, name: n2 } = await fresh(engine2);
			await d2.claim(n2, RUN_A);
			const shot2 = await d2.screenshot(n2);
			const err2 = await d2.act(n2, RUN_A, shot2.id, CLICK).catch((e: unknown) => e);
			expect((err2 as Error).cause).toMatchObject({
				message: expect.stringContaining(diag),
			});
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});

	test("a release issued during an in-flight act waits for the lane and sticks", async () => {
		const gate = Promise.withResolvers<void>();
		const engine = fakeEngine({ execGate: gate.promise });
		const { desktops, store, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		const acting = desktops.act(name, RUN_A, shot.id, CLICK);
		// The release queues behind the act inside the lane instead of
		// read-modify-writing a stale row underneath it.
		const releasing = desktops.release(name, RUN_A);
		gate.resolve();
		await acting;
		await releasing;
		expect(store.get(name)!.leaseKind).toBeNull();
		expect(store.get(name)!.leaseExpiresAt).toBeNull();
	});

	test("invalid image refs are refused before any podman call", async () => {
		const engine = fakeEngine();
		const { desktops } = rig(engine);
		await expect(desktops.allocate("d1", { image: "-bad" })).rejects.toThrow(
			/invalid desktop image/,
		);
		await expect(desktops.allocate("d1", { image: "x;rm -rf /" })).rejects.toThrow(
			/invalid desktop image/,
		);
		expect(engine.calls.length).toBe(0);
	});

	test("import onto an existing directory refuses before cp or chown", async () => {
		const engine = fakeEngine({ existingDirs: new Set(["/home/desk"]) });
		const { desktops, name } = await fresh(engine);
		const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
		writeFileSync(host, "x");
		await expect(desktops.cpIn(name, host, "/home/desk")).rejects.toThrow(/non-regular/);
		// Nothing was copied and NO recursive chown ran anywhere.
		expect(engine.calls.some((c) => c[0] === "cp")).toBe(false);
		expect(engine.execCalls.some((c) => c.includes("-R"))).toBe(false);
		// Non-file destinations are refused before the guest is touched.
		await expect(desktops.cpIn(name, host, "relative/path")).rejects.toThrow(/absolute file path/);
		await expect(desktops.cpIn(name, host, "/home/desk/")).rejects.toThrow(/absolute file path/);
	});

	test("import lands as the desk user — root only stages the bytes", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
		writeFileSync(host, "x");
		await desktops.cpIn(name, host, "/home/desk/inbox/subagents/1/f.bin");
		// podman cp targets a goblin-chosen stage path, never the dest.
		const cp = engine.calls.find((c) => c[0] === "cp");
		expect(cp).toBeDefined();
		expect(cp![2]).toMatch(new RegExp(`^${containerNameForDesktop(name)}:/run/goblin-import/imp-`));
		// The stage dir is created by root (no -u) and the staged file
		// is made desk-readable before the desk-side copy.
		const stageMk = engine.execCalls.find(
			(c) => c.includes("mkdir") && c.at(-1) === "/run/goblin-import",
		);
		expect(stageMk).toBeDefined();
		expect(stageMk).not.toContain("-u");
		const chmod = engine.execCalls.find((c) => c.includes("chmod"));
		expect(chmod).toBeDefined();
		expect(chmod).not.toContain("-u");
		// The destination write ran as desk, stage → dest.
		const deskCp = engine.execCalls.find((c) => c.includes("cp"));
		expect(deskCp).toBeDefined();
		expect(deskCp![deskCp!.indexOf("-u") + 1]).toBe("desk");
		expect(deskCp!.at(-1)).toBe("/home/desk/inbox/subagents/1/f.bin");
		expect(engine.execCalls.indexOf(chmod!) < engine.execCalls.indexOf(deskCp!)).toBe(true);
		// No chown anywhere — desk's own cp creates the file desk-owned.
		expect(engine.execCalls.some((c) => c.join(" ").includes("chown"))).toBe(false);
		// The staged file is cleaned up by a root rm.
		const rm = engine.execCalls.find(
			(c) => c.includes("rm") && c.at(-1)?.startsWith("/run/goblin-import/imp-"),
		);
		expect(rm).toBeDefined();
		expect(rm).not.toContain("-u");
	});

	test("import into a root-owned directory fails — desk cannot write it", async () => {
		const engine = fakeEngine({ rootDirs: new Set(["/etc"]) });
		const { desktops, name } = await fresh(engine);
		const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
		writeFileSync(host, "x");
		await expect(desktops.cpIn(name, host, "/etc/f.bin")).rejects.toThrow(/could not import/);
		// The desk-side copy was attempted as desk and the staged file
		// was cleaned up after the failure.
		const deskCp = engine.execCalls.find((c) => c.includes("cp"));
		expect(deskCp).toBeDefined();
		expect(deskCp![deskCp!.indexOf("-u") + 1]).toBe("desk");
		const rm = engine.execCalls.find(
			(c) => c.includes("rm") && c.at(-1)?.startsWith("/run/goblin-import/imp-"),
		);
		expect(rm).toBeDefined();
	});
});

// A sweep triggered by another desktop must not reap a stale row out
// from under an in-flight operation on that same desktop. The stale
// listing runs outside any lane; the removal verdict has to be
// re-read inside the victim's lane, after the in-flight call has
// landed its activity/lease — otherwise a live claim or a fresh
// observation still loses its container.
describe("idle sweep vs in-flight lane op", () => {
	function deadline<T>(p: Promise<T>, what: string, ms = 2000): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`deadline: ${what}`)), ms);
		});
		return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
	}

	async function staleRace<T>(
		engine: ReturnType<typeof fakeEngine>,
		op: (desktops: Desktops) => Promise<T>,
		check: (outcome: {
			engine: ReturnType<typeof fakeEngine>;
			row: DesktopRow;
			containerName: string;
			containerObj: FakeContainer;
			result: T;
		}) => void,
	): Promise<void> {
		const inspectEntered = Promise.withResolvers<void>();
		const inspectGate = Promise.withResolvers<void>();
		const sweepListed = Promise.withResolvers<void>();
		const { store, desktops } = rig(engine, { idleHours: 1 });
		let inFlight: Promise<T> | undefined;
		let sweeping: Promise<void> | undefined;
		try {
			await desktops.allocate("a");
			await desktops.allocate("b");
			const aged = store.get("a")!;
			aged.lastUsedAt = Date.now() - 2 * 3_600_000;
			store.put(aged);
			const containerName = aged.container;
			const containerObj = engine.containers.get(containerName)!;

			// The in-flight op parks at its first inspect of a, inside
			// a's lane; the sweep's stale listing of a is only
			// observed, then removal races the parked op's resume.
			const origInspect = engine.podman.inspect.bind(engine.podman);
			let firstInspect = true;
			engine.podman.inspect = async (name: string, conv?: string) => {
				if (name === containerName && firstInspect) {
					firstInspect = false;
					inspectEntered.resolve();
					await inspectGate.promise;
				}
				return origInspect(name, conv);
			};
			const origStale = store.staleBefore.bind(store);
			store.staleBefore = (cutoffMs: number, excludeName: string) => {
				const rows = origStale(cutoffMs, excludeName);
				if (excludeName === "b" && rows.some((r) => r.name === "a")) {
					sweepListed.resolve();
				}
				return rows;
			};

			inFlight = op(desktops);
			await deadline(inspectEntered.promise, "in-flight op entered inspect");
			sweeping = desktops.reserve("b", true);
			await deadline(sweepListed.promise, "sweep listed stale a");
			inspectGate.resolve();
			const result = await deadline(inFlight, "in-flight op settled");
			await deadline(sweeping, "reserve settled");

			const row = store.get("a");
			expect(row).not.toBeNull();
			expect(engine.calls.some((c) => c[0] === "rm" && c.at(-1) === containerName)).toBe(false);
			expect(engine.containers.get(containerName)).toBe(containerObj);
			expect(row!.lastUsedAt).toBeGreaterThan(Date.now() - 3_600_000);
			check({ engine, row: row!, containerName, containerObj, result });
		} finally {
			inspectEntered.resolve();
			inspectGate.resolve();
			sweepListed.resolve();
			try {
				await deadline(Promise.allSettled([inFlight, sweeping]), "race cleanup settled");
			} finally {
				store.close();
			}
		}
	}

	test("an in-flight claim wins over another desktop's reap sweep", async () => {
		const engine = fakeEngine();
		await staleRace(
			engine,
			(desktops) => desktops.claim("a", RUN_A),
			({ row }) => {
				expect(row.leaseKind).toBe("run");
				expect(row.leaseId).toBe("a");
				expect(row.leaseExpiresAt!).toBeGreaterThan(Date.now());
			},
		);
	});

	test("an in-flight observation refreshes a stale row before the reap verdict", async () => {
		const engine = fakeEngine();
		await staleRace(
			engine,
			(desktops) => desktops.screenshot("a"),
			({ row, result }) => {
				expect(row.leaseKind).toBeNull();
				expect(result.id).toMatch(/^a:1:[0-9a-f-]{36}$/);
				expect(result.bytes.length).toBeGreaterThan(0);
			},
		);
	});
});

describe("fail-closed desktop network", () => {
	// Allocate, then attach the container and mark the row's intent on
	// so the network-off path runs its own verifies.
	async function attached(name: string, engine: ReturnType<typeof fakeEngine>) {
		const { store, desktops } = rig(engine);
		await desktops.allocate(name);
		engine.containers.get(containerNameForDesktop(name))!.networks.add(NETWORK);
		const row = store.get(name)!;
		row.network = true;
		store.put(row);
		return { store, desktops };
	}

	test("an unverifiable confirming inspect removes the container and row", async () => {
		const name = "d1";
		const engine = fakeEngine();
		const { store, desktops } = await attached(name, engine);
		// ensureLocked inspect, the want-true reconcile inspect, the
		// desired-off pre-inspect, then the post-disconnect
		// confirmation — that fourth one throws.
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 4;
		await expect(desktops.setNetwork(name, false)).rejects.toThrow(
			/could not be inspected.*container was removed/s,
		);
		// The disconnect ran first — the removal is the fail-closed
		// verdict, not a skipped-off ramp.
		const calls = engine.calls;
		const disconnect = calls.findLastIndex((a) => a[0] === "network" && a[1] === "disconnect");
		const rm = calls.findLastIndex((a) => a[0] === "rm");
		expect(disconnect).toBeGreaterThanOrEqual(0);
		expect(rm).toBeGreaterThan(disconnect);
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(false);
		expect(store.get(name)).toBeNull();
	});

	test("an unverifiable initial inspect removes the container and row", async () => {
		const name = "d1";
		const engine = fakeEngine();
		const { store, desktops } = rig(engine);
		await desktops.allocate(name);
		// Attached container, off intent — the applyNetwork inspect
		// (second overall) throws before any verdict.
		engine.containers.get(containerNameForDesktop(name))!.networks.add(NETWORK);
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 2;
		await expect(desktops.claim(name, RUN_A)).rejects.toThrow(
			/could not be inspected.*container was removed/s,
		);
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(false);
		expect(store.get(name)).toBeNull();
	});

	test("a failed disconnect removes the container and row too", async () => {
		const name = "d1";
		const engine = fakeEngine();
		const { store, desktops } = await attached(name, engine);
		engine.flags.failDisconnect = true;
		await expect(desktops.setNetwork(name, false)).rejects.toThrow(
			/disconnect failed.*container was removed/s,
		);
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(false);
		expect(store.get(name)).toBeNull();
	});

	test("a failed fail-closed removal surfaces the rm error and keeps the row", async () => {
		const name = "d1";
		const engine = fakeEngine();
		const { store, desktops } = await attached(name, engine);
		engine.flags.failInspectFrom = engine.flags.inspectCalls + 4;
		engine.flags.failRm = true;
		await expect(desktops.setNetwork(name, false)).rejects.toThrow(
			/could not be inspected.*could not be removed.*rm wedged/s,
		);
		// rm never landed — container and row survive for the retry,
		// the original inspect failure stays the cause.
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
		expect(store.get(name)).not.toBeNull();
	});
});

describe("observation id persistence", () => {
	test("lastObsId survives a store reopen — act still binds after a restart", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const dbPath = tmpdb();
		const root = mkdtempSync(join(tmpdir(), "goblin-desk-shots-"));
		const mk = () =>
			makeDesktops({
				podman: engine.podman,
				store: openDesktops(dbPath),
				config: () => ({ ...desktopsConfigSchema.parse({}), image: IMAGE }),
				shotsRoot: root,
				networkName: NETWORK,
			});
		const d1 = mk();
		await d1.allocate("a");
		await d1.claim("a", RUN_A);
		const shot = await d1.screenshot("a");
		// A fresh owner on the same db — the goblin-restart shape.
		const d2 = mk();
		expect(d2.get("a")!.lastObsId).toBe(shot.id);
		await d2.act("a", RUN_A, shot.id, CLICK);
	});
});
