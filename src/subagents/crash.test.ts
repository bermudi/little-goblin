// Unsafe-replay crash test: a real owner + real Pi Durable storage in
// a CHILD process whose sandbox "bash" marks the host and then never
// returns; the test SIGKILLs the child mid-dispatch and reopens the
// two stores. The durable transcript must show the call interrupted —
// visible to the model — and the unsafe tool must NOT be dispatched
// again (exactly one marker line). Reuses the fake model edge; no
// external calls.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { subagentsConfigSchema } from "../config.ts";
import type { DesktopRow, Desktops } from "../desktops.ts";
import { setLogFile } from "../log.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openSubagentRuns } from "../subagent-runs.ts";
import { openSubagents } from "./mod.ts";

setLogFile(null);

// Same localhost OpenAI-completions fake as mod.test.ts.
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

const dir = mkdtempSync(join(tmpdir(), "goblin-crash-"));
const dbPath = join(dir, "goblin.sqlite");
const storagePath = join(dir, "subagents.sqlite");
const marker = join(dir, "marker.txt");
const workspace = join(dir, "ws");
mkdirSync(workspace, { recursive: true });

let child: Subprocess | null = null;
const seen: { messages: unknown }[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = (await req.json()) as { messages?: unknown };
		seen.push({ messages: body.messages });
		if (seen.length === 1) {
			return toolReply([{ name: "bash", args: { command: "markit" } }]);
		}
		return toolReply([{ name: "finish", args: { result: "recovered" } }]);
	},
});

afterAll(async () => {
	child?.kill(9);
	await server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function until(fn: () => boolean, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

const idleResult = {
	stdout: "",
	stderr: "",
	exitCode: 0 as number | null,
	timedOut: false,
	killed: false,
	truncated: false,
};

describe("subagent crash recovery — a real killed process", () => {
	test("an interrupted unsafe tool is not dispatched again", async () => {
		child = Bun.spawn(["bun", "run", join(import.meta.dir, "crash-child.ts")], {
			env: {
				...process.env,
				MODEL_URL: `http://127.0.0.1:${server.port}`,
				DB_PATH: dbPath,
				STORAGE_PATH: storagePath,
				MARKER_PATH: marker,
			},
			stdout: "ignore",
			stderr: "inherit",
		});
		await until(() => existsSync(marker), "unsafe tool dispatched in child");
		child.kill(9);
		await child.exited;

		// Reopen the same two stores in THIS process — the recovered
		// generation must surface the interrupted call to the model and
		// must never re-dispatch it.
		let dispatches = 0;
		const sandboxes: Sandboxes = {
			exec: async () => ({ result: idleResult }),
			execArgv: async (_conv, argv) => {
				if (argv.join(" ").includes("markit")) {
					dispatches++;
					appendFileSync(marker, "REPLAYED\n");
				}
				return { result: idleResult };
			},
			execBytesArgv: async () => ({ result: { ...idleResult, stdout: new Uint8Array() } }),
			cpIn: async () => ({}),
			catFile: async () => ({ data: new Uint8Array() }),
			setNetwork: async () => ({}),
			reset: async () => ({}),
		};
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
		const runs = openSubagentRuns(dbPath);
		const owner = await openSubagents({
			config,
			runs,
			auth: { resolve: async () => "k" },
			sandboxes,
			desktops,
			storagePath,
			transferRoot: join(dir, "transfer"),
			wake: () => true,
		});
		await owner.resume();
		await until(() => runs.get(1)?.status === "done", "run settled after crash", 30_000);
		expect(dispatches).toBe(0);
		// Exactly one dispatch, ever.
		expect(readFileSync(marker, "utf8").split("\n").filter(Boolean)).toEqual(["dispatched"]);
		// The model saw the interrupted result before finishing.
		const secondRequest = seen[1];
		expect(secondRequest).not.toBeUndefined();
		expect(JSON.stringify(secondRequest!.messages)).toMatch(
			/interrupt|abort|did not complete|terminated/i,
		);
		expect(runs.get(1)?.result).toBe("recovered");
		await owner.close();
		runs.close();
	}, 60_000);
});
