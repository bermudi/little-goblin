// Crash-recovery evidence for the approval gate. Every test runs a real
// child process over real Pi Durable SQLite storage, SIGKILLs it mid-tool
// (the marker file proves the dispatch), then reopens the storage in this
// process and resumes. Pattern and SSE fakes follow
// src/subagents/crash.test.ts; no external calls.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Subprocess } from "bun";
import type { ApprovalDecision, ApprovalHost, ApprovalRequest } from "./gate.ts";
import { buildRegistry, MODEL_REF, makeActTool, makeModels } from "./lab.ts";

// ---------- fake openai-completions edge ----------

let modelCalls = 0;
const seenRequests: unknown[] = [];

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
			model: "lab",
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
			model: "lab",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	]);
}

function textReply(text: string): Response {
	return sse([
		{
			id: "c2",
			object: "chat.completion.chunk",
			created: 2,
			model: "lab",
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
		},
		{
			id: "c2",
			object: "chat.completion.chunk",
			created: 2,
			model: "lab",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		},
	]);
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		modelCalls++;
		seenRequests.push(await req.json());
		if (modelCalls === 1) return toolReply([{ name: "act", args: { target: "widget" } }]);
		return textReply("All done.");
	},
});
const modelUrl = `http://127.0.0.1:${server.port}`;

// ---------- per-test lab ----------

interface Lab {
	dir: string;
	storagePath: string;
	markerPath: string;
	markerCount(): number;
}

function freshLab(): Lab {
	const dir = mkdtempSync(join(tmpdir(), "pi-approval-"));
	const storagePath = join(dir, "lab.sqlite");
	const markerPath = join(dir, "marker.txt");
	return {
		dir,
		storagePath,
		markerPath,
		markerCount: () =>
			existsSync(markerPath)
				? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).length
				: 0,
	};
}

interface Reopen {
	harness: Harness;
	requests: ApprovalRequest[];
	decide(decision: ApprovalDecision): void;
}

/** Reopen the crashed storage in THIS process — the standing-in operator. */
async function reopen(lab: Lab, gated: boolean): Promise<Reopen> {
	const models = await makeModels(modelUrl);
	const requests: ApprovalRequest[] = [];
	let resolveDecision: ((d: ApprovalDecision) => void) | undefined;
	const host: ApprovalHost = {
		requestApproval: async (request) => {
			requests.push(request);
			return await new Promise<ApprovalDecision>((resolve) => {
				resolveDecision = resolve;
			});
		},
	};
	const registry = buildRegistry(gated, makeActTool(false, lab.markerPath), host);
	const harness = await Harness.open(
		await openNodeSqliteStorage(lab.storagePath),
		{ models, registry },
		ctx,
	);
	await harness.root(ctx);
	await harness.resume();
	return { harness, requests, decide: (d) => resolveDecision?.(d) };
}

function spawnChild(lab: Lab, mode: string, gated: boolean, hang: boolean): Subprocess {
	return Bun.spawn([process.execPath, join(import.meta.dir, "child.ts")], {
		env: {
			...process.env,
			MODE: mode,
			GATED: gated ? "1" : "0",
			HANG: hang ? "1" : "0",
			STORAGE_PATH: lab.storagePath,
			MODEL_URL: modelUrl,
			MARKER_PATH: lab.markerPath,
			REQUEST_PATH: join(lab.dir, "request.json"),
			DECISION_PATH: join(lab.dir, "decision.json"),
		},
		stdout: "ignore",
		stderr: "inherit",
	});
}

async function until(
	fn: () => boolean | Promise<boolean>,
	what: string,
	ms = 30_000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

interface ViewEntryShape {
	kind?: string;
	model?: { role?: string; content?: string | { type?: string; text?: string }[] }[];
}

async function transcriptText(harness: Harness): Promise<string> {
	const root = await harness.root(ctx);
	const view = await root.viewState(ctx);
	const value = (view as unknown as { value?: { entries?: ViewEntryShape[] } }).value;
	return (value?.entries ?? [])
		.map((entry) =>
			(entry.model ?? [])
				.map((message) => {
					const content = message.content ?? [];
					return typeof content === "string"
						? content
						: content.map((block) => block.text ?? "").join(" ");
				})
				.join(" "),
		)
		.join("\n");
}

async function killChild(child: Subprocess): Promise<void> {
	child.kill(9);
	await child.exited;
}

// ---------- the evidence ----------

beforeEach(() => {
	modelCalls = 0;
	seenRequests.length = 0;
});

afterAll(async () => {
	await server.stop(true);
});

describe("pi-durable crash ambiguity — baseline vs approval gate", () => {
	test("baseline: an interrupted unsafe tool auto-resolves and the run continues without any operator", async () => {
		const lab = freshLab();
		const child = spawnChild(lab, "submit", false, true);
		await until(() => lab.markerCount() === 1, "act dispatched in child");
		await killChild(child);

		const reopened = await reopen(lab, false);
		try {
			// Pi Durable's default: the model is told the call was
			// interrupted and the generation moves on. Nobody is asked.
			await until(
				() =>
					modelCalls >= 2 && transcriptText(reopened.harness).then((t) => t.includes("All done.")),
				"run continuing after interrupted tool",
			);
			const text = await transcriptText(reopened.harness);
			expect(text).toContain("interrupted and may have partially run");
			expect(reopened.requests).toHaveLength(0);
			// The default never re-dispatches — it just carries on.
			expect(lab.markerCount()).toBe(1);
		} finally {
			await reopened.harness.close(ctx);
			rmSync(lab.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("gate: a crash-ambiguous tool parks the run until the operator reports it interrupted", async () => {
		const lab = freshLab();
		const child = spawnChild(lab, "submit", true, true);
		await until(() => lab.markerCount() === 1, "act dispatched in child");
		await killChild(child);

		const reopened = await reopen(lab, true);
		try {
			// Parked: the gate asks, and nothing else happens.
			await until(() => reopened.requests.length === 1, "approval request");
			expect(reopened.requests[0]?.tool).toBe("act");
			expect(reopened.requests[0]?.args).toEqual({ target: "widget" });
			expect(reopened.requests[0]?.attempts).toBe(1);
			await Bun.sleep(400);
			expect(modelCalls).toBe(1);
			expect(lab.markerCount()).toBe(1);

			reopened.decide({ kind: "interrupted", note: "leave it" });
			await until(() => modelCalls >= 2, "model asked again after the decision");
			await until(
				async () => (await transcriptText(reopened.harness)).includes("All done."),
				"run settled",
			);
			const text = await transcriptText(reopened.harness);
			expect(text).toContain("report interrupted, do not re-run");
			expect(text).toContain("leave it");
			// The second model request saw the operator's verdict.
			expect(JSON.stringify(seenRequests[1])).toContain("leave it");
			expect(lab.markerCount()).toBe(1);
		} finally {
			await reopened.harness.close(ctx);
			rmSync(lab.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("gate: the operator's retry decision re-executes the exact call exactly once", async () => {
		const lab = freshLab();
		const child = spawnChild(lab, "submit", true, true);
		await until(() => lab.markerCount() === 1, "act dispatched in child");
		await killChild(child);

		const reopened = await reopen(lab, true);
		try {
			await until(() => reopened.requests.length === 1, "approval request");
			reopened.decide({ kind: "retry", note: "run it again" });
			await until(() => lab.markerCount() === 2, "act re-executed after approval");
			await until(() => modelCalls >= 2, "model asked again after retry");
			const text = await transcriptText(reopened.harness);
			expect(text).toContain("acted on widget");
			expect(text).toContain("All done.");
			expect(lab.markerCount()).toBe(2);
		} finally {
			await reopened.harness.close(ctx);
			rmSync(lab.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("gate: the operator's abort decision ends the run without another model request", async () => {
		const lab = freshLab();
		const child = spawnChild(lab, "submit", true, true);
		await until(() => lab.markerCount() === 1, "act dispatched in child");
		await killChild(child);

		const reopened = await reopen(lab, true);
		try {
			await until(() => reopened.requests.length === 1, "approval request");
			reopened.decide({ kind: "abort", note: "shut it down" });
			await until(
				async () => (await transcriptText(reopened.harness)).includes("Operator aborted"),
				"abort recorded",
			);
			await Bun.sleep(500);
			expect(modelCalls).toBe(1);
			expect(lab.markerCount()).toBe(1);
		} finally {
			await reopened.harness.close(ctx);
			rmSync(lab.dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("gate: a second crash while parked re-surfaces the same ambiguity — an undecided question is never acted on", async () => {
		const lab = freshLab();
		const childA = spawnChild(lab, "submit", true, true);
		await until(() => lab.markerCount() === 1, "act dispatched in child A");
		await killChild(childA);

		// Child B reopens and parks, waiting for a decision over files.
		const childB = spawnChild(lab, "resume-file", true, false);
		const requestPath = join(lab.dir, "request.json");
		const decisionPath = join(lab.dir, "decision.json");
		await until(() => existsSync(requestPath), "child B parked in the gate");
		await killChild(childB);
		expect(existsSync(decisionPath)).toBe(false);

		// Third owner: the ambiguity is re-surfaced, not acted on.
		const reopened = await reopen(lab, true);
		try {
			await until(
				() => reopened.requests.length === 1,
				"approval request again after second crash",
			);
			expect(reopened.requests[0]?.attempts).toBe(1);
			expect(modelCalls).toBe(1);
			expect(lab.markerCount()).toBe(1);
			reopened.decide({ kind: "retry" });
			await until(() => lab.markerCount() === 2, "act re-executed after the re-ask");
			await until(() => modelCalls >= 2, "run finishing after re-ask");
		} finally {
			await reopened.harness.close(ctx);
			rmSync(lab.dir, { recursive: true, force: true });
		}
	}, 90_000);
});
