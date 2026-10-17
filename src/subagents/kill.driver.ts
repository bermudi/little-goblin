// Spawned by src/subagents/podman.test.ts (GOBLIN_SUBAGENTS_PODMAN_LIVE=1):
// a second process that owns a real Pi Durable worker run against a real
// podman sandbox, writes a ready file with its pid, then is SIGKILLed by
// the test mid-bash. Recovery is verified by the test reopening the same
// state — the interrupted, replay-unsafe bash call must be reported
// interrupted, never re-executed in the container.
//
// usage: bun src/subagents/kill.driver.ts \
//   <dbDir> <modelUrl> <conv> <workspace> <sbxPrefix> <network> <readyFile>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { subagentsConfigSchema } from "../config.ts";
import type { DesktopRow, Desktops } from "../desktops.ts";
import { setLogFile } from "../log.ts";
import { makePodman } from "../podman.ts";
import { makeSandboxes, openSandboxes } from "../sandboxes.ts";
import { openSubagentRuns } from "../subagent-runs.ts";
import { openSubagents } from "./mod.ts";

const [dbDir, modelUrl, conv, workspace, sbxPrefix, network, readyFile] = process.argv.slice(2);
if (!dbDir || !modelUrl || !conv || !workspace || !sbxPrefix || !network || !readyFile) {
	throw new Error(
		"usage: driver <dbDir> <modelUrl> <conv> <workspace> <sbxPrefix> <network> <readyFile>",
	);
}
setLogFile(join(dbDir, "driver.log"));

// The worker never touches desktops; the dep is structural.
const drow: DesktopRow = {
	name: "d",
	container: "fake",
	image: "fake",
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
	createdAt: 0,
	lastUsedAt: 0,
};
const desktops: Desktops = {
	allocate: async () => ({ row: drow }),
	list: () => [drow],
	get: () => drow,
	claim: async () => drow,
	release: async () => {},
	handoff: async () => {},
	reserve: async () => {},
	setNetwork: async () => {},
	destroy: async () => {},
	screenshot: async () => ({ id: "o", path: "/tmp/x", bytes: new Uint8Array([0]) }),
	inspect: async () => ({ id: "o", state: {} }),
	act: async () => ({ result: {} }),
	cpIn: async () => ({}),
	catFile: async () => ({ data: new Uint8Array() }),
};

const podman = makePodman();
const sandboxes = makeSandboxes({
	podman,
	store: openSandboxes(join(dbDir, "sandboxes.sqlite")),
	config: () => undefined,
	containerPrefix: sbxPrefix,
	networkName: network,
});
const runs = openSubagentRuns(join(dbDir, "goblin.sqlite"));
const owner = await openSubagents({
	config: subagentsConfigSchema.parse({
		maxRuns: 1,
		worker: {
			model: {
				auth: "test",
				id: "glm-5.3",
				baseUrl: modelUrl,
				api: "openai-completions",
				thinking: "low",
			},
		},
	}),
	runs,
	auth: { resolve: async () => "k" },
	sandboxes,
	desktops,
	storagePath: join(dbDir, "subagents.sqlite"),
	transferRoot: join(dbDir, "transfer"),
	wake: () => true,
});
await owner.resume();
// Ensure the sandbox before ready: the test's marker poll execs into
// the same container, and a create race on a not-yet-started container
// is exactly what the driver must prevent.
await sandboxes.exec(conv, "true", { timeoutMs: 30_000, maxOutput: 1024 });
const row = await owner.start({
	kind: "worker",
	conversationId: conv,
	workspace,
	task: "run the marker command",
});
writeFileSync(readyFile, `${process.pid}\t${row.id}`);
setInterval(() => {}, 1 << 30);
