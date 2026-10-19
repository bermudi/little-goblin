
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthStore, loadAuthFile } from "../auth.ts";
import { desktopsConfigSchema, subagentsConfigSchema } from "../config.ts";
import { containerNameForDesktop, type Desktops, makeDesktops, openDesktops } from "../desktops.ts";
import { setLogFile } from "../log.ts";
import { makePodman, type Podman } from "../podman.ts";
import { boundedRun, spawnProc } from "../proc.ts";
import { containerNameFor, makeSandboxes, openSandboxes, type Sandboxes } from "../sandboxes.ts";
import { SUBAGENT_DRIFT_INPUTS } from "../subagent-prompts.ts";
import { openSubagentRuns, type SubagentRuns } from "../subagent-runs.ts";
import { openSubagents, type Subagents } from "./mod.ts";

const LIVE = process.env.GOBLIN_SUBAGENTS_LIVE === "1";
const AUTH_FILE = process.env.GOBLIN_SUBAGENTS_AUTH_FILE ?? "";

const TOKEN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const SBX_PREFIX = `goblin-subdrift-${TOKEN}-sbx-`;
const SBX_NETWORK = `goblin-subdrift-${TOKEN}-net`;
const WORKER_CONV = `subdrift-${TOKEN}:worker`;
const ASK_CONV = `subdrift-${TOKEN}:ask`;
const DESKTOP = `goblin-subdrift-${TOKEN}-desk`;
const DESK_CONTAINER = containerNameForDesktop(DESKTOP);
const DESK_NETWORK = `goblin-subdrift-${TOKEN}-dnet`;
const CANDIDATE_CONTAINERS = [
	containerNameFor(WORKER_CONV, SBX_PREFIX),
	containerNameFor(ASK_CONV, SBX_PREFIX),
	DESK_CONTAINER,
];
const CANDIDATE_NETWORKS = [SBX_NETWORK, DESK_NETWORK];
const EVIDENCE_DIR = `/tmp/goblin-subdrift-${TOKEN}`;

let cwd = "";
let podman: Podman | null = null;
let sandboxes: Sandboxes | null = null;
let desktops: Desktops | null = null;
let runs: SubagentRuns | null = null;
let owner: Subagents | null = null;
let auth: AuthStore | null = null;
const wakes: { conv: string; text: string }[] = [];
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

async function untilOk(fn: () => boolean, what: string, ms = 300_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await Bun.sleep(1000);
	}
	throw new Error(`subagent drift: timed out waiting for ${what}`);
}

function workspace(name: string): string {
	const ws = join(cwd, name);
	mkdirSync(ws, { recursive: true });
	return ws;
}

describe.skipIf(!LIVE)("subagent live drift (GOBLIN_SUBAGENTS_LIVE=1)", () => {
	beforeAll(async () => {
		if (AUTH_FILE === "") {
			throw new Error(
				"GOBLIN_SUBAGENTS_AUTH_FILE is unset — point it at an auth.jsonl with a `zai` record; never pass the key itself",
			);
		}
		cwd = mkdtempSync(join(tmpdir(), "goblin-subdrift-"));
		mkdirSync(EVIDENCE_DIR, { recursive: true });
		setLogFile(join(EVIDENCE_DIR, "drift.log"));
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
		for (const name of CANDIDATE_CONTAINERS) {
			if (await probeExists(name)) {
				throw new Error(`probe container ${name} already exists — refusing to run`);
			}
		}
		for (const net of CANDIDATE_NETWORKS) {
			if (await netExists(net)) {
				throw new Error(`probe network ${net} already exists — refusing to run`);
			}
		}
		auth = loadAuthFile(AUTH_FILE);
		sandboxes = makeSandboxes({
			podman,
			store: openSandboxes(join(cwd, "sandboxes.sqlite")),
			config: () => undefined,
			containerPrefix: SBX_PREFIX,
			networkName: SBX_NETWORK,
		});
		desktops = makeDesktops({
			podman,
			store: openDesktops(join(cwd, "desktops.sqlite")),
			config: () => ({ ...desktopsConfigSchema.parse({}), idleHours: 0 }),
			shotsRoot: join(cwd, "shots"),
			networkName: DESK_NETWORK,
		});
		runs = openSubagentRuns(join(cwd, "goblin.sqlite"));
		owner = await openSubagents({
			config: subagentsConfigSchema.parse({
				maxRuns: 2,
				worker: {
					model: {
						auth: "zai",
						id: "glm-5.3",
						baseUrl: "https://api.z.ai/api/coding/paas/v4",
						api: "openai-completions",
						thinking: "high",
					},
				},
				computer: {
					model: {
						auth: "zai",
						id: "glm-5.3-flash",
						baseUrl: "https://api.z.ai/api/coding/paas/v4",
						api: "openai-completions",
						thinking: "low",
					},
				},
			}),
			runs,
			auth,
			sandboxes,
			desktops,
			storagePath: join(cwd, "subagents.sqlite"),
			transferRoot: join(cwd, "transfer"),
			wake: (conv, text) => {
				wakes.push({ conv, text });
				return true;
			},
		});
		await owner.resume();
	}, 60_000);

	test("worker drift: read → write → read back → finish VERIFIED_WORKER", async () => {
		writeFileSync(join(cwd, "drift-input.txt"), "DRIFT_IN\n");
		await sandboxes!.exec(WORKER_CONV, "mkdir -p /work", {
			timeoutMs: 60_000,
			maxOutput: 64 * 1024,
		});
		await sandboxes!.cpIn(WORKER_CONV, join(cwd, "drift-input.txt"), "/work/input.txt");
		const ws = workspace("ws-worker");
		const run = await owner!.start({
			kind: "worker",
			conversationId: WORKER_CONV,
			workspace: ws,
			task: SUBAGENT_DRIFT_INPUTS.worker,
		});
		await untilOk(() => runs!.get(run.id)?.status === "done", "worker done");
		const row = runs!.get(run.id)!;
		expect(row.result).toBe("VERIFIED_WORKER");
		const out = await sandboxes!.catFile(WORKER_CONV, "/work/output.txt");
		expect(new TextDecoder().decode(out.data)).toBe("DRIFT_OUT\n");
		expect(row.exportedFiles).toHaveLength(1);
		const exportedPath = join(ws, row.exportedFiles[0]!);
		expect(readFileSync(exportedPath, "utf8")).toBe("DRIFT_OUT\n");
		copyFileSync(exportedPath, join(EVIDENCE_DIR, "worker-output.txt"));
		expect(wakes.some((w) => w.conv === WORKER_CONV)).toBe(true);
	}, 360_000);

	test("computer drift: screenshot only, then finish VERIFIED_COMPUTER", async () => {
		await desktops!.allocate(DESKTOP);
		const ws = workspace("ws-computer");
		const run = await owner!.start({
			kind: "computer",
			conversationId: `subdrift-${TOKEN}:computer`,
			workspace: ws,
			task: SUBAGENT_DRIFT_INPUTS.computer,
			desktop: DESKTOP,
		});
		await untilOk(() => runs!.get(run.id)?.status === "done", "computer done");
		const row = runs!.get(run.id)!;
		expect(row.result).toBe("VERIFIED_COMPUTER");
		expect(row.finalScreenshot).not.toBeNull();
		copyFileSync(join(ws, row.finalScreenshot!), join(EVIDENCE_DIR, "computer-final.png"));
	}, 420_000);

	test("ask drift: question → operator answer → VERIFIED_ANSWER", async () => {
		const run = await owner!.start({
			kind: "worker",
			conversationId: ASK_CONV,
			workspace: workspace("ws-ask"),
			task: SUBAGENT_DRIFT_INPUTS.ask,
		});
		await untilOk(() => runs!.get(run.id)?.status === "needs_input", "needs_input");
		expect(runs!.get(run.id)?.question).toBe("DRIFT_QUESTION");
		const piConversationId = runs!.get(run.id)!.piConversationId;
		expect(piConversationId).not.toBeNull();
		await owner!.send(run.id, ASK_CONV, "DRIFT_ANSWER");
		await untilOk(() => runs!.get(run.id)?.status === "done", "ask done");
		expect(runs!.get(run.id)?.result).toBe("VERIFIED_ANSWER");
		expect(runs!.get(run.id)!.piConversationId).toBe(piConversationId);
	}, 600_000);

	afterAll(async () => {
		setLogFile(null);
		const failures: string[] = [];
		try {
			await owner?.close();
		} catch (err) {
			failures.push(`owner close: ${String(err).slice(0, 200)}`);
		}
		if (podman !== null) {
			for (const name of createdContainers) {
				try {
					if (await probeExists(name)) await podman.rm(name);
				} catch (err) {
					if (!/no such|not found|does not exist/i.test(String(err))) {
						failures.push(`rm ${name}: ${String(err).slice(0, 200)}`);
					}
				}
			}
			for (const net of createdNetworks) {
				try {
					if (await netExists(net)) {
						const r = await boundedRun(spawnProc(["podman", "network", "rm", net]), {
							timeoutMs: 30_000,
							maxOutput: 1 << 20,
						});
						if (r.exitCode !== 0 && !/does not exist|not found/i.test(r.stderr)) {
							failures.push(`network rm ${net}: ${r.stderr.trim().slice(0, 200)}`);
						}
					}
				} catch (err) {
					failures.push(`network rm ${net}: ${String(err).slice(0, 200)}`);
				}
			}
		}
		writeFileSync(
			join(EVIDENCE_DIR, "REPORT.md"),
			[
				`# subagent live drift — ${new Date().toISOString()}`,
				``,
				`token: ${TOKEN}`,
				`candidates: ${CANDIDATE_CONTAINERS.join(", ")} / ${CANDIDATE_NETWORKS.join(", ")}`,
				`created (removed): ${[...createdContainers].join(", ") || "none"} / ${[...createdNetworks].join(", ") || "none"}`,
				`wakes: ${wakes.length}`,
				`runs:`,
				...(runs === null
					? ["  (store closed)"]
					: [WORKER_CONV, ASK_CONV, `subdrift-${TOKEN}:computer`].flatMap((c) =>
							runs!
								.listFor(c)
								.map(
									(r) =>
										`  #${r.id} ${r.kind} ${r.status} conv=${c} result=${r.result ?? "-"} error=${r.error ?? "-"}`,
								),
						)),
				`evidence: ${EVIDENCE_DIR}`,
				`teardown failures: ${failures.length === 0 ? "none" : failures.join("; ")}`,
				``,
			].join("\n"),
		);
		runs?.close();
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
		if (failures.length > 0) {
			throw new Error(`subagent drift teardown failed: ${failures.join("; ")}`);
		}
	}, 120_000);
});
