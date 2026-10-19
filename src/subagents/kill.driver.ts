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
// The test's readiness marker poll execs into the same container: the
// warm-up must happen before the ready file, or the poll races sandbox
// creation.
await sandboxes.exec(conv, "true", { timeoutMs: 30_000, maxOutput: 1024 });
const row = await owner.start({
	kind: "worker",
	conversationId: conv,
	workspace,
	task: "run the marker command",
});
writeFileSync(readyFile, `${process.pid}\t${row.id}`);
setInterval(() => {}, 1 << 30);
