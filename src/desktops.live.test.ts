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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// CHOWN(0) | DAC_OVERRIDE(1) | FOWNER(3) | SETGID(6) | SETUID(7).
const WALL_CAPS = 0xcb;

const PROBE_HTML = `<!doctype html><html><body>
<input id="in" autofocus oninput="document.title='typed:'+this.value">
<button id="btn" style="width:400px;height:200px" onclick="document.title='clicked'">CLICK</button>
</body></html>`;

let podman: Podman | null = null;
let desktops: Desktops | null = null;
let cwd = "";
let cameUp = false;

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
		podman = makePodman();
		desktops = makeDesktops({
			podman,
			store: openDesktops(join(cwd, "goblin.sqlite")),
			config: () => ({ ...desktopsConfigSchema.parse({}), image: IMAGE }),
			shotsRoot: join(cwd, "shots"),
			networkName: NETWORK,
		});
		const out = await desktops.allocate(DESKTOP);
		cameUp = true;
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

	afterAll(async () => {
		setLogFile(null);
		const failures: string[] = [];
		if (podman !== null && cameUp) {
			try {
				await podman.rm(CONTAINER);
			} catch (err) {
				failures.push(`container rm: ${String(err).slice(0, 200)}`);
			}
		}
		// The adapter exposes no network rm (product networks live
		// forever); the drift network dies through the raw CLI.
		const r = await boundedRun(spawnProc(["podman", "network", "rm", NETWORK]), {
			timeoutMs: 30_000,
			maxOutput: 1 << 20,
		});
		if (r.exitCode !== 0 && !/does not exist|not found/i.test(r.stderr)) {
			failures.push(`network rm exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`);
		}
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`desktop drift teardown failed: ${failures.join("; ")}`);
		}
	}, 60_000);
});
