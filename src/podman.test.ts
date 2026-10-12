// The podman adapter's argv contract: wall flags are load-bearing and
// must survive every spec variant, byte for byte. Fakes sit at the
// runner seam — no real podman runs here.

import { describe, expect, test } from "bun:test";
import { makePodman } from "./podman.ts";

const WALL_FLAGS = [
	"--pull=never",
	"--uidmap",
	"0:40000:8192",
	"--gidmap",
	"0:40000:8192",
	"--cap-drop",
	"ALL",
	"--cap-add",
	"CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID",
	"--security-opt",
	"no-new-privileges",
	"--init",
];

function rig() {
	const calls: string[][] = [];
	const podman = makePodman({
		runner: async (args) => {
			calls.push([...args]);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	return { calls, podman };
}

describe("podman adapter argv", () => {
	test("a custom command/hostname/shmSize keeps every wall flag", async () => {
		const { calls, podman } = rig();
		await podman.create({
			name: "goblin-desk-a",
			image: "localhost/goblin-desktop:1",
			network: "goblin-desktop",
			memory: "3g",
			cpus: 2,
			pids: 1024,
			command: ["/usr/local/bin/goblin-desktop-session"],
			hostname: "desktop",
			shmSize: "1g",
			labels: { "goblin.desktop": "1", "goblin.desktop.name": "a" },
		});
		const args = calls[0]!;
		for (const flag of WALL_FLAGS) expect(args).toContain(flag);
		for (const flag of ["--shm-size", "1g", "--hostname", "desktop"]) {
			expect(args).toContain(flag);
		}
		expect(args).toContain("--label");
		expect(args).toContain("goblin.desktop=1");
		expect(args).toContain("goblin.desktop.name=a");
		// The custom command replaces the sandbox sleep verbatim.
		expect(args.at(-2)).toBe("localhost/goblin-desktop:1");
		expect(args.at(-1)).toBe("/usr/local/bin/goblin-desktop-session");
	});

	test("extraCaps appends to the five-cap allowlist; defaults stay the five", async () => {
		const { calls, podman } = rig();
		await podman.create({
			name: "goblin-desk-a",
			image: "localhost/goblin-desktop:1",
			network: "goblin-desktop",
			memory: "3g",
			cpus: 2,
			pids: 1024,
			command: ["/usr/local/bin/goblin-desktop-session"],
			hostname: "desktop",
			shmSize: "1g",
			extraCaps: ["SYS_CHROOT"],
			labels: { "goblin.desktop": "1", "goblin.desktop.name": "a" },
		});
		const args = calls[0]!;
		expect(args).toEqual(
			expect.arrayContaining([
				"--cap-add",
				"CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID,SYS_CHROOT",
			]),
		);
		// The default spec keeps the exact five — nothing inferred.
		await podman.create({
			name: "goblin-sbx-x",
			image: "docker.io/library/alpine:latest",
			network: "goblin-sandbox",
			memory: "2g",
			cpus: 2,
			pids: 512,
			labels: { "goblin.sandbox": "1" },
		});
		expect(calls[1]).toEqual(
			expect.arrayContaining([
				"--cap-add",
				"CHOWN,DAC_OVERRIDE,FOWNER,SETUID,SETGID",
			]),
		);
	});

	test("a non-cap-name in extraCaps throws before any podman call", async () => {
		const { calls, podman } = rig();
		await expect(
			podman.create({
				name: "goblin-desk-a",
				image: "localhost/goblin-desktop:1",
				network: "goblin-desktop",
				memory: "3g",
				cpus: 2,
				pids: 1024,
				extraCaps: ["-rf /", "sys_chroot"],
				labels: {},
			}),
		).rejects.toThrow(/invalid extra capability/);
		expect(calls.length).toBe(0);
	});

	test("a default spec still ends in the sandbox sleep and hostname", async () => {
		const { calls, podman } = rig();
		await podman.create({
			name: "goblin-sbx-x",
			image: "docker.io/library/alpine:latest",
			network: "goblin-sandbox",
			memory: "2g",
			cpus: 2,
			pids: 512,
			labels: { "goblin.sandbox": "1" },
		});
		const args = calls[0]!;
		for (const flag of WALL_FLAGS) expect(args).toContain(flag);
		expect(args).not.toContain("--shm-size");
		expect(args).toEqual(
			expect.arrayContaining(["--hostname", "sandbox"]),
		);
		expect(args.slice(-4)).toEqual([
			"docker.io/library/alpine:latest",
			"/bin/sh",
			"-c",
			"mkdir -p /work && exec sleep infinity",
		]);
	});

	test("exec carries user/env/workdir overrides", async () => {
		const execCalls: string[][] = [];
		const podman = makePodman({
			execRunner: async (args) => {
				execCalls.push([...args]);
				return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
			},
		});
		await podman.exec("c", ["true"], {
			timeoutMs: 1000,
			maxOutput: 1024,
			user: "desk",
			env: { DISPLAY: ":99", HOME: "/home/desk" },
			workdir: "/run/desk",
		});
		expect(execCalls[0]).toEqual([
			"exec",
			"-w",
			"/run/desk",
			"-u",
			"desk",
			"-e",
			"DISPLAY=:99",
			"-e",
			"HOME=/home/desk",
			"c",
			"true",
		]);
	});
});

describe("networkEnsure convergence", () => {
	const STRICT = JSON.stringify([{ options: { isolate: "strict" } }]);

	// inspect → create → re-inspect: a losing create is only a real
	// failure when the re-inspect still finds nothing usable.
	function raceRig(opts: {
		secondInspect: { code: number; stdout: string; stderr: string };
	}) {
		const calls: string[][] = [];
		let inspections = 0;
		const podman = makePodman({
			runner: async (args) => {
				calls.push([...args]);
				if (args[0] === "network" && args[1] === "inspect") {
					inspections++;
					return inspections === 1
						? { code: 1, stdout: "", stderr: "not found" }
						: opts.secondInspect;
				}
				if (args[0] === "network" && args[1] === "create") {
					return { code: 1, stdout: "", stderr: "network already exists" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		return { calls, podman, inspections: () => inspections };
	}

	test("a losing create accepts the winner's identical network", async () => {
		const r = raceRig({
			secondInspect: { code: 0, stdout: STRICT, stderr: "" },
		});
		await r.podman.networkEnsure("goblin-sandbox", "c1");
		expect(r.inspections()).toBe(2);
	});

	test("a real create failure still throws when nothing usable appeared", async () => {
		const r = raceRig({
			secondInspect: { code: 1, stdout: "", stderr: "not found" },
		});
		await expect(r.podman.networkEnsure("goblin-sandbox", "c1")).rejects.toThrow(
			/network create/,
		);
	});

	test("a network that appeared without isolate=strict is refused", async () => {
		const r = raceRig({
			secondInspect: {
				code: 0,
				stdout: JSON.stringify([{ options: { isolate: "none" } }]),
				stderr: "",
			},
		});
		await expect(r.podman.networkEnsure("goblin-sandbox", "c1")).rejects.toThrow(
			/isolate=strict/,
		);
	});
});
