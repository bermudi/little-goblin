// The desktop pool's boundaries against a fake podman at the argv
// seam (the sandboxes.test.ts pattern): what the tests pin is the
// single-controller lease, the observation-binding invariant (an input
// action must name the newest, unconsumed frame, and an identical
// action against an unchanged screen is refused), the idle-reap
// sweep, and the fail-closed network. No real podman runs here; the
// real-engine check is gated on GOBLIN_DESKTOP_LIVE=1.

import { describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { desktopsConfigSchema, type DesktopsConfig } from "./config.ts";
import { makePodman, type PodmanExecOpts } from "./podman.ts";
import type { BoundedProc, BoundedProcBytes } from "./proc.ts";
import {
	CUA_TOOLS,
	DesktopError,
	containerNameForDesktop,
	makeDesktops,
	openDesktops,
	type CuaTool,
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
	/** The boot generation podman reports as State.StartedAt — a
	 *  restart (in-band or out-of-band) moves it, Running stays. */
	startedAt: string;
}

function tmpdb(): string {
	return join(mkdtempSync(join(tmpdir(), "goblin-desk-")), "goblin.sqlite");
}

// The detached reaper chain means a caller no longer awaits reaps —
// tests poll for the effect instead of assuming it landed.
async function waitFor(what: string, pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for: ${what}`);
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
	let boot = 0;
	const nextBoot = (): string => `boot-${++boot}`;
	for (const c of opts?.containers ?? []) {
		containers.set(c.name, {
			image: c.image ?? IMAGE,
			running: c.running ?? true,
			networks: new Set(c.networks ?? []),
			labels: c.labels ?? {},
			startedAt: nextBoot(),
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
		// Readback integrity faults — a capped or drain-cut execBytes
		// read still exits 0 with nonempty bytes.
		truncatedRead: false,
		cappedRead: false,
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
						State: {
							Status: c.running ? "running" : "exited",
							Running: c.running,
							StartedAt: c.startedAt,
						},
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
				startedAt: nextBoot(),
			});
			return { code: 0, stdout: "abc123\n", stderr: "" };
		}
		if (cmd === "start") {
			const c = containers.get(args[1]!)!;
			c.running = true;
			// A start is a fresh boot — the generation moves, like the
			// real engine's State.StartedAt.
			c.startedAt = nextBoot();
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
				killed: false,
				truncated: false,
			};
		}
		if (
			args.includes("mkdir") ||
			args.includes("chown") ||
			args.includes("stat") ||
			args.includes("chmod")
		) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		// The cpIn post-verify probe (regular file, not a symlink).
		if (args.some((a) => a.startsWith("{ [ -f"))) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
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
					killed: false,
					truncated: false,
				};
			}
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args[0] === "/bin/sh" && args[1] === "-c" && args[2]?.startsWith("if [ -e")) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args[0] === "/bin/sh" && args[1] === "-c" && args[2]?.includes("chown")) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args.includes("scrot")) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args.includes("rm")) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args.includes("goblin-launch")) {
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args.includes("list_windows")) {
			return {
				stdout: JSON.stringify({
					windows: [{ pid: 100, app_name: "Chromium", title: "w", z_index: 5 }],
				}),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
				truncated: false,
			};
		}
		if (args.includes("get_window_state")) {
			return {
				stdout: JSON.stringify({ elements: [{ role: "button", label: "b" }] }),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				killed: false,
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
				killed: false,
				truncated: false,
			};
		}
		return {
			stdout: JSON.stringify({ status: "done", effect: "unverifiable" }),
			stderr: "",
			exitCode: 0,
			timedOut: false,
			killed: false,
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
			killed: false,
			truncated: flags.truncatedRead,
			...(flags.cappedRead ? { outputCapped: true } : {}),
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

	// The audit prune joins the name under shotsRoot — an unchecked
	// "../" name deletes files outside it. Every named entry point
	// rides the sweep, so every one must refuse before it runs.
	const traversalOps: Array<[string, (d: Desktops) => Promise<unknown>]> = [
		["allocate", (d) => d.allocate("../outside")],
		["claim", (d) => d.claim("../outside", RUN_A)],
		["release", (d) => d.release("../outside", RUN_A)],
		["handoff", (d) => d.handoff("../outside", RUN_A, RUN_B)],
		["reserve", (d) => d.reserve("../outside", true)],
		["network", (d) => d.setNetwork("../outside", true)],
		["destroy", (d) => d.destroy("../outside", RUN_A)],
		["screenshot", (d) => d.screenshot("../outside")],
		["inspect", (d) => d.inspect("../outside")],
		["act", (d) => d.act("../outside", RUN_A, "x:0", CLICK)],
		["import", (d) => d.cpIn("../outside", "/tmp/seed", "/home/desk/f.bin")],
		["export", (d) => d.catFile("../outside", "/etc/hostname")],
	];
	test.each(traversalOps)(
		"desktop %s refuses a traversal name before the sweep can prune outside shotsRoot",
		async (op, run) => {
			const lines: Record<string, unknown>[] = [];
			setLogFile("capture");
			setLogWriter((_path, line) => {
				lines.push(JSON.parse(line) as Record<string, unknown>);
			});
			try {
				const parent = mkdtempSync(join(tmpdir(), "goblin-desk-trav-"));
				const shotsRoot = join(parent, "shots-root");
				// join(shotsRoot, "../outside", "shots") resolves here —
				// over the 200-file cap, so a swept prune would delete.
				const outside = join(parent, "outside", "shots");
				mkdirSync(outside, { recursive: true });
				for (let i = 0; i < 205; i++) {
					writeFileSync(join(outside, `keep-${String(i).padStart(4, "0")}.png`), PNG);
				}
				const engine = fakeEngine();
				const desktops = makeDesktops({
					podman: engine.podman,
					store: openDesktops(tmpdb()),
					config: () => ({ ...desktopsConfigSchema.parse({}), image: IMAGE }),
					shotsRoot,
					networkName: NETWORK,
				});
				await expect(run(desktops)).rejects.toThrow(/invalid desktop name/);
				// Refusal precedes the sweep: no file removed, no podman
				// call dispatched, and the refusal hit the log with its op.
				expect(readdirSync(outside)).toHaveLength(205);
				expect(engine.calls.length).toBe(0);
				expect(engine.execCalls.length).toBe(0);
				expect(
					lines.some(
						(l) => l.msg === "desktop refused" && l.desktop === "../outside" && l.op === op,
					),
				).toBe(true);
			} finally {
				setLogWriter(null);
				setLogFile(null);
			}
		},
	);

	test("get stays a read-only lookup — a traversal name resolves to no row", async () => {
		const engine = fakeEngine();
		const { desktops } = rig(engine);
		expect(desktops.get("../outside")).toBeNull();
		expect(engine.calls.length).toBe(0);
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

	test("adoption counts a pending allocation against the pool cap", async () => {
		const name = "orphan";
		const engine = fakeEngine({
			containers: [
				{
					name: containerNameForDesktop(name),
					labels: { "goblin.desktop": "1", "goblin.desktop.name": name },
				},
			],
		});
		const { desktops, store } = rig(engine, { max: 1 });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const create = engine.podman.create.bind(engine.podman);
		engine.podman.create = async (spec, conv) => {
			entered.resolve();
			await gate.promise;
			return create(spec, conv);
		};
		const allocating = desktops.allocate("d1");
		try {
			await entered.promise;
			expect(store.list()).toHaveLength(0);
			await expect(desktops.claim(name, RUN_A)).rejects.toThrow(/pool is full/);
			expect(store.get(name)).toBeNull();
		} finally {
			gate.resolve();
			await allocating;
		}
		expect(store.list().map((row) => row.name)).toEqual(["d1"]);
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

	test.each(["lane", "inspect"] as const)(
		"cancelled destroy during %s preserves the desktop",
		async (wait) => {
			const engine = fakeEngine();
			const { desktops, store, name } = await fresh(engine);
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const inspect = engine.podman.inspect.bind(engine.podman);
			engine.podman.inspect = async (...args) => {
				entered.resolve();
				await gate.promise;
				return inspect(...args);
			};
			const controller = new AbortController();
			const first = wait === "lane" ? desktops.screenshot(name) : undefined;
			const pending = desktops.destroy(name, RUN_A, { abortSignal: controller.signal });
			await entered.promise;
			controller.abort();
			gate.resolve();
			await expect(pending).rejects.toThrow();
			await first;
			expect(engine.calls.some((args) => args[0] === "rm")).toBe(false);
			expect(store.get(name)).not.toBeNull();
			expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
		},
	);

	// The abort contract on the mutating ops mirrors the sandbox's: a
	// signal that fired before the call or while it parked — behind the
	// lane or inside the reconcile's preflight read — stops the call
	// before any mutation dispatches.
	test("a pre-aborted network/import call never reaches podman", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		const callsBefore = engine.calls.length;
		await expect(
			desktops.setNetwork(name, true, { abortSignal: AbortSignal.abort() }),
		).rejects.toThrow();
		const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
		writeFileSync(host, "x");
		await expect(
			desktops.cpIn(name, host, "/home/desk/f.bin", { abortSignal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect(engine.calls.length).toBe(callsBefore);
		expect(engine.execCalls.length).toBe(0);
	});

	test.each(["lane", "preflight"] as const)(
		"cancelled setNetwork during %s never connects",
		async (wait) => {
			const engine = fakeEngine();
			const { desktops, store, name } = await fresh(engine);
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const inspect = engine.podman.inspect.bind(engine.podman);
			engine.podman.inspect = async (...args) => {
				entered.resolve();
				await gate.promise;
				return inspect(...args);
			};
			const controller = new AbortController();
			const first = wait === "lane" ? desktops.screenshot(name) : undefined;
			const pending = desktops.setNetwork(name, true, { abortSignal: controller.signal });
			await entered.promise;
			controller.abort();
			gate.resolve();
			await expect(pending).rejects.toThrow();
			await first;
			expect(engine.calls.some((a) => a[0] === "network" && a[1] === "connect")).toBe(false);
			expect(engine.containers.get(containerNameForDesktop(name))!.networks.size).toBe(0);
			expect(store.get(name)!.network).toBe(false);
		},
	);

	test.each(["lane", "preflight"] as const)(
		"cancelled import during %s never copies a file in",
		async (wait) => {
			const engine = fakeEngine();
			const { desktops, name } = await fresh(engine);
			const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
			writeFileSync(host, "x");
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const inspect = engine.podman.inspect.bind(engine.podman);
			engine.podman.inspect = async (...args) => {
				entered.resolve();
				await gate.promise;
				return inspect(...args);
			};
			const controller = new AbortController();
			const first = wait === "lane" ? desktops.screenshot(name) : undefined;
			const pending = desktops.cpIn(name, host, "/home/desk/f.bin", {
				abortSignal: controller.signal,
			});
			await entered.promise;
			controller.abort();
			gate.resolve();
			await expect(pending).rejects.toThrow();
			await first;
			expect(engine.calls.some((a) => a[0] === "cp")).toBe(false);
			expect(engine.execCalls.some((a) => a.includes("mkdir") || a.includes("cp"))).toBe(false);
		},
	);

	test("an import cancelled after staging removes its stage without writing the destination", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		const host = join(mkdtempSync(join(tmpdir(), "goblin-desk-seed-")), "f.bin");
		writeFileSync(host, "x");
		const controller = new AbortController();
		const cp = engine.podman.cp.bind(engine.podman);
		engine.podman.cp = async (...args) => {
			await cp(...args);
			controller.abort();
		};
		await expect(
			desktops.cpIn(name, host, "/home/desk/f.bin", {
				abortSignal: controller.signal,
			}),
		).rejects.toThrow();
		expect(engine.calls.some((a) => a[0] === "cp")).toBe(true);
		expect(engine.execCalls.some((a) => a.includes("cp"))).toBe(false);
		expect(engine.execCalls.some((a) => a.includes("rm"))).toBe(true);
	});

	test("a dispatched network toggle verifies and records intent even if cancellation lands", async () => {
		const engine = fakeEngine();
		const { desktops, store, name } = await fresh(engine);
		const controller = new AbortController();
		const connect = engine.podman.networkConnect.bind(engine.podman);
		engine.podman.networkConnect = async (...args) => {
			await connect(...args);
			controller.abort();
		};
		await desktops.setNetwork(name, true, { abortSignal: controller.signal });
		expect(controller.signal.aborted).toBe(true);
		expect(store.get(name)!.network).toBe(true);
		expect(engine.containers.get(containerNameForDesktop(name))!.networks.size).toBe(1);
		expect(engine.calls.at(-1)?.[0]).toBe("inspect");
	});

	test.each(["stopped", "missing", "adopted"] as const)(
		"the first observation after %s reconciliation can drive input",
		async (state) => {
			const engine = fakeEngine();
			const { desktops, store, name } = await fresh(engine);
			if (state === "missing") engine.containers.delete(containerNameForDesktop(name));
			else engine.containers.get(containerNameForDesktop(name))!.running = false;
			if (state === "adopted") store.delete(name);
			const shot = await desktops.screenshot(name);
			expect(store.get(name)!.bootGen).toBe(
				engine.containers.get(containerNameForDesktop(name))!.startedAt,
			);
			await desktops.claim(name, RUN_A);
			await desktops.act(name, RUN_A, shot.id, CLICK);
		},
	);

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
				startedAt: `boot-seeded-${name}`,
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
		// The reap is detached from the caller — wait it out.
		await waitFor(
			"stale desktop reaped",
			() => !engine.containers.has(containerNameForDesktop("stale")),
		);
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
			startedAt: "boot-seeded-ancient",
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

	test("an out-of-band restart invalidates the frame even though the container reports running", async () => {
		const engine = fakeEngine({ varyFrames: true });
		const { desktops, store, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		// `podman restart goblin-desk-<name>`: fresh boot, still Running
		// — inspect's state alone cannot see it, only StartedAt moved.
		engine.containers.get(containerNameForDesktop(name))!.startedAt = "boot-out-of-band";
		const execBefore = engine.execCalls.length;
		await expect(desktops.act(name, RUN_A, shot.id, CLICK)).rejects.toThrow(/fresh screenshot/);
		// No input was dispatched onto the unseen frame; the dead obs is
		// persisted-invalidated and the lease survives the reconcile.
		expect(engine.execCalls.length).toBe(execBefore);
		const row = store.get(name)!;
		expect(row.lastObsId).toBeNull();
		expect(row.lastObsHash).toBeNull();
		expect(row.bootGen).toBe("boot-out-of-band");
		expect(row.leaseKind).toBe("run");
		// A fresh observation binds and dispatches under the same lease.
		const shot2 = await desktops.screenshot(name);
		expect(shot2.id).not.toBe(shot.id);
		const out = await desktops.act(name, RUN_A, shot2.id, CLICK);
		expect(out.result).toMatchObject({ effect: "unverifiable" });
	});

	test("audit frames are pruned to the newest retention window", async () => {
		const engine = fakeEngine();
		const { desktops, name, shotsRoot } = await fresh(engine);
		const dir = join(shotsRoot, name, "shots");
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			const p = join(dir, `seed-${String(i).padStart(4, "0")}.png`);
			writeFileSync(p, PNG);
			utimesSync(p, 1_000_000, 1_000_000 + i);
		}
		// The call's own sweep prunes before minting: 205 seeds → 200,
		// oldest mtimes first, then the new frame lands.
		await desktops.screenshot(name);
		let files = readdirSync(dir).sort();
		expect(files.length).toBe(201);
		expect(files.some((f) => f.startsWith("seed-0000"))).toBe(false);
		expect(files.some((f) => f.startsWith("seed-0005"))).toBe(true);
		// 201 is over the cap again — the next-oldest seed goes.
		await desktops.screenshot(name);
		files = readdirSync(dir).sort();
		expect(files.length).toBe(201);
		expect(files.some((f) => f.startsWith("seed-0005"))).toBe(false);
		expect(files.some((f) => f.startsWith("seed-0006"))).toBe(true);
		// Destroy freezes what remains (≤ cap after its own sweep's
		// final prune) — it never wipes the dir: the audit exists for
		// the post-mortem, not for space reclamation.
		await desktops.destroy(name, RUN_A);
		expect(readdirSync(dir).length).toBe(200);
	});

	test("the sweep refuses to rm a stale container it does not own by label", async () => {
		const lines: Record<string, unknown>[] = [];
		setLogFile("capture");
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		try {
			const engine = fakeEngine();
			const { desktops, store } = rig(engine, { idleHours: 1 });
			const name = "squat";
			engine.containers.set(containerNameForDesktop(name), {
				image: IMAGE,
				running: true,
				networks: new Set(),
				labels: {},
				startedAt: "boot-seeded-squat",
			});
			const old = Date.now() - 2 * 3_600_000;
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
			// The caller exists and rides its own sweep — squat is what
			// gets listed stale.
			await desktops.allocate("caller");
			await desktops.screenshot("caller");
			// The reap is detached — wait for its verdict on the log,
			// then pin it: the squatter is untouched, the row kept for
			// the retry, exactly like every other removal path.
			await waitFor("the refused reap logged", () =>
				lines.some((l) => l.msg === "desktop reap failed — row kept" && l.desktop === name),
			);
			expect(
				engine.calls.some((c) => c[0] === "rm" && c.at(-1) === containerNameForDesktop(name)),
			).toBe(false);
			expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
			expect(store.get(name)).not.toBeNull();
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
	});

	test("the CUA allowlist is exactly the header's declared input surface", () => {
		expect([...CUA_TOOLS].sort()).toEqual([
			"bring_to_front",
			"click",
			"double_click",
			"drag",
			"hotkey",
			"invoke_menu",
			"press_key",
			"right_click",
			"scroll",
			"set_value",
			"set_window_frame",
			"type_text",
		]);
	});

	test("act refuses a non-member tool without burning the observation", async () => {
		const engine = fakeEngine();
		const { desktops, name } = await fresh(engine);
		await desktops.claim(name, RUN_A);
		const shot = await desktops.screenshot(name);
		// The runtime gate at the dispatch is what enforces the surface
		// — a boundary cast to CuaTool (subagents does one) proves
		// nothing.
		const bypass = {
			kind: "cua" as const,
			tool: "launch_app" as unknown as CuaTool,
			args: { app: "chromium" },
		};
		await expect(desktops.act(name, RUN_A, shot.id, bypass)).rejects.toThrow(
			/not an allowed input operation/,
		);
		expect(engine.execCalls.some((a) => a.includes("launch_app"))).toBe(false);
		// Refusal is validation, not dispatch — the same obs id binds.
		await desktops.act(name, RUN_A, shot.id, CLICK);
	});

	test("acting on one desktop is not blocked by a parked lane on another", async () => {
		const gate = Promise.withResolvers<void>();
		const engine = fakeEngine({ execGate: gate.promise });
		const { desktops, store } = rig(engine, { idleHours: 1 });
		await desktops.allocate("a");
		await desktops.allocate("b");
		await desktops.claim("b", RUN_B);
		const shotB = await desktops.screenshot("b");
		// b looks stale to every listing, but its lease is live and its
		// lane is parked on the gated cua exec.
		const rowB = store.get("b")!;
		rowB.lastUsedAt = Date.now() - 2 * 3_600_000;
		store.put(rowB);
		const actingB = desktops.act("b", RUN_B, shotB.id, CLICK);
		await waitFor("b's act parked at the cua exec", () =>
			engine.execCalls.some((c) => c.includes("cua-driver") && c.includes("click")),
		);
		// Calls on a sweep stale b into the detached reaper, which
		// queues behind b's parked lane — under the old awaited sweep
		// this claim could not complete until the gate resolved.
		await desktops.claim("a", RUN_A);
		const shotA = await desktops.screenshot("a");
		expect(shotA.id).toMatch(/^a:/);
		gate.resolve();
		await actingB;
		// b's reap verdict ran after the park and skipped — live lease.
		await Bun.sleep(50);
		expect(
			engine.calls.some((c) => c[0] === "rm" && c.at(-1) === containerNameForDesktop("b")),
		).toBe(false);
		expect(store.get("b")).not.toBeNull();
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

	test("a claim after container loss returns the recreate note — the row stays clean", async () => {
		const engine = fakeEngine();
		const { desktops, store, name } = await fresh(engine);
		engine.containers.delete(containerNameForDesktop(name));
		const claimed = await desktops.claim(name, RUN_A);
		expect(claimed.note).toContain("previous contents and lease are gone");
		expect(engine.containers.has(containerNameForDesktop(name))).toBe(true);
		// The note is per-claim evidence for the caller, never a row
		// field — the row keeps no trace of it.
		expect((store.get(name) as unknown as Record<string, unknown>).note).toBeUndefined();
	});

	test.each(["truncatedRead", "cappedRead"] as const)(
		"a %s screenshot readback is rejected — no audit file, no observation, no sequence burn",
		async (flag) => {
			const engine = fakeEngine();
			const { desktops, store, name, shotsRoot } = await fresh(engine);
			engine.flags[flag] = true;
			await expect(desktops.screenshot(name)).rejects.toThrow(/capped|truncated/);
			const row = store.get(name)!;
			expect(row.lastObsId).toBeNull();
			expect(row.shotSeq).toBe(0);
			// Nothing reaches the audit dir either — a partial frame
			// isn't just unbindable, it must not exist on disk.
			const shotsDir = join(shotsRoot, name, "shots");
			expect(existsSync(shotsDir) ? readdirSync(shotsDir) : []).toEqual([]);
			// The next healthy read still works — integrity failures
			// don't poison the lane.
			engine.flags[flag] = false;
			const shot = await desktops.screenshot(name);
			expect(shot.id).toMatch(/^d1:1:[0-9a-f-]{36}$/);
		},
	);

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
		// The boot generation rides with it — the reopened owner must
		// not mistake the recorded frame for a different boot's.
		expect(d2.get("a")!.bootGen).not.toBeNull();
		await d2.act("a", RUN_A, shot.id, CLICK);
	});
});
