// Live wall drift check: reads the sandbox wall back from inside a
// real container (/proc) and around it (inspect) — a podman upgrade
// that changes how any of these properties land goes red here.
//     GOBLIN_PODMAN_LIVE=1 bun test src/podman.live.test.ts
// The memory stack shares this rootless store — touch only names this
// file creates: `goblin-drift-wall` container+network labelled
// `goblin.drift=wall` (deliberately NOT `goblin.sandbox=1`, which the
// running service adopts). No prune, anywhere, ever.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogFile } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import { makePodman, type Podman } from "./podman.ts";

const LIVE = process.env.GOBLIN_PODMAN_LIVE === "1";

const NETWORK = "goblin-drift-wall";
const CONTAINER = "goblin-drift-wall";
// The config default image; goblin never pulls — a missing image is a
// red check, not a pull.
const IMAGE = "docker.io/library/alpine:latest";
// CHOWN(0) | DAC_OVERRIDE(1) | FOWNER(3) | SETGID(6) | SETUID(7).
const WALL_CAPS = 0xcb;

let podman: Podman | null = null;
let cwd = "";
let networkUp = false;
let cameUp = false;

async function execOut(argv: string[]): Promise<string> {
	const r = await podman!.exec(CONTAINER, argv, { timeoutMs: 30_000, maxOutput: 1 << 20 });
	if (r.exitCode !== 0) {
		throw new Error(`exec ${JSON.stringify(argv)} exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
	}
	return r.stdout;
}

async function rawInspect(template: string): Promise<string> {
	const r = await boundedRun(spawnProc(["podman", "inspect", "--format", template, CONTAINER]), {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
	});
	if (r.exitCode !== 0) {
		throw new Error(`inspect ${template} exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
	}
	return r.stdout.trim();
}

function statusField(status: string, field: string): string {
	const m = status.match(new RegExp(`${field}:\\s*(\\S+)`));
	if (m === null) throw new Error(`/proc/self/status has no ${field} — kernel or runtime moved`);
	return m[1]!;
}

describe.skipIf(!LIVE)("podman live wall drift (GOBLIN_PODMAN_LIVE=1)", () => {
	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "goblin-podman-drift-"));
		setLogFile(join(cwd, "drift.log"));
		podman = makePodman();
		// Live pin of strict-isolate enforcement: an existing network
		// without options.isolate=strict throws here.
		await podman.networkEnsure(NETWORK);
		networkUp = true;
	}, 60_000);

	test("create through the adapter: running, on its network, labelled ours", async () => {
		expect(await podman!.imageExists(IMAGE)).toBe(true);
		await podman!.create({
			name: CONTAINER,
			image: IMAGE,
			network: NETWORK,
			memory: "512m",
			cpus: 1,
			pids: 128,
			labels: { "goblin.drift": "wall" },
		});
		cameUp = true;
		const c = await podman!.inspect(CONTAINER);
		expect(c.state).toBe("running");
		expect(c.image).toBe(IMAGE);
		expect(c.networks).toEqual([NETWORK]);
		expect(c.labels["goblin.drift"]).toBe("wall");
	}, 60_000);

	test("network off is a real disconnect (the sandbox default state)", async () => {
		await podman!.networkDisconnect(NETWORK, CONTAINER);
		const c = await podman!.inspect(CONTAINER);
		expect(c.networks).toEqual([]);
	}, 60_000);

	test("identity wall: container root maps 0→40000, size 8192", async () => {
		// The kernel's in-container view — the strong form of the
		// uidmap pin; inspect-side maps would restate the argv.
		const uidMap = (await execOut(["cat", "/proc/self/uid_map"])).trim().split(/\s+/);
		expect(uidMap).toEqual(["0", "40000", "8192"]);
		const gidMap = (await execOut(["cat", "/proc/self/gid_map"])).trim().split(/\s+/);
		expect(gidMap).toEqual(["0", "40000", "8192"]);
		expect((await execOut(["id", "-u"])).trim()).toBe("0");
	}, 60_000);

	test("capability wall: exactly the five added caps, and no-new-privileges", async () => {
		const status = await execOut(["cat", "/proc/self/status"]);
		expect(parseInt(statusField(status, "CapEff"), 16)).toBe(WALL_CAPS);
		expect(parseInt(statusField(status, "CapBnd"), 16)).toBe(WALL_CAPS);
		expect(statusField(status, "NoNewPrivs")).toBe("1");
	}, 60_000);

	test("filesystem wall: no mounts, nothing shared", async () => {
		expect(await rawInspect("{{json .Mounts}}")).toBe("[]");
	}, 60_000);

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
		// forever) — the drift network dies through the raw CLI.
		if (networkUp) {
			const r = await boundedRun(spawnProc(["podman", "network", "rm", NETWORK]), {
				timeoutMs: 30_000,
				maxOutput: 1 << 20,
			});
			if (r.exitCode !== 0) {
				failures.push(`network rm exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`);
			}
		}
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`podman drift teardown failed: ${failures.join("; ")}`);
		}
	}, 60_000);
});
