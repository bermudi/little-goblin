// The only module that knows podman (design/sandbox.md — the herdr.ts
// rule): a thin adapter over the CLI. Fakes sit at the argv seam —
// tests never spawn the real podman. Every invocation logs op,
// container, conversation, exit code and ms, so a sandbox symptom plus
// goblin.log reconstructs exactly what the engine was told. No prune
// anywhere: lifecycle ops address an exact name or filter on the
// goblin.sandbox or goblin.desktop label — the memory stack shares
// this container store.
//
// Two argv seams: `runner` for lifecycle ops (fixed budget, text out),
// and exec runners for in-container commands (per-call deadline, abort
// and output caps via boundedRun/boundedRunBinary — a timed-out exec is
// group-killed, which does NOT kill the in-container process; callers
// restart the container, see sandboxes.ts).

import { z } from "zod";
import { log } from "./log.ts";
import {
	boundedRun,
	boundedRunBinary,
	spawnProc,
	type BoundedProc,
	type BoundedProcBytes,
} from "./proc.ts";

export interface PodmanRunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type PodmanRunner = (args: string[]) => Promise<PodmanRunResult>;

export interface PodmanExecOpts {
	timeoutMs: number;
	maxOutput: number;
	abortSignal?: AbortSignal;
	/** exec -u: desktop containers keep a non-root session user. */
	user?: string;
	/** exec -e pairs: the session's DISPLAY/bus env for desk processes. */
	env?: Record<string, string>;
	/** exec -w: defaults to the sandbox workdir below. */
	workdir?: string;
}
export type PodmanExecRunner = (args: string[], opts: PodmanExecOpts) => Promise<BoundedProc>;
export type PodmanExecBytesRunner = (
	args: string[],
	opts: PodmanExecOpts,
) => Promise<BoundedProcBytes>;

// Lifecycle calls are local-socket round trips; the budget sits well
// above them and below nothing that matters.
const PODMAN_TIMEOUT_MS = 60_000;
const PODMAN_MAX_OUTPUT = 1 << 20;

const defaultRunner: PodmanRunner = async (args) => {
	const proc = spawnProc(["podman", ...args]);
	const r = await boundedRun(proc, {
		timeoutMs: PODMAN_TIMEOUT_MS,
		maxOutput: PODMAN_MAX_OUTPUT,
	});
	return {
		code: r.exitCode ?? -1,
		stdout: r.stdout,
		stderr: r.timedOut ? `podman timed out after ${PODMAN_TIMEOUT_MS}ms` : r.stderr,
	};
};

const defaultExecRunner: PodmanExecRunner = (args, opts) =>
	boundedRun(spawnProc(["podman", ...args]), opts);

const defaultExecBytesRunner: PodmanExecBytesRunner = (args, opts) =>
	boundedRunBinary(spawnProc(["podman", ...args]), opts);

export class PodmanError extends Error {
	constructor(
		readonly op: string,
		readonly code: number,
		message: string,
	) {
		super(`podman ${op} failed (exit ${code}): ${message}`);
		this.name = "PodmanError";
	}
}

// The sandbox's PID-1 command under --init. `--workdir /work` is not on
// the create argv: podman run refuses a workdir that doesn't exist in
// the image (measured — `workdir "/work" does not exist`), so the init
// command creates it and exec pins `-w`. `sleep infinity` is busybox-
// and coreutils-safe (verified on alpine).
export const SANDBOX_INIT_COMMAND = ["/bin/sh", "-c", "mkdir -p /work && exec sleep infinity"];
export const SANDBOX_WORKDIR = "/work";

export interface CreateSpec {
	name: string;
	image: string;
	network: string;
	memory: string;
	cpus: number;
	pids: number;
	labels: Record<string, string>;
	/** PID 1 command — the sandbox's idle sleep when omitted. */
	command?: string[];
	hostname?: string;
	shmSize?: string;
}

export interface ContainerInspect {
	state: "running" | "stopped" | "missing";
	/** The image ref the container was created from ("" when missing). */
	image: string;
	/** Attached network names ([] when missing or disconnected). */
	networks: string[];
	labels: Record<string, string>;
}

// podman inspect: an array of container objects (or [] on a miss). Only
// the leaves the lifecycle reconciles against are load-bearing.
const inspectSchema = z.array(
	z
		.object({
			Config: z
				.object({
					Image: z.string(),
					Labels: z.record(z.string(), z.string()).nullable().optional(),
				})
				.passthrough(),
			State: z.object({ Status: z.string(), Running: z.boolean() }).passthrough(),
			NetworkSettings: z
				.object({ Networks: z.record(z.string(), z.unknown()).nullable().optional() })
				.passthrough(),
		})
		.passthrough(),
);

// network inspect: an array; options.isolate is the opt we create with
// and the property the existing-network check enforces.
const networkInspectSchema = z.array(
	z.object({ options: z.record(z.string(), z.string()).optional() }).passthrough(),
);

export interface Podman {
	/** Exists → verify isolate=strict (fail loud otherwise); missing →
	 *  create it with isolate=strict. */
	networkEnsure(name: string, conv?: string): Promise<void>;
	create(spec: CreateSpec, conv?: string): Promise<void>;
	inspect(name: string, conv?: string): Promise<ContainerInspect>;
	start(name: string, conv?: string): Promise<void>;
	/** -t 0: no grace — a restart here is for a dead-but-running exec. */
	restart(name: string, conv?: string): Promise<void>;
	/** -f -t 0 — idempotent (missing containers exit 0). */
	rm(name: string, conv?: string): Promise<void>;
	exec(name: string, argv: string[], opts: PodmanExecOpts, conv?: string): Promise<BoundedProc>;
	execBytes(
		name: string,
		argv: string[],
		opts: PodmanExecOpts,
		conv?: string,
	): Promise<BoundedProcBytes>;
	cp(name: string, hostPath: string, containerPath: string, conv?: string): Promise<void>;
	networkConnect(network: string, name: string, conv?: string): Promise<void>;
	networkDisconnect(network: string, name: string, conv?: string): Promise<void>;
	imageExists(ref: string, conv?: string): Promise<boolean>;
	/** Names of containers carrying the label (all states). */
	listByLabel(label: string, conv?: string): Promise<string[]>;
}

export function makePodman(deps?: {
	runner?: PodmanRunner;
	execRunner?: PodmanExecRunner;
	execBytesRunner?: PodmanExecBytesRunner;
}): Podman {
	const runner = deps?.runner ?? defaultRunner;
	const execRunner = deps?.execRunner ?? defaultExecRunner;
	const execBytesRunner = deps?.execBytesRunner ?? defaultExecBytesRunner;

	// The one lifecycle call site: log the invocation's outcome, then let
	// the op interpret the exit code (missing-vs-error is per-op).
	async function call(
		op: string,
		args: string[],
		fields: { container?: string | undefined; conversation?: string | undefined },
	): Promise<PodmanRunResult> {
		const t0 = Date.now();
		const r = await runner(args);
		log.info("podman call", {
			op,
			...fields,
			status: r.code,
			ms: Date.now() - t0,
		});
		return r;
	}

	function fail(op: string, r: PodmanRunResult): PodmanError {
		const detail = (r.stderr || r.stdout).replace(/\s+/g, " ").trim().slice(0, 300);
		return new PodmanError(op, r.code, detail === "" ? "no output" : detail);
	}

	// exec -w/-u/-e share one argv shape between exec and execBytes.
	function execArgs(name: string, argv: string[], opts: PodmanExecOpts): string[] {
		return [
			"exec",
			"-w",
			opts.workdir ?? SANDBOX_WORKDIR,
			...(opts.user === undefined ? [] : ["-u", opts.user]),
			...(opts.env === undefined
				? []
				: Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])),
			name,
			...argv,
		];
	}

	return {
		async networkEnsure(name, conv) {
			const r = await call("network inspect", ["network", "inspect", name], {
				conversation: conv,
			});
			if (r.code === 0) {
				let parsed: z.infer<typeof networkInspectSchema>;
				try {
					parsed = networkInspectSchema.parse(JSON.parse(r.stdout));
				} catch (err) {
					throw new PodmanError("network inspect", 0, `unexpected output — ${err}`);
				}
				const isolate = parsed[0]?.options?.isolate;
				if (parsed.length === 0 || isolate !== "strict") {
					throw new PodmanError(
						"network inspect",
						0,
						`network ${name} exists without options.isolate=strict (found ${JSON.stringify(isolate ?? null)}) — refusing to use it`,
					);
				}
				return;
			}
			const created = await call(
				"network create",
				["network", "create", "--opt", "isolate=strict", name],
				{ conversation: conv },
			);
			if (created.code !== 0) throw fail("network create", created);
		},

		async create(spec, conv) {
			const args = [
				"run",
				"-d",
				"--name",
				spec.name,
				...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
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
				"--network",
				spec.network,
				"--memory",
				spec.memory,
				"--cpus",
				String(spec.cpus),
				"--pids-limit",
				String(spec.pids),
				"--hostname",
				spec.hostname ?? "sandbox",
				...(spec.shmSize === undefined ? [] : ["--shm-size", spec.shmSize]),
				"--init",
				spec.image,
				...(spec.command ?? SANDBOX_INIT_COMMAND),
			];
			const r = await call("create", args, { container: spec.name, conversation: conv });
			if (r.code !== 0) throw fail("create", r);
		},

		async inspect(name, conv) {
			const r = await call("inspect", ["inspect", name], {
				container: name,
				conversation: conv,
			});
			const missing: ContainerInspect = {
				state: "missing",
				image: "",
				networks: [],
				labels: {},
			};
			// Missing is an empty array on stdout (podman 6 answers "no such
			// object" + 125). Portability: some builds exit non-zero with
			// EMPTY stdout for a missing object, naming it on stderr — a
			// bare throw there would wedge every reconcile before create.
			// Any other non-zero is a real failure.
			if (r.code !== 0) {
				if (r.stdout.trim() === "[]") return missing;
				if (r.stdout.trim() === "" && /no such (object|container)/i.test(r.stderr)) {
					return missing;
				}
				throw fail("inspect", r);
			}
			let parsed: z.infer<typeof inspectSchema>;
			try {
				parsed = inspectSchema.parse(JSON.parse(r.stdout));
			} catch (err) {
				throw new PodmanError("inspect", 0, `unexpected output — ${err}`);
			}
			const c = parsed[0];
			if (c === undefined) return missing;
			return {
				state: c.State.Running ? "running" : "stopped",
				image: c.Config.Image,
				networks: Object.keys(c.NetworkSettings.Networks ?? {}),
				labels: c.Config.Labels ?? {},
			};
		},

		async start(name, conv) {
			const r = await call("start", ["start", name], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("start", r);
		},

		async restart(name, conv) {
			const r = await call("restart", ["restart", "-t", "0", name], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("restart", r);
		},

		async rm(name, conv) {
			const r = await call("rm", ["rm", "-f", "-t", "0", name], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("rm", r);
		},

		async exec(name, argv, opts, conv) {
			const t0 = Date.now();
			const r = await execRunner(execArgs(name, argv, opts), opts);
			log.info("podman call", {
				op: "exec",
				container: name,
				conversation: conv,
				status: r.exitCode,
				...(r.timedOut ? { timedOut: true } : {}),
				ms: Date.now() - t0,
			});
			return r;
		},

		async execBytes(name, argv, opts, conv) {
			const t0 = Date.now();
			const r = await execBytesRunner(execArgs(name, argv, opts), opts);
			log.info("podman call", {
				op: "execBytes",
				container: name,
				conversation: conv,
				status: r.exitCode,
				...(r.timedOut ? { timedOut: true } : {}),
				ms: Date.now() - t0,
			});
			return r;
		},

		async cp(name, hostPath, containerPath, conv) {
			const r = await call("cp", ["cp", hostPath, `${name}:${containerPath}`], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("cp", r);
		},

		async networkConnect(network, name, conv) {
			const r = await call("network connect", ["network", "connect", network, name], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("network connect", r);
		},

		async networkDisconnect(network, name, conv) {
			const r = await call("network disconnect", ["network", "disconnect", network, name], {
				container: name,
				conversation: conv,
			});
			if (r.code !== 0) throw fail("network disconnect", r);
		},

		async imageExists(ref, conv) {
			const r = await call("image exists", ["image", "exists", ref], {
				conversation: conv,
			});
			if (r.code === 0) return true;
			if (r.code === 1) return false;
			throw fail("image exists", r);
		},

		async listByLabel(label, conv) {
			const r = await call(
				"ps",
				["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"],
				{ conversation: conv },
			);
			if (r.code !== 0) throw fail("ps", r);
			return r.stdout
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s !== "");
		},
	};
}
