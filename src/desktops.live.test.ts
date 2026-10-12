// Live desktop drift check: the same wall the sandbox live test pins,
// plus the product path end to end — a real goblin-desktop container
// through desktops.ts: session up, screenshot bytes, cua-driver
// element click verified independently by the window title, and the
// observation-binding refusal. Gated OFF the default suite, run
// deliberately:
//
//     GOBLIN_DESKTOP_LIVE=1 bun test src/desktops.live.test.ts
//
// Store safety: the memory stack shares this rootless store, so the
// check touches only names it created — desktop `goblin-drift-desk`
// (container `goblin-desk-goblin-drift-desk`) on network
// `goblin-drift-desk-net`, a temp sqlite and a temp shots dir — and
// removes exactly those by name. The container DOES carry
// `goblin.desktop=1` (desktops.ts owns that label); adoption keys on
// the exact desktop name, and nothing in prod ever asks for
// "goblin-drift-desk" — unlike sandboxes, where adoption rides the
// conversation key, a drift desktop is unreachable unless called.
// No prune, anywhere, ever (src/podman.ts header).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopsConfigSchema } from "./config.ts";
import { setLogFile } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import { makePodman, type Podman } from "./podman.ts";
import {
	DesktopError,
	containerNameForDesktop,
	makeDesktops,
	openDesktops,
	type Desktops,
} from "./desktops.ts";

const LIVE = process.env.GOBLIN_DESKTOP_LIVE === "1";

const DESKTOP = "goblin-drift-desk";
const CONTAINER = containerNameForDesktop(DESKTOP);
const NETWORK = "goblin-drift-desk-net";
// The config default image; goblin never builds or pulls, so a missing
// image is a red check.
const IMAGE = "localhost/goblin-desktop:1";
// CHOWN(0) | DAC_OVERRIDE(1) | FOWNER(3) | SETGID(6) | SETUID(7)
// | SYS_CHROOT(18) — desktops carry the extra cap for Chromium's
// own sandbox (operator-approved, desktops only).
const WALL_CAPS = 0x400cb;
// Evidence preserved outside the temp dir the run cleans up.
const EVIDENCE_DIR = "/tmp/goblin-desktop-evidence";

const PROBE_HTML = `<!doctype html><html><body>
<input id="in" autofocus oninput="document.title='typed:'+this.value">
<button id="btn" style="width:400px;height:200px" onclick="document.title='clicked'">CLICK</button>
</body></html>`;

let podman: Podman | null = null;
let desktops: Desktops | null = null;
let cwd = "";
// Only names whose create call succeeded enter these sets — cleanup
// removes exactly them; a refused preflight touches nothing.
const createdContainers = new Set<string>();
const createdNetworks = new Set<string>();

async function probeExists(name: string): Promise<boolean> {
	const r = await boundedRun(spawnProc(["podman", "inspect", name]), {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
	});
	return r.exitCode === 0;
}

async function netExists(name: string): Promise<boolean> {
	const r = await boundedRun(spawnProc(["podman", "network", "inspect", name]), {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
	});
	return r.exitCode === 0;
}

async function execOut(argv: string[], env?: Record<string, string>): Promise<string> {
	const r = await podman!.exec(CONTAINER, argv, {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
		workdir: "/run/desk",
		...(env === undefined ? {} : { env }),
	});
	if (r.exitCode !== 0) {
		throw new Error(`exec ${JSON.stringify(argv)} exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
	}
	return r.stdout;
}

function statusField(status: string, field: string): string {
	const m = status.match(new RegExp(`${field}:\\s*(\\S+)`));
	if (m === null) throw new Error(`/proc/self/status has no ${field} — kernel or runtime moved`);
	return m[1]!;
}

// A cua-driver call as the session user, straight through the adapter —
// the same argv desktops.ts builds.
async function cua(tool: string, args: Record<string, unknown>): Promise<unknown> {
	const r = await podman!.exec(
		CONTAINER,
		["cua-driver", "call", tool, JSON.stringify({ ...args, session: DESKTOP }), "--socket", "/run/desk/cua.sock"],
		{
			timeoutMs: 30_000,
			maxOutput: 4 * 1024 * 1024,
			user: "desk",
			env: { HOME: "/home/desk", DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/desk/bus" },
			workdir: "/run/desk",
		},
	);
	if (r.exitCode !== 0) {
		throw new Error(`cua ${tool} exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
	}
	return JSON.parse(r.stdout);
}

interface CuaElement {
	element_index: number;
	role: string;
	label?: string;
	element_token?: string;
	in_web_content?: boolean;
}
interface CuaWindowState {
	elements?: CuaElement[];
	tree_markdown?: string;
	pid?: number;
	window_id?: number;
}

describe.skipIf(!LIVE)("desktop live drift (GOBLIN_DESKTOP_LIVE=1)", () => {
	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "goblin-desktop-drift-"));
		setLogFile(join(cwd, "drift.log"));
		writeFileSync(join(cwd, "probe.html"), PROBE_HTML);
		const base = makePodman();
		podman = {
			...base,
			create: async (spec, conv) => {
				await base.create(spec, conv);
				createdContainers.add(spec.name);
			},
			networkEnsure: async (name, conv) => {
				await base.networkEnsure(name, conv);
				createdNetworks.add(name);
			},
		};
		// Preflight BEFORE creating anything: a name that exists is not
		// ours — refuse and let afterAll remove zero shared objects.
		if ((await probeExists(CONTAINER)) || (await netExists(NETWORK))) {
			throw new Error(
				`drift resource already exists (container ${CONTAINER} or network ${NETWORK}) — refusing`,
			);
		}
		desktops = makeDesktops({
			podman,
			store: openDesktops(join(cwd, "goblin.sqlite")),
			config: () => ({ ...desktopsConfigSchema.parse({}), image: IMAGE }),
			shotsRoot: join(cwd, "shots"),
			networkName: NETWORK,
		});
		const out = await desktops.allocate(DESKTOP);
		expect(out.note).toContain("network off");
	}, 120_000);

	test("the wall holds inside the desktop: uid/gid map, five caps, no-new-privileges", async () => {
		const uidMap = (await execOut(["cat", "/proc/self/uid_map"])).trim().split(/\s+/);
		expect(uidMap).toEqual(["0", "40000", "8192"]);
		const gidMap = (await execOut(["cat", "/proc/self/gid_map"])).trim().split(/\s+/);
		expect(gidMap).toEqual(["0", "40000", "8192"]);
		const status = await execOut(["cat", "/proc/self/status"]);
		expect(parseInt(statusField(status, "CapEff"), 16)).toBe(WALL_CAPS);
		expect(parseInt(statusField(status, "CapBnd"), 16)).toBe(WALL_CAPS);
		expect(statusField(status, "NoNewPrivs")).toBe("1");
		const c = await podman!.inspect(CONTAINER);
		expect(c.labels["goblin.desktop"]).toBe("1");
		expect(c.networks).toEqual([]);
	}, 60_000);

	test("the session is up: Xvfb answers xdpyinfo, the cua socket answers", async () => {
		// allocate returns after create; the session boots async — poll.
		let info = "";
		for (let i = 0; i < 40; i++) {
			try {
				info = await execOut(["xdpyinfo", "-display", ":99"], { DISPLAY: ":99" });
				break;
			} catch {
				await Bun.sleep(500);
			}
		}
		expect(info).toContain("name of display:    :99");
		// cua-driver is the last thing the session starts — poll it too.
		let windows: { windows?: unknown[] } = {};
		for (let i = 0; i < 40; i++) {
			try {
				windows = (await cua("list_windows", {})) as { windows?: unknown[] };
				break;
			} catch {
				await Bun.sleep(500);
			}
		}
		expect(Array.isArray(windows.windows)).toBe(true);
	}, 60_000);

	test("screenshot returns PNG bytes and audits the frame to disk", async () => {
		const shot = await desktops!.screenshot(DESKTOP);
		expect(shot.id).toBe(`${DESKTOP}:1`);
		expect([...shot.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(await Bun.file(shot.path).exists()).toBe(true);
	}, 60_000);

	test("end to end: claim → launch → inspect → element click → title → stale refusal", async () => {
		const op = { kind: "operator" } as const;
		await desktops!.claim(DESKTOP, op);
		await podman!.cp(CONTAINER, join(cwd, "probe.html"), "/tmp/probe.html");
		const launch = await desktops!.act(DESKTOP, op, `${DESKTOP}:1`, {
			kind: "launch",
			app: "chromium",
			url: "file:///tmp/probe.html",
		});
		expect(launch.result).toEqual({ launched: "chromium" });
		// Chromium publishes its AT-SPI tree asynchronously — poll
		// inspect until the page's button appears (each inspect mints a
		// fresh observation; only the last one's id is bound).
		let ins: { id: string; state: unknown } | null = null;
		let button: CuaElement | undefined;
		for (let i = 0; i < 30; i++) {
			ins = await desktops!.inspect(DESKTOP);
			button = ((ins.state as CuaWindowState).elements ?? []).find(
				(e) => e.role === "button" && /click/i.test(e.label ?? ""),
			);
			if (button?.element_token !== undefined) break;
			await Bun.sleep(1000);
		}
		expect(ins).not.toBeNull();
		expect(button?.element_token).toBeDefined();
		const wins = (await cua("list_windows", {})) as {
			windows?: Array<{ pid: number; app_name: string }>;
		};
		const chromiumPid = (wins.windows ?? []).find((w) => /chromium/i.test(w.app_name))?.pid;
		expect(chromiumPid).toBeDefined();
		const clicked = await desktops!.act(DESKTOP, op, ins!.id, {
			kind: "cua",
			tool: "click",
			args: { element_token: button!.element_token, pid: chromiumPid },
		});
		// The driver's honesty rides back verbatim.
		expect(JSON.stringify(clicked.result)).toContain('"effect"');
		// Independent verification: the window title, not the driver.
		await Bun.sleep(1500);
		const titles = await execOut(
			["xdotool", "search", "--name", "clicked", "getwindowname", "%@"],
			{ DISPLAY: ":99" },
		);
		expect(titles.trim()).toContain("clicked");
		// The consumed observation cannot act again.
		await expect(
			desktops!.act(DESKTOP, op, ins!.id, {
				kind: "cua",
				tool: "click",
				args: { element_token: button!.element_token },
			}),
		).rejects.toBeInstanceOf(DesktopError);

		// Typing, the same way: click the input to focus, then
		// type_text — each act bound to a fresh observation.
		const focusObs = await desktops!.inspect(DESKTOP);
		const input = ((focusObs.state as CuaWindowState).elements ?? []).find(
			(e) => e.role === "entry" && e.in_web_content === true,
		);
		expect(input?.element_token).toBeDefined();
		await desktops!.act(DESKTOP, op, focusObs.id, {
			kind: "cua",
			tool: "click",
			args: { element_token: input!.element_token, pid: chromiumPid },
		});
		// Each inspect supersedes the previous element tokens — the
		// type target has to come from the same observation it binds.
		const typeObs = await desktops!.inspect(DESKTOP);
		const input2 = ((typeObs.state as CuaWindowState).elements ?? []).find(
			(e) => e.role === "entry" && e.in_web_content === true,
		);
		expect(input2?.element_token).toBeDefined();
		await desktops!.act(DESKTOP, op, typeObs.id, {
			kind: "cua",
			tool: "type_text",
			args: {
				pid: chromiumPid,
				element_token: input2!.element_token,
				text: "hello goblin",
			},
		});
		await Bun.sleep(1500);
		const typed = await execOut(
			["xdotool", "search", "--name", "typed:hello goblin", "getwindowname", "%@"],
			{ DISPLAY: ":99" },
		);
		expect(typed.trim()).toContain("typed:hello goblin");
	}, 120_000);

	test("Chromium's own sandbox is up — chrome://sandbox and the process argv", async () => {
		const op = { kind: "operator" } as const;
		await desktops!.claim(DESKTOP, op);
		// No --no-sandbox anywhere in the browser's argv — checked on
		// the running processes, not the launch call.
		const procs = await execOut(["pgrep", "-af", "chromium"], {
			DISPLAY: ":99",
		});
		expect(procs).toContain("chromium");
		expect(procs).not.toContain("--no-sandbox");
		// Navigate to chrome://sandbox with real input: ctrl+l focuses
		// the omnibox, type the URL, press enter — each act bound to
		// its own fresh observation.
		const wins = (await cua("list_windows", {})) as {
			windows?: Array<{ pid: number; app_name: string }>;
		};
		const pid = (wins.windows ?? []).find((w) => /chromium/i.test(w.app_name))?.pid;
		expect(pid).toBeDefined();
		const o1 = await desktops!.inspect(DESKTOP);
		await desktops!.act(DESKTOP, op, o1.id, {
			kind: "cua",
			tool: "hotkey",
			args: { pid, keys: ["ctrl", "l"] },
		});
		const o2 = await desktops!.inspect(DESKTOP);
		await desktops!.act(DESKTOP, op, o2.id, {
			kind: "cua",
			tool: "type_text",
			args: { pid, text: "chrome://sandbox" },
		});
		const o3 = await desktops!.inspect(DESKTOP);
		await desktops!.act(DESKTOP, op, o3.id, {
			kind: "cua",
			tool: "press_key",
			args: { pid, key: "enter" },
		});
		// The sandbox page renders as AT-SPI text — read the status
		// back from the page itself, plus a screenshot for evidence.
		await Bun.sleep(3000);
		const page = await desktops!.inspect(DESKTOP);
		// Assert the page's own verdicts, not just that the labels
		// rendered: each checked row's value cell must read "Yes".
		const cells = (
			(page.state as { elements?: Array<{ role?: string; label?: string }> })
				.elements ?? []
		).filter((e) => e.role === "table cell");
		const verdict = (label: string) => {
			const i = cells.findIndex((e) => e.label === label);
			return i === -1 ? undefined : cells[i + 1]?.label;
		};
		for (const label of [
			"PID namespaces",
			"Network namespaces",
			"Seccomp-BPF sandbox",
			"Seccomp-BPF sandbox supports TSYNC",
		]) {
			expect(verdict(label)).toBe("Yes");
		}
		expect(JSON.stringify(page.state)).toContain("You are adequately sandboxed.");
		const shot = await desktops!.screenshot(DESKTOP);
		mkdirSync(EVIDENCE_DIR, { recursive: true });
		await Bun.write(join(EVIDENCE_DIR, "chrome-sandbox.png"), shot.bytes);
		await Bun.write(
			join(EVIDENCE_DIR, "chrome-sandbox-state.json"),
			JSON.stringify(page.state, null, 2),
		);
	}, 120_000);

	test("import lands desk-owned and readable; export round-trips bytes", async () => {
		// A real seeded host file through cpIn — the podman-cp boundary
		// that used to leave root-owned imports desk can't read.
		const seed = join(cwd, "seed.bin");
		const payload = new Uint8Array([0, 1, 2, 0xff, 65, 66, 10]);
		await Bun.write(seed, payload);
		const dest = `/home/desk/inbox/subagents/7/${crypto.randomUUID().slice(0, 8)}-seed.bin`;
		await desktops!.cpIn(DESKTOP, seed, dest);
		// Desk itself reads it, and the leaf is chowned to uid 1000.
		const stat = await podman!.exec(
			CONTAINER,
			["stat", "-c", "%u:%g:%s", "--", dest],
			{ timeoutMs: 30_000, maxOutput: 1 << 20, user: "desk", workdir: "/run/desk" },
		);
		if (stat.exitCode !== 0) {
			throw new Error(`desk stat exit ${stat.exitCode}: ${stat.stderr.slice(0, 200)}`);
		}
		expect(stat.stdout.trim()).toBe(`1000:1000:${payload.length}`);
		const back = await desktops!.catFile(DESKTOP, dest);
		expect([...back.data]).toEqual([...payload]);
		// Non-regular leaves stay refused.
		await expect(desktops!.catFile(DESKTOP, "/home/desk")).rejects.toThrow();
	}, 60_000);

	afterAll(async () => {
		setLogFile(null);
		const failures: string[] = [];
		if (podman !== null && createdContainers.has(CONTAINER)) {
			try {
				await podman.rm(CONTAINER);
			} catch (err) {
				failures.push(`container rm: ${String(err).slice(0, 200)}`);
			}
		}
		// The adapter exposes no network rm (product networks live
		// forever); a drift network THIS run created dies through the
		// raw CLI — anything else is left alone.
		for (const net of createdNetworks) {
			const r = await boundedRun(spawnProc(["podman", "network", "rm", net]), {
				timeoutMs: 30_000,
				maxOutput: 1 << 20,
			});
			if (r.exitCode !== 0 && !/does not exist|not found/i.test(r.stderr)) {
				failures.push(`network rm ${net} exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`);
			}
		}
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`desktop drift teardown failed: ${failures.join("; ")}`);
		}
	}, 60_000);
});
