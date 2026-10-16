// Child process for the crash-approval tests: a real owner over real
// Pi storage whose sandbox "bash" records a dispatch marker on the
// host and then never returns. The parent SIGKILLs mid-dispatch; only
// the marker survives, proving the gated call ran at most once.
// Env (no secrets): MODEL_URL, DB_PATH, STORAGE_PATH, MARKER_PATH;
// MODE=submit starts a run after resume (default), MODE=resume only
// resumes; WAKE_PATH, when set, receives one JSON notice per line.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { subagentsConfigSchema } from "../config.ts";
import type { Desktops, DesktopRow } from "../desktops.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openSubagentRuns } from "../subagent-runs.ts";
import { openSubagents } from "../subagents.ts";
import { setLogFile } from "../log.ts";

const MODEL_URL = process.env.MODEL_URL ?? "";
const DB_PATH = process.env.DB_PATH ?? "";
const STORAGE_PATH = process.env.STORAGE_PATH ?? "";
const MARKER_PATH = process.env.MARKER_PATH ?? "";
const MODE = process.env.MODE ?? "submit";
const WAKE_PATH = process.env.WAKE_PATH ?? "";
if (MODEL_URL === "" || DB_PATH === "" || STORAGE_PATH === "" || MARKER_PATH === "") {
	throw new Error("MODEL_URL/DB_PATH/STORAGE_PATH/MARKER_PATH are required");
}
if (MODE !== "submit" && MODE !== "resume") {
	throw new Error(`MODE must be submit or resume, got ${MODE}`);
}
setLogFile(null);

const idle = () => new Promise<never>(() => {});
const okRes = {
	stdout: "",
	stderr: "",
	exitCode: 0 as number | null,
	timedOut: false,
	killed: false,
	truncated: false,
};

const sandboxes: Sandboxes = {
	exec: async () => ({ result: okRes }),
	execArgv: async (_conv, argv) => {
		if (argv.join(" ").includes("markit")) {
			appendFileSync(MARKER_PATH, "dispatched\n");
			await idle(); // killed here — the unsafe call is mid-flight
		}
		return { result: okRes };
	},
	execBytesArgv: async () => ({ result: { ...okRes, stdout: new Uint8Array() } }),
	cpIn: async () => ({}),
	catFile: async () => ({ data: new Uint8Array() }),
	setNetwork: async () => ({}),
	reset: async () => ({}),
};

const row: DesktopRow = {
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
	allocate: async () => ({ row }),
	list: () => [row],
	get: () => row,
	claim: async () => row,
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

// The workspace sits below the parent's own temp dir (DB_PATH's dir)
// so a SIGKILLed child leaks nothing the parent won't remove.
const workspace = join(dirname(DB_PATH), "ws");
mkdirSync(workspace, { recursive: true });
const runs = openSubagentRuns(DB_PATH);
const owner = await openSubagents({
	config: subagentsConfigSchema.parse({
		maxRuns: 1,
		worker: {
			model: {
				auth: "test",
				id: "glm-5.3",
				baseUrl: MODEL_URL,
				api: "openai-completions",
				thinking: "low",
			},
		},
		computer: {
			model: {
				auth: "test",
				id: "glm-5.3-flash",
				baseUrl: MODEL_URL,
				api: "openai-completions",
				thinking: "low",
			},
		},
	}),
	runs,
	auth: { resolve: async () => "k" },
	sandboxes,
	desktops,
	storagePath: STORAGE_PATH,
	transferRoot: join(workspace, "transfer"),
	wake: (_conv, text) => {
		if (WAKE_PATH !== "") appendFileSync(WAKE_PATH, `${JSON.stringify(text)}\n`);
		return true;
	},
});
await owner.resume();
if (MODE === "submit") {
	await owner.start({
		kind: "worker",
		conversationId: "crash:one",
		workspace,
		task: "run markit",
	});
}
// The parent watches the marker; this process never exits on its own.
await idle();
