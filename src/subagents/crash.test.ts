import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { subagentsConfigSchema } from "../config.ts";
import type { DesktopRow, Desktops } from "../desktops.ts";
import { setLogFile } from "../log.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openSubagentRuns, type SubagentRuns } from "../subagent-runs.ts";
import { approvalLeaseDoc, openSubagents, type Subagents } from "./mod.ts";
import { captureLog, harnessReports } from "./testing.ts";

setLogFile(null);

function sse(events: object[]): Response {
	const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(lines, { headers: { "content-type": "text/event-stream" } });
}
function toolReply(calls: { name: string; args: Record<string, unknown> }[]): Response {
	return sse([
		{
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: calls.map((c, j) => ({
							index: j,
							id: `call_1_${j}`,
							type: "function",
							function: { name: c.name, arguments: JSON.stringify(c.args) },
						})),
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "c1",
			object: "chat.completion.chunk",
			created: 1,
			model: "fake",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	]);
}
const bashReply = () => toolReply([{ name: "bash", args: { command: "markit" } }]);
const finishReply = () => toolReply([{ name: "finish", args: { result: "recovered" } }]);

const root = mkdtempSync(join(tmpdir(), "goblin-crash-"));
const seen: { messages: unknown }[] = [];
const replies: Response[] = [];
const children: Subprocess[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = (await req.json()) as { messages?: unknown };
		seen.push({ messages: body.messages });
		return replies.shift() ?? finishReply();
	},
});

afterAll(async () => {
	for (const c of children.splice(0)) c.kill(9);
	await server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

async function until(fn: () => boolean, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

function bed(tag: string): {
	dir: string;
	dbPath: string;
	storagePath: string;
	marker: string;
	workspace: string;
} {
	const dir = mkdtempSync(join(root, `${tag}-`));
	const workspace = join(dir, "ws");
	mkdirSync(workspace, { recursive: true });
	return {
		dir,
		dbPath: join(dir, "goblin.sqlite"),
		storagePath: join(dir, "subagents.sqlite"),
		marker: join(dir, "marker.txt"),
		workspace,
	};
}

function markerLines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function spawnChild(b: ReturnType<typeof bed>, extra: Record<string, string> = {}): Subprocess {
	const child = Bun.spawn(["bun", "run", join(import.meta.dir, "crash-child.ts")], {
		env: {
			...process.env,
			MODEL_URL: `http://127.0.0.1:${server.port}`,
			DB_PATH: b.dbPath,
			STORAGE_PATH: b.storagePath,
			MARKER_PATH: b.marker,
			...extra,
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	children.push(child);
	return child;
}

const idleResult = {
	stdout: "",
	stderr: "",
	exitCode: 0 as number | null,
	timedOut: false,
	killed: false,
	truncated: false,
};

const fakeDesktops: Desktops = (() => {
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
	return {
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
})();

async function openOwner(b: ReturnType<typeof bed>): Promise<{
	owner: Subagents;
	runs: SubagentRuns;
	dispatches: () => number;
	wakes: { conv: string; text: string }[];
}> {
	let dispatchCount = 0;
	const sandboxes: Sandboxes = {
		exec: async () => ({ result: idleResult }),
		execArgv: async (_conv, argv) => {
			if (argv.join(" ").includes("markit")) {
				dispatchCount++;
				appendFileSync(b.marker, "REPLAYED\n");
			}
			return { result: idleResult };
		},
		execBytesArgv: async () => ({ result: { ...idleResult, stdout: new Uint8Array() } }),
		cpIn: async () => ({}),
		catFile: async () => ({ data: new Uint8Array() }),
		setNetwork: async () => ({}),
		reset: async () => ({}),
	};
	const config = subagentsConfigSchema.parse({
		maxRuns: 1,
		worker: {
			model: {
				auth: "test",
				id: "glm-5.3",
				baseUrl: `http://127.0.0.1:${server.port}`,
				api: "openai-completions",
				thinking: "low",
			},
		},
		computer: {
			model: {
				auth: "test",
				id: "glm-5.3-flash",
				baseUrl: `http://127.0.0.1:${server.port}`,
				api: "openai-completions",
				thinking: "low",
			},
		},
		desktops: {
			image: "localhost/goblin-desktop:1",
			max: 1,
			idleHours: 0,
			memory: "1g",
			cpus: 1,
			pids: 16,
		},
	});
	const runs = openSubagentRuns(b.dbPath);
	const wakes: { conv: string; text: string }[] = [];
	const owner = await openSubagents({
		config,
		runs,
		auth: { resolve: async () => "k" },
		sandboxes,
		desktops: fakeDesktops,
		storagePath: b.storagePath,
		transferRoot: join(b.dir, "transfer"),
		wake: (conv, text) => {
			wakes.push({ conv, text });
			return true;
		},
	});
	await owner.resume();
	return { owner, runs, dispatches: () => dispatchCount, wakes };
}

async function dispatchAndKill(b: ReturnType<typeof bed>): Promise<void> {
	replies.push(bashReply());
	const child = spawnChild(b);
	await until(() => existsSync(b.marker), "gated tool dispatched in child");
	child.kill(9);
	await child.exited;
}

describe("subagent crash approval — a real killed process", () => {
	test("mid-dispatch kill parks on reopen; authorize-retry runs it once more", async () => {
		const b = bed("retry");
		await dispatchAndKill(b);

		const { owner, runs, dispatches, wakes } = await openOwner(b);
		await until(
			() => runs.get(1)?.status === "needs_input" && runs.get(1)?.pendingApproval !== null,
			"run parked on the ambiguous call",
		);
		const parked = runs.get(1)!;
		expect(parked.pendingApproval?.tool).toBe("bash");
		expect(parked.question ?? "").toContain("bash");
		expect(markerLines(b.marker)).toEqual(["dispatched"]);
		expect(dispatches()).toBe(0);
		expect(wakes.some((w) => /interrupted|partially run/.test(w.text))).toBe(true);
		expect(runs.get(1)?.noticePending).toBe(false);

		replies.push(finishReply());
		const resumed = await owner.decide(1, "crash:one", {
			kind: "authorize-retry",
			evidence: "the marker shows the dispatch began; its completion is unobserved",
			reasoning: "the probe writes an append line — one more dispatch is observable and safe",
		});
		expect(resumed.status).toBe("queued");
		expect(resumed.pendingApproval?.decision?.kind).toBe("authorize-retry");
		await until(() => runs.get(1)?.status === "running", "decision admitted");
		await until(() => runs.get(1)?.status === "done", "run settled after retry");
		expect(markerLines(b.marker)).toEqual(["dispatched", "REPLAYED"]);
		expect(dispatches()).toBe(1);
		expect(runs.get(1)?.result).toBe("recovered");
		const history = runs.get(1)!.crashDecisions;
		expect(history).toHaveLength(1);
		expect(history[0]!.attempts).toBe(1);
		expect(history[0]!.decision).toMatchObject({
			kind: "authorize-retry",
			decidedBy: "goblin",
			outcome: "unverified",
		});
		await owner.close();
		runs.close();
	}, 90_000);

	test("record-result feeds a labeled Goblin declaration to the model with zero re-dispatch", async () => {
		const b = bed("record");
		await dispatchAndKill(b);
		const base = seen.length;
		const captured = captureLog();

		const { owner, runs, dispatches, wakes } = await openOwner(b);
		await until(() => runs.get(1)?.pendingApproval !== null, "run parked");
		replies.push(finishReply());
		await owner.decide(1, "crash:one", {
			kind: "record-result",
			result: "declared: the marker already landed",
			evidence: "the marker file exists on the host",
			reasoning: "the interrupted write is externally visible; re-dispatch would double it",
		});
		await until(() => runs.get(1)?.status === "done", "run settled on the recorded result");
		expect(markerLines(b.marker)).toEqual(["dispatched"]);
		expect(dispatches()).toBe(0);
		const next = seen[base];
		expect(next).not.toBeUndefined();
		const wire = JSON.stringify(next!.messages);
		expect(wire).toContain("declared: the marker already landed");
		expect(wire).toContain("crash resolution: Goblin-decided");
		expect(wire).toContain("interrupted outcome: unverified");
		expect(wire).toContain("the marker file exists on the host");
		expect(wire).toContain("re-dispatch would double it");
		expect(wire).not.toContain("operator_recorded");
		expect(wire).not.toContain("recorded by the operator");
		expect(runs.get(1)?.result).toBe("recovered");
		const settled = runs.get(1)!;
		expect(settled.crashDecisions).toHaveLength(1);
		expect(settled.crashDecisions[0]!.decision).toMatchObject({
			kind: "record-result",
			result: "declared: the marker already landed",
			decidedBy: "goblin",
			outcome: "unverified",
		});
		expect(wakes.some((w) => w.text.includes("Crash resolution warning"))).toBe(true);
		captured.stop();
		expect(harnessReports(captured.lines)).toEqual([]);
		expect(captured.lines.some((l) => l.includes("subagent settle"))).toBe(true);
		await owner.close();
		runs.close();
	}, 90_000);

	test("abandon terminates the run with no further model call", async () => {
		const b = bed("abandon");
		await dispatchAndKill(b);
		const base = seen.length;
		const captured = captureLog();

		const { owner, runs, dispatches } = await openOwner(b);
		await until(() => runs.get(1)?.pendingApproval !== null, "run parked");
		await owner.decide(1, "crash:one", {
			kind: "abandon",
			note: "too risky",
			evidence: "the interrupted write's effect could not be confirmed",
			reasoning: "a retry could append a second marker — ending is safest",
		});
		await until(() => runs.get(1)?.status === "failed", "run failed on abandon");
		expect(runs.get(1)?.error ?? "").toContain("Goblin abandoned this run");
		expect(markerLines(b.marker)).toEqual(["dispatched"]);
		expect(dispatches()).toBe(0);
		await Bun.sleep(400);
		expect(seen.length).toBe(base);
		captured.stop();
		expect(harnessReports(captured.lines)).toEqual([]);
		expect(captured.lines.some((l) => l.includes("subagent settle"))).toBe(true);
		await owner.close();
		runs.close();
	}, 90_000);

	test("kill while parked re-parks on the next open and the decision still lands", async () => {
		const b = bed("repark");
		const wakeLog = join(b.dir, "wakes.jsonl");
		await dispatchAndKill(b);
		const c2 = spawnChild(b, { MODE: "resume", WAKE_PATH: wakeLog });
		const probe = openSubagentRuns(b.dbPath);
		try {
			await until(() => {
				const row = probe.get(1);
				return row?.status === "needs_input" && row.pendingApproval !== null;
			}, "child re-parked the run");
		} finally {
			probe.close();
		}
		await until(
			() => existsSync(wakeLog) && readFileSync(wakeLog, "utf8").includes("interrupted"),
			"child wake delivered",
		);
		c2.kill(9);
		await c2.exited;

		const { owner, runs, dispatches, wakes } = await openOwner(b);
		await until(
			() => wakes.some((w) => /interrupted|partially run/.test(w.text)),
			"run re-parked and re-asked after second kill",
		);
		expect(runs.get(1)?.pendingApproval).not.toBeNull();
		replies.push(finishReply());
		await owner.decide(1, "crash:one", {
			kind: "record-result",
			result: "verified after two kills",
			evidence: "the marker file was read after the second park",
			reasoning: "the observed effect needs no further dispatch",
		});
		await until(() => runs.get(1)?.status === "done", "settled after re-park");
		expect(markerLines(b.marker)).toEqual(["dispatched"]);
		expect(dispatches()).toBe(0);
		expect(runs.get(1)?.result).toBe("recovered");
		await owner.close();
		runs.close();
	}, 90_000);

	for (const [tag, seededResult, assertions] of [
		[
			"ordinary",
			// pi-durable 1.3.0 carries tool results under `output`; `content`
			// is the legacy key the fixture below seeds.
			{ output: [{ type: "text", text: "seeded-result: the marker already landed" }] },
			(wire: string) => {
				expect(wire).toContain("seeded-result: the marker already landed");
				expect(wire).not.toContain("crash resolution");
				expect(wire).not.toContain("unverified");
			},
		],
		[
			"legacy",
			{
				content: [{ type: "text", text: "seeded-result: the marker already landed" }],
				diagnostics: [
					{
						severity: "warn",
						code: "operator_recorded",
						message: "this result was recorded by the operator for an interrupted bash call",
					},
				],
			},
			(wire: string) => {
				expect(wire).toContain("seeded-result: the marker already landed");
				expect(wire).toContain("legacy decision; provenance not recorded");
				expect(wire).toContain("interrupted outcome: unverified");
				expect(wire).toContain("not recorded (legacy decision)");
				expect(wire).not.toContain("operator_recorded");
				expect(wire).not.toContain("recorded by the operator");
			},
		],
	] as const) {
		test(`a pre-seeded done lease replays its ${tag} result with zero dispatch`, async () => {
			const b = bed(`seeded-${tag}`);
			await dispatchAndKill(b);

			const storage = await openNodeSqliteStorage(b.storagePath);
			const bare = await Harness.open(
				storage,
				{
					models: createModels({ credentials: new InMemoryCredentialStore() }),
					registry: createRegistry(),
				},
				BACKGROUND_CONTEXT,
			);
			try {
				const live = await bare.inspect(BACKGROUND_CONTEXT);
				const toolTask = live.tasks.find((t) => t.record.kind === "pi.tool");
				expect(toolTask).not.toBeUndefined();
				await bare.commit(async (tx) => {
					const draft = await tx.doc(approvalLeaseDoc, toolTask!.record.id);
					draft.state = "done";
					draft.attempts = null;
					draft.decision = null;
					draft.result = seededResult as never;
				}, BACKGROUND_CONTEXT);
			} finally {
				await bare.close(BACKGROUND_CONTEXT);
			}

			const base = seen.length;
			replies.push(finishReply());
			const captured = captureLog();
			const { owner, runs, dispatches } = await openOwner(b);
			await until(() => runs.get(1)?.status === "done", "run settled on the seeded result");
			expect(markerLines(b.marker)).toEqual(["dispatched"]);
			expect(dispatches()).toBe(0);
			assertions(JSON.stringify(seen[base]?.messages));
			expect(runs.get(1)?.result).toBe("recovered");
			captured.stop();
			expect(harnessReports(captured.lines)).toEqual([]);
			expect(
				captured.lines.some((l) =>
					l.includes(
						tag === "legacy"
							? "legacy declared result normalized"
							: "persisted result replayed as an error result",
					),
				),
			).toBe(true);
			await owner.close();
			runs.close();
		}, 90_000);
	}
});
