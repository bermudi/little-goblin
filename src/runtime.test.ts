import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { type LanguageModel, tool, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import {
	finishPart,
	scriptedModel as scriptedEdge,
	type StreamAttempt,
	textParts,
	toolCallPart,
} from "./testkit/fake-model.ts";
import { ATTACHMENT_PART } from "./agent/attachments.ts";
import { readFileTool } from "./agent/tools/read.ts";
import { parseConfig } from "./config.ts";
import { appAddress, captureConversationSettings, openStore } from "./conversation.ts";
import type { System1Client } from "./system1.ts";
import { setLogFile } from "./log.ts";
import { Reviewer } from "./reviewer.ts";
import { openTurnJournal, type TurnJournal } from "./turn-journal.ts";
import { openWindowCapture } from "./window-capture.ts";
import type { HindsightClient } from "./memory/hindsight.ts";
import { forgetDocument } from "./memory/forget.ts";
import { memoryConfigSchema } from "./config.ts";
import {
	Runtime,
	type ModelStep,
	type RuntimeDeps,
	type TurnDone,
	type TurnSink,
	userMessage,
} from "./runtime.ts";
import {
	deferred,
	fakeModel,
	HeadlessSink,
	ParkedDoneSink,
	pauseFakeModelAtDelta,
	RecordingSink,
	recordingModel,
	sleep,
	tmpDb,
	useHome,
	waitUntil,
	tmpDir,
} from "./testkit.ts";
import { systemPromptFor } from "./agent/prompt.ts";
import { toolNames } from "./agent/tools/mod.ts";

type Store = ReturnType<typeof openStore>;
type Conv = ReturnType<Store["resolve"]>;

interface Rig {
	store: Store;
	conv: Conv;
	runtime: Runtime;
}

function rig(
	opts: {
		model?: LanguageModel;
		deltas?: string[];
		delayMs?: number;
		step?: Partial<Omit<ModelStep, "model">>;
		buildStep?: RuntimeDeps["buildStep"];
		tools?: ToolSet;
		makeTools?: RuntimeDeps["makeTools"];
		deps?: Partial<
			Pick<
				RuntimeDeps,
				| "compaction"
				| "captureConversation"
				| "memory"
				| "turnJournal"
				| "recordWindow"
				| "windowVersion"
			>
		>;
		addr?: Parameters<Store["resolve"]>[0];
		store?: Store;
	} = {},
): Rig {
	const store = opts.store ?? openStore(tmpDb("goblin-rt-"));
	const conv = store.resolve(opts.addr ?? { kind: "dm", chatId: 1 }, "/w");
	const runtime = new Runtime({
		store,
		buildStep:
			opts.buildStep ??
			(() => ({
				model: opts.model ?? fakeModel(opts.deltas ?? ["ok"], opts.delayMs ?? 5),
				system: "test",
				...opts.step,
			})),
		makeTools: opts.makeTools ?? (() => opts.tools ?? {}),
		...opts.deps,
	});
	return { store, conv, runtime };
}

function submit(r: Rig, text: string): RecordingSink;
function submit<S extends TurnSink>(r: Rig, text: string, sink: S): S;
function submit(r: Rig, text: string, sink?: TurnSink): TurnSink {
	const s = sink ?? new RecordingSink();
	r.runtime.submit(r.conv, userMessage([{ type: "text", text }]), s);
	return s;
}

const drain = (r: Rig) => waitUntil(() => !r.runtime.busy(r.conv.id), "lane drains");

describe("skill body ownership across turns", () => {
	test("the owning turn injects the body; a later turn sees only the marker", async () => {
		const home = useHome("goblin-rt-skill-");
		mkdirSync(join(home, "workspace/skills/rtdemo"), { recursive: true });
		const skillPath = join(home, "workspace/skills/rtdemo/SKILL.md");
		writeFileSync(skillPath, "---\nname: rtdemo\ndescription: d\n---\nRT-BODY-AAA");
		const { model, prompts } = recordingModel(["ok"], 1);
		const store = openStore(tmpDb("goblin-rt-j-"));
		const journal = openTurnJournal(store.db);
		const r = rig({ model, store, deps: { turnJournal: journal } });
		try {
			// Caller contract: append the durable user event, then submit
			// with the append's seq.
			const skill = userMessage([
				{ type: "data-skill", data: { name: "rtdemo" } },
				{ type: "text", text: "use it" },
			] as never);
			const firstSeq = r.store.append(r.conv.id, [skill])[0]!;
			r.runtime.submitPersisted(r.conv, skill, new HeadlessSink(), firstSeq);
			await drain(r);
			expect(prompts[0]).toContain("RT-BODY-AAA");

			// Explicit retry of that same input re-owns it — and now reads
			// the EDITED body.
			writeFileSync(skillPath, "---\nname: rtdemo\ndescription: d\n---\nRT-BODY-BBB");
			r.runtime.submitPersisted(r.conv, skill, new HeadlessSink(), firstSeq);
			await drain(r);
			expect(prompts[1]).toContain("RT-BODY-BBB");

			// An ordinary input reusing the skill message's id: ownership
			// rides the durable seq, so the old invocation stays a marker.
			const ordinary = {
				id: skill.id,
				role: "user",
				parts: [{ type: "text", text: "just text" }],
			} as unknown as UIMessage;
			r.runtime.submit(r.conv, ordinary, new HeadlessSink());
			await drain(r);
			const secondSeq = r.store.lastUserSeq(r.conv.id)!;
			expect(secondSeq).not.toBe(firstSeq);
			expect(prompts[2]).toContain("[skill: rtdemo]");
			expect(prompts[2]).not.toContain("RT-BODY-AAA");
			expect(prompts[2]).not.toContain("RT-BODY-BBB");

			const row = r.store.db
				.query<{ run_id: string }, [number]>(
					"SELECT run_id FROM turn_runs WHERE anchor_seq = ?",
				)
				.get(secondSeq);
			expect(row).not.toBeNull();
			expect(journal.get(row!.run_id)!.ownedInputSeqs).toEqual([secondSeq]);
			expect(journal.get(row!.run_id)!.ownedInputSeqs).not.toContain(firstSeq);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a folded steer owns only its own durable seq — same message id, no history bleed", async () => {
		const home = useHome("goblin-rt-steer-");
		mkdirSync(join(home, "workspace/skills/rtdemo"), { recursive: true });
		writeFileSync(
			join(home, "workspace/skills/rtdemo/SKILL.md"),
			"---\nname: rtdemo\ndescription: d\n---\nSTEER-SKILL-UNIQUE",
		);
		const entered = deferred<void>();
		const release = deferred<void>();
		const probe = tool({
			description: "probe",
			inputSchema: z.object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return "probe-result";
			},
		});
		const { model, streamCalls } = scriptedEdge([
			[toolCallPart("call-1", "probe", "{}"), finishPart("tool-calls")],
			textParts("done"),
			textParts("next"),
		]);
		const prompt = (i: number): string => JSON.stringify(streamCalls[i]!.prompt);
		const store = openStore(tmpDb("goblin-rt-sj-"));
		const journal = openTurnJournal(store.db);
		const r = rig({ model, store, tools: { probe }, deps: { turnJournal: journal } });
		try {
			// A historical invocation — the SAME app id as the steer will
			// carry, but a different durable seq.
			const historical: UIMessage = {
				id: "reused",
				role: "user",
				parts: [
					{ type: "data-skill", data: { name: "rtdemo" } },
					{ type: "text", text: "old invoke" },
				],
			} as UIMessage;
			r.store.append(r.conv.id, [historical]);
			const historicalSeq = r.store.lastUserSeq(r.conv.id)!;
			r.store.append(
				r.conv.id,
				[{ id: "a0", role: "assistant", parts: [{ type: "text", text: "prior" }] } as UIMessage],
				{ anchorSeq: historicalSeq },
			);
			const head = new RecordingSink();
			r.runtime.submit(r.conv, userMessage([{ type: "text", text: "head" }]), head);
			const headSeq = r.store.lastUserSeq(r.conv.id)!;
			await entered.promise;
			const steer = new RecordingSink();
			r.runtime.submit(
				r.conv,
				{
					id: "reused",
					role: "user",
					parts: [
						{ type: "data-skill", data: { name: "rtdemo" } },
						{ type: "text", text: "steered invoke" },
					],
				} as UIMessage,
				steer,
			);
			const steerSeq = r.store.lastUserSeq(r.conv.id)!;
			release.resolve();
			await Promise.all([head.done, steer.done]);
			await drain(r);
			// Step 1's prompt: the historical skill is a marker only —
			// a duplicate id cannot re-own it.
			expect(prompt(0)).toContain("[skill: rtdemo]");
			expect(prompt(0)).not.toContain("STEER-SKILL-UNIQUE");
			expect(r.store.history(r.conv.id)[0]!.id).toBe("reused");
			expect(historicalSeq).not.toBe(steerSeq);
			// Step 2 folded the steer: its body rides THIS owning turn — exactly once.
			expect(prompt(1).split("STEER-SKILL-UNIQUE").length).toBe(2);
			expect(prompt(1)).toContain("steered invoke");
			const run = r.store.db
				.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs")
				.all();
			expect(run).toHaveLength(1);
			expect(journal.get(run[0]!.run_id)!.ownedInputSeqs).toEqual([headSeq, steerSeq]);
			expect(journal.get(run[0]!.run_id)!.steerMark).toBe(steerSeq);
			// A later ordinary turn: marker only, body never re-injected.
			r.runtime.submit(r.conv, userMessage([{ type: "text", text: "later" }]), new HeadlessSink());
			await drain(r);
			expect(prompt(2)).toContain("[skill: rtdemo]");
			expect(prompt(2)).not.toContain("STEER-SKILL-UNIQUE");
		} finally {
			release.resolve();
			await r.runtime.shutdown();
			r.store.close();
		}
	});
	test("a folded steer becomes the durable source; a still-queued input never does", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const gate = tool({
			description: "held",
			inputSchema: z.object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return "done";
			},
		});
		const edge = scriptedEdge([
			[toolCallPart("c1", "probe", "{}"), finishPart("tool-calls")],
			textParts("done"),
			textParts("queued answer"),
		]);
		const store = openStore(tmpDb("goblin-rt-src-"));
		const journal = openTurnJournal(store.db);
		const r = rig({
			model: edge.model,
			store,
			tools: { probe: gate },
			deps: { turnJournal: journal },
		});
		try {
			r.runtime.submit(r.conv, userMessage([{ type: "text", text: "head" }]), new HeadlessSink());
			const headSeq = r.store.lastUserSeq(r.conv.id)!;
			await entered.promise;
			r.runtime.submit(r.conv, userMessage([{ type: "text", text: "steer" }]), new HeadlessSink());
			const steerSeq = r.store.lastUserSeq(r.conv.id)!;
			const queued = new RecordingSink();
			r.runtime.submit(r.conv, userMessage([{ type: "text", text: "queued" }]), queued);
			const queuedSeq = r.store.lastUserSeq(r.conv.id)!;
			release.resolve();
			await drain(r);
			const runs = r.store.db
				.query<{ run_id: string; source_input_seq: number | null }, []>(
					"SELECT run_id, source_input_seq FROM turn_runs ORDER BY rowid",
				)
				.all();
			expect(runs).toHaveLength(2);
			expect(runs[0]!.source_input_seq).toBe(steerSeq);
			expect(runs[0]!.source_input_seq).not.toBe(headSeq);
			expect(runs[0]!.source_input_seq).not.toBe(queuedSeq);
			expect(runs[1]!.source_input_seq).toBe(queuedSeq);
		} finally {
			release.resolve();
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a forget landing mid-call fences the turn's late window record", async () => {
		const store = openStore(tmpDb("goblin-rt-win-"));
		const windows = openWindowCapture(store.db);
		const entered = deferred<void>();
		const release = deferred<void>();
		const prompts: string[] = [];
		const inner = fakeModel(["a", "b"], {
			beforeDelta: async (_d, i) => {
				if (i === 1) {
					entered.resolve();
					await release.promise;
				}
			},
		}) as unknown as {
			doStream(o: { prompt: unknown }): { stream: ReadableStream<LanguageModelV4StreamPart> };
		};
		const model = {
			...inner,
			doStream(o: { prompt: unknown }) {
				prompts.push(JSON.stringify(o.prompt));
				return inner.doStream(o);
			},
		} as unknown as LanguageModel;
		const recalled = "the operator's cat is named ORION-9z7w";
		const deleted: string[] = [];
		const memoryClient = {
			target: "a".repeat(64),
			async recall() {
				return [{ id: "f-1", text: recalled, document_id: "exchange/dm:1/1/a" }];
			},
			async operation() {
				return null;
			},
			async deleteDocument(id: string) {
				deleted.push(id);
			},
		};
		const r = rig({
			model,
			store,
			deps: {
				recordWindow: (id, input) => windows.record(id, input),
				windowVersion: () => windows.version(),
				memory: {
					client: memoryClient as unknown as HindsightClient,
					config: memoryConfigSchema.parse({
						baseUrl: "http://127.0.0.1:1",
						bankId: "g",
					}),
					contexts: store.memoryContexts,
					noteRecall: () => {},
				},
			},
		});
		try {
			const sink = submit(r, "hi");
			await entered.promise;
			expect(prompts[0]).toContain(recalled);
			const result = await forgetDocument(
				{
					client: memoryClient,
					contexts: store.memoryContexts,
					queue: store.memoryQueue,
					withWorkerPaused: (fn) => fn(),
					settleTiming: { pollMs: 5, budgetMs: 2_000 },
				},
				"exchange/dm:1/1/a",
				{ channel: "app", conversation: r.conv.id },
			);
			expect(result.outcome).toBe("forgotten");
			expect(result.outcome === "forgotten" ? result.redacted : 0).toBe(1);
			expect(deleted).toEqual(["exchange/dm:1/1/a"]);
			expect(windows.version()).toBe(1);
			release.resolve();
			expect(await sink.done).toEqual({ kind: "completed" });
			await drain(r);
			expect(windows.read(r.conv.id)).toBeNull();
		} finally {
			release.resolve();
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("an unreadable recall version disables capture for the attempt, never the turn", async () => {
		const store = openStore(tmpDb("goblin-rt-win-"));
		const windows = openWindowCapture(store.db);
		let recorded = 0;
		const r = rig({
			model: fakeModel(["still answers"]),
			store,
			deps: {
				recordWindow: (id, input) => {
					recorded++;
					windows.record(id, input);
				},
				windowVersion: () => {
					throw new Error("synthetic version read failure");
				},
			},
		});
		try {
			const sink = submit(r, "hi");
			expect(await sink.done).toEqual({ kind: "completed" });
			await drain(r);
			expect(recorded).toBe(0);
			expect(windows.read(r.conv.id)).toBeNull();
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});
});
const roles = (r: Rig) => r.store.history(r.conv.id).map((m) => m.role);
const stop = (r: Rig) => r.runtime.stop(r.conv.id);

// prompts = each call's JSON.stringify'd prompt; requests = the whole
// options object.
function scripted(attempts: StreamAttempt[], opts: { extra?: StreamAttempt } = {}) {
	const edge = scriptedEdge(attempts, { ...(opts.extra ? { extra: opts.extra } : {}) });
	return {
		model: edge.model,
		get prompts() {
			return edge.streamCalls.map((c) => JSON.stringify(c.prompt));
		},
		get requests() {
			return edge.streamCalls.map((c) => JSON.stringify(c));
		},
		calls: edge.streamCalls,
	};
}

async function capturedLog(
	fn: (logFile: string) => Promise<void>,
): Promise<Record<string, unknown>[]> {
	const logFile = join(tmpDir("goblin-rt-log-"), "goblin.log");
	setLogFile(logFile);
	try {
		await fn(logFile);
	} finally {
		setLogFile(null);
	}
	return readFileSync(logFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("provider-filter retry", () => {
	// Verbatim Telegram warning supplied by the operator. These scripted
	// model-edge failures exercise SDK recovery, not an assumed z.ai envelope.
	const warning =
		"[System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation.][20261005061517b57fc824";
	const answer = (text = "Recovered answer"): LanguageModelV4StreamPart[] => [
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: text },
		{ type: "text-end", id: "text" },
		finishPart("stop", 10),
	];
	const call = toolCallPart("call", "probe");
	const blocked: LanguageModelV4StreamPart = { type: "error", error: new Error(warning) };
	const completed = async (r: Rig, sink: RecordingSink) => {
		expect(await sink.done).toEqual({ kind: "completed" });
		await drain(r);
		await r.runtime.shutdown();
	};

	for (const [name, failure] of [
		["SSE error chunk", [blocked]],
		["HTTP rejection", new Error(warning)],
		["stream read rejection", { readError: new Error(warning) }],
		["content-filter finish reason", [finishPart("content-filter", 10)]],
	] satisfies [string, StreamAttempt][]) {
		test(`${name}: retries identical request, hides first error from both delivery hooks and history`, async () => {
			const s = scripted([failure, answer()]);
			const r = rig({ model: s.model });
			const sink = submit(r, "Discuss German politics");
			await completed(r, sink);
			expect(s.requests).toHaveLength(2);
			expect(s.requests[0]).toBe(s.requests[1]);
			expect(sink.text).toBe("Recovered answer");
			expect(sink.chunkTypes).not.toContain("error");
			expect(JSON.stringify(r.store.history(r.conv.id))).not.toContain(warning);
			expect(r.store.history(r.conv.id)).toHaveLength(2);
			r.store.close();
		});
	}

	test("preserves earlier tool results and never executes tools from the blocked attempt", async () => {
		const s = scripted([
			[call, finishPart("tool-calls", 10)],
			[toolCallPart("blocked-call", "probe"), blocked],
			answer(),
		]);
		let executions = 0;
		const r = rig({
			model: s.model,
			addr: appAddress("filter-retry"),
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: () => {
						executions++;
						return { result: "already completed" };
					},
				}),
			},
		});
		const sink = submit(r, "Do the action then answer");
		await completed(r, sink);
		expect(executions).toBe(1);
		expect(s.requests).toHaveLength(3);
		expect(s.requests[1]).toBe(s.requests[2]);
		expect(s.requests[2]).toContain("already completed");
		expect(sink.chunkTypes).not.toContain("error");
		expect(JSON.stringify(r.store.history(r.conv.id))).not.toContain("blocked-call");
		r.store.close();
	});

	test("chunked tool input completes the turn instead of leaving the sink running forever", async () => {
		const s = scripted([
			[
				{ type: "tool-input-start", id: "call", toolName: "probe" },
				{ type: "tool-input-delta", id: "call", delta: "{" },
				{ type: "tool-input-delta", id: "call", delta: "}" },
				{ type: "tool-input-end", id: "call" },
				call,
				finishPart("tool-calls", 10),
			],
			answer(),
		]);
		let executions = 0;
		const r = rig({
			model: s.model,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: () => {
						executions++;
						return { ok: true };
					},
				}),
			},
		});
		const sink = submit(r, "Use the tool then answer");
		await completed(r, sink);
		expect(executions).toBe(1);
		expect(s.requests).toHaveLength(2);
		expect(sink.text).toBe("Recovered answer");
		expect(r.store.history(r.conv.id)).toHaveLength(2);
		r.store.close();
	}, 3_000);

	test("a second filter later in the turn exhausts the retry budget and saves no failed reply", async () => {
		const s = scripted([
			[blocked],
			[call, finishPart("tool-calls", 10)],
			[finishPart("content-filter", 10)],
		]);
		const r = rig({
			model: s.model,
			tools: { probe: tool({ inputSchema: z.object({}), execute: () => "done" }) },
		});
		const sink = submit(r, "test");
		expect(await sink.done).toEqual({
			kind: "error",
			message: "Provider blocked this request again after one retry.",
			// One provider call spent — only the probe step produced
			// work; each filter block's stream died on its error part
			// before any step output.
			modelCalls: 1,
			transient: false,
		});
		await drain(r);
		await r.runtime.shutdown();
		expect(s.requests).toHaveLength(3);
		expect(sink.chunkTypes.filter((type) => type === "error")).toHaveLength(1);
		expect(r.store.history(r.conv.id)).toHaveLength(1);
		r.store.close();
	});

	test("ordinary assistant refusal text is an answer, not a retry signal", async () => {
		const s = scripted([answer(warning)]);
		const r = rig({ model: s.model });
		const sink = submit(r, "test");
		await completed(r, sink);
		expect(s.requests).toHaveLength(1);
		expect(sink.text).toBe(warning);
		r.store.close();
	});

	for (const [name, error] of [
		["plain error", blocked.error],
		["nested error", { error: { message: warning } }],
		["nested response error", { response: { error: { message: warning } } }],
	] satisfies [string, unknown][])
		test(`two blocked attempts (${name}) cannot expose their tool calls`, async () => {
			const failure: LanguageModelV4StreamPart = { type: "error", error };
			const s = scripted([
				[call, failure],
				[call, failure],
			]);
			let executions = 0;
			const r = rig({
				model: s.model,
				tools: {
					probe: tool({
						inputSchema: z.object({}),
						execute: () => {
							executions++;
							return "done";
						},
					}),
				},
			});
			const sink = submit(r, "test");
			expect((await sink.done).kind).toBe("error");
			await drain(r);
			await r.runtime.shutdown();
			expect(s.requests).toHaveLength(2);
			expect(executions).toBe(0);
			expect(sink.chunkTypes).not.toContain("tool-input-available");
			r.store.close();
		});

	test("cancellation cleanup failure is logged without replacing the filter retry", async () => {
		const s = scripted([{ cancelError: new Error("cancel failed"), parts: [blocked] }, answer()]);
		const r = rig({ model: s.model });
		const sink = submit(r, "test");
		await completed(r, sink);
		expect(s.requests).toHaveLength(2);
		expect(sink.text).toBe("Recovered answer");
		expect(sink.chunkTypes).not.toContain("error");
		r.store.close();
	});

	test("ordinary retryable HTTP failures retain the existing SDK retry policy", async () => {
		const s = scripted([
			new APICallError({
				message: "Service unavailable",
				url: "https://provider.invalid/responses",
				requestBodyValues: {},
				statusCode: 503,
				isRetryable: true,
			}),
			answer(),
		]);
		const r = rig({ model: s.model });
		const sink = submit(r, "test");
		await completed(r, sink);
		expect(s.requests).toHaveLength(2);
		expect(sink.chunkTypes).not.toContain("error");
		r.store.close();
	});

	test("stop during filter cleanup prevents a second model request", async () => {
		const cleaning = deferred<void>();
		const gate = deferred<void>();
		const edge = scriptedEdge([
			{
				drive: ({ enqueue }) => enqueue(blocked),
				cancel: async () => {
					cleaning.resolve();
					await gate.promise;
				},
			},
		]);
		const r = rig({ model: edge.model, addr: appAddress("filter-cleanup") });
		const sink = submit(r, "test");
		await cleaning.promise;
		r.runtime.stop(r.conv.id);
		gate.resolve();
		expect(await sink.done).toEqual({ kind: "fenced" });
		await drain(r);
		await r.runtime.shutdown();
		expect(edge.streamCalls).toHaveLength(1);
		expect(sink.chunkTypes).not.toContain("error");
		expect(r.store.history(r.conv.id)).toHaveLength(1);
		r.store.close();
	});

	test("a late filter preserves already-streamed text, without exposing the filter error", async () => {
		const s = scripted([
			[
				{ type: "text-start", id: "partial" },
				{ type: "text-delta", id: "partial", delta: "Partial answer. " },
				finishPart("content-filter", 10),
			],
			answer(),
		]);
		const r = rig({ model: s.model, addr: appAddress("late-filter") });
		const sink = submit(r, "test");
		await completed(r, sink);
		expect(s.requests).toHaveLength(2);
		expect(s.requests[0]).toBe(s.requests[1]);
		expect(sink.text.replace(/\s+/g, " ").trim()).toBe("Partial answer. Recovered answer");
		expect(sink.chunkTypes).not.toContain("error");
		// UI history is what the operator actually saw, including the partial.
		expect(JSON.stringify(r.store.history(r.conv.id))).toContain("Partial answer.");
		expect(JSON.stringify(r.store.history(r.conv.id))).not.toContain("Provider content filter");
		r.store.close();
	});

	test("stop while a rejected call is pending prevents its retry", async () => {
		const started = deferred<void>();
		const gate = deferred<void>();
		const edge = scriptedEdge([new Error(warning)]);
		const inner = edge.model as unknown as {
			doStream(o: never): Promise<unknown>;
		};
		const slowModel = {
			...inner,
			async doStream(o: never) {
				started.resolve();
				await gate.promise;
				return inner.doStream(o);
			},
		} as unknown as LanguageModel;
		const r = rig({ model: slowModel });
		const sink = submit(r, "test");
		await started.promise;
		r.runtime.stop(r.conv.id);
		gate.resolve();
		expect(await sink.done).toEqual({ kind: "fenced" });
		await drain(r);
		await r.runtime.shutdown();
		expect(edge.streamCalls).toHaveLength(1);
		expect(sink.text).toBe("");
		expect(r.store.history(r.conv.id)).toHaveLength(1);
		r.store.close();
	});
});

describe("turn authority", () => {
	test("clean turn completes and persists the assistant message", async () => {
		const r = rig({ deltas: ["hello", " world"], delayMs: 5 });
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("hello world");
		expect(roles(r)).toEqual(["user", "assistant"]);
		r.store.close();
	});

	test("epoch advance mid-turn fences it — quietly, no assistant append", async () => {
		const gated = pauseFakeModelAtDelta(["a", "b", "c", "d", "e"], 1);
		const r = rig({ model: gated.model });
		const sink = submit(r, "hi");
		await sink.firstDelta; // first delta observed — turn is mid-stream
		await gated.entered; // the next delta is held inside the provider stream
		r.store.bumpEpoch(r.conv.id); // settings change, e.g. /think
		gated.release();
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(sink.text.length).toBeGreaterThan(0);
		expect(sink.text.length).toBeLessThan(5);
		// the fenced turn must not write assistant output into history
		expect(roles(r)).toEqual(["user"]);
		r.store.close();
	});

	test("a settings fence aborts the provider stream, not just the turn loop", async () => {
		let seen: AbortSignal | undefined;
		const gated = pauseFakeModelAtDelta(["a", "b", "c", "d", "e"], 1);
		const base = gated.model as unknown as {
			doStream(o: { abortSignal?: AbortSignal }): unknown;
		};
		const model = {
			...base,
			doStream(o: { abortSignal?: AbortSignal }) {
				seen = o.abortSignal;
				return base.doStream(o);
			},
		} as unknown as LanguageModel;
		const r = rig({ model });
		const sink = submit(r, "hi");
		await sink.firstDelta; // mid-stream
		await gated.entered; // the next delta is held inside the provider stream
		r.store.bumpEpoch(r.conv.id); // /voice or /memory toggle — no /stop, no abort
		gated.release();
		expect(await sink.done).toEqual({ kind: "fenced" });
		// the fence must kill the model call itself: the provider stream
		// cannot keep generating into a stream nobody reads
		expect(seen?.aborted).toBe(true);
		r.store.close();
	});

	test("/stop aborts and drains the queue", async () => {
		const r = rig({ deltas: ["x", "y", "z", "w"], delayMs: 30 });
		const sink = submit(r, "hi");
		await sink.firstDelta; // mid-stream
		stop(r);
		expect((await sink.done).kind).toBe("fenced");
		r.store.close();
	});

	test("post-commit cancellation requires the committed fence and does not advance it again", async () => {
		const r = rig({ deltas: ["a", "b", "c", "d"], delayMs: 20 });
		const sink = submit(r, "hi");
		await sink.firstDelta;
		expect(() => r.runtime.cancelFenced(r.conv.id, 0)).toThrow("committed epoch");
		expect(() => r.runtime.cancelFenced(r.conv.id, 1)).toThrow("committed epoch");
		const epoch = r.store.bumpEpoch(r.conv.id);
		expect(r.runtime.cancelFenced(r.conv.id, epoch).stopped).toBe(true);
		expect(r.store.get(r.conv.id)?.epoch).toBe(epoch);
		expect(await sink.done).toEqual({ kind: "fenced" });
		await r.runtime.shutdown();
		expect(roles(r)).toEqual(["user"]);
		r.store.close();
	});

	test("/stop notifies queued turns — every sink gets exactly one onDone", async () => {
		const r = rig({ deltas: ["a", "b", "c", "d"], delayMs: 30 });
		const s1 = submit(r, "one");
		await s1.firstDelta; // first turn is mid-stream
		const s2 = submit(r, "two"); // queued
		const { stopped, settled } = stop(r);
		expect(stopped).toBe(true);
		// the dropped turn's sink is still told, so it can release resources
		expect(await s2.done).toEqual({ kind: "fenced" });
		expect((await s1.done).kind).toBe("fenced");
		await settled;
		r.store.close();
	});

	test("/stop reports nothing-running on an idle lane — epoch still bumps", async () => {
		const r = rig({ deltas: ["a"], delayMs: 30 });
		expect(stop(r).stopped).toBe(false);
		// The bump is harmless — and any turn admitted next captures it.
		expect(r.store.get(r.conv.id)!.epoch).toBe(1);
		const sink = submit(r, "hi");
		await sink.firstDelta; // admitted and mid-stream
		expect(stop(r).stopped).toBe(true);
		r.store.close();
	});

	test("stop().settled resolves only after the dropped sinks' onDone settles", async () => {
		const r = rig({ deltas: ["a", "b", "c", "d"], delayMs: 30 });
		const running = submit(r, "one");
		await running.firstDelta; // first turn is mid-stream
		// A queued sink whose onDone does a slow final flush.
		let flushed = false;
		const flush = new Promise<void>((r) =>
			setTimeout(() => {
				flushed = true;
				r();
			}, 40),
		);
		submit(r, "two", {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone: async () => {
				await flush;
			},
		});
		const { settled } = stop(r);
		let settledDone = false;
		void settled.then(() => {
			settledDone = true;
		});
		await sleep(15); // stop has run; the flush has not finished
		expect(flushed).toBe(false);
		expect(settledDone).toBe(false);
		await settled;
		expect(flushed).toBe(true);
		expect(settledDone).toBe(true);
		r.store.close();
	});

	test("a finished lane does not report stoppable turns", async () => {
		const r = rig({ deltas: ["a"], delayMs: 5 });
		const sink = submit(r, "hi");
		await sink.done;
		await drain(r);
		expect(stop(r).stopped).toBe(false);
		r.store.close();
	});

	test("shutdown fences every lane and resolves after the sinks' onDone", async () => {
		const r = rig({ deltas: ["a", "b", "c", "d", "e"], delayMs: 20 });
		const conv2 = r.store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const s1 = submit(r, "one");
		const s2 = new RecordingSink();
		r.runtime.submit(conv2, userMessage([{ type: "text", text: "two" }]), s2);
		await Promise.all([s1.firstDelta, s2.firstDelta]); // both turns mid-stream
		await r.runtime.shutdown();
		expect(await s1.done).toEqual({ kind: "fenced" });
		expect(await s2.done).toEqual({ kind: "fenced" });
		// fenced turns commit no assistant output
		expect(roles(r)).toEqual(["user"]);
		expect(r.store.history(conv2.id).map((m) => m.role)).toEqual(["user"]);
		r.store.close();
	});

	test("a submit after shutdown lands in history but never runs", async () => {
		const r = rig({ deltas: ["a"], delayMs: 5 });
		await r.runtime.shutdown();
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "fenced" });
		await sleep(50); // prove no turn ever starts
		expect(sink.text).toBe("");
		expect(roles(r)).toEqual(["user"]);
		r.store.close();
	});

	test("a tool call under stale authority never executes", async () => {
		let executed = false;
		// The stream holds its tool-call part on a gate the test releases
		// after the epoch bump — the call is emitted entirely under the
		// stale epoch, by construction, not by clock.
		const bumpLanded = deferred<void>();
		const edge = scriptedEdge([
			{
				drive: async ({ enqueue, close }) => {
					enqueue({ type: "stream-start", warnings: [] });
					await bumpLanded.promise;
					enqueue(toolCallPart("c1", "probe"));
					enqueue(finishPart("tool-calls"));
					close();
				},
			},
		]);
		const r = rig({
			model: edge.model,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executed = true;
						return { ok: true };
					},
				}),
			},
		});
		const sink = submit(r, "hi");
		await sink.admitted; // turn holds its epoch — bump cannot race admission
		r.store.bumpEpoch(r.conv.id); // settings change mid-turn
		bumpLanded.resolve(); // only now may the stale-epoch tool call flow
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(executed).toBe(false); // the fenced tool's side effect never ran
		r.store.close();
	});

	test("queued turns run serially", async () => {
		const r = rig({ deltas: ["r"], delayMs: 10 });
		const s1 = submit(r, "one");
		const s2 = submit(r, "two");
		await Promise.all([s1.done, s2.done]);
		expect(r.store.history(r.conv.id).filter((m) => m.role === "user")).toHaveLength(2);
		r.store.close();
	});

	test("submits queued behind a running turn coalesce into ONE successor turn", async () => {
		const { model, prompts } = recordingModel(["answer"], 30);
		const r = rig({ model });
		const s1 = submit(r, "2+2?");
		await s1.firstDelta; // turn 1 mid-stream — its admission snapshot is taken
		const s2 = submit(r, "2+5?");
		const s3 = submit(r, "2+8?");
		// Two queued submits, one successor turn — every sink still gets
		// exactly one onDone.
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(2); // two model calls for three submits
		// The streaming sink is the first queued one; the rest get the
		// outcome and nothing else.
		expect(s2.text).toBe("answer");
		expect(s3.text).toBe("");
		// The second call's context tells the true story: the first
		// answer sits right after its question, and the queued burst
		// reads as ONE user message, not turns the reply already saw.
		const wire = JSON.parse(prompts[1]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		const msgs = wire.filter((m) => m.role !== "system");
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(msgs[0]!.content.map((c) => c.text)).toEqual(["2+2?"]);
		expect(msgs[1]!.content.map((c) => c.text)).toEqual(["answer"]);
		expect(msgs[2]!.content.map((c) => c.text)).toEqual(["2+5?", "2+8?"]);
		r.store.close();
	});

	test("a history system event reaches the model as a bracketed user-role note", async () => {
		// The reviewer lands its save note in history as role "system".
		// The SDK's streamText rejects system messages in `messages`, so
		// the runtime renders the event as a user-role note in position —
		// the stored role is untouched.
		const event =
			"proposed skill: talk-first — parked in skills-proposed/talk-first/, not installed; " +
			"an operator approval means moving it into skills/, a discard means deleting the proposal";
		const { model, prompts } = recordingModel(["answer"], 5);
		const r = rig({ model, step: { system: "test instructions" } });
		r.store.append(r.conv.id, [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "earlier question" }] },
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "earlier answer" }] },
			{ id: "sys1", role: "system", parts: [{ type: "text", text: event }] },
		]);
		const sink = submit(r, "what did you save?");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts).toHaveLength(1);
		const wire = JSON.parse(prompts[0]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		// The only system-role entry on the wire is `instructions` — the
		// frozen per-conversation prefix the fake provider sees as one
		// system prompt item.
		expect(wire.filter((m) => m.role === "system")).toHaveLength(1);
		const msgs = wire.filter((m) => m.role !== "system");
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		// The event merges with the trailing user submit: the bracketed
		// note leads the merged message's content, the submit follows.
		expect(msgs[2]!.content.map((c) => c.text)).toEqual([
			`[system event: ${event}]`,
			"what did you save?",
		]);
		// History on disk keeps the system role — the mapping is
		// render-only, at the conversion boundary.
		expect(roles(r)).toEqual(["user", "assistant", "system", "user", "assistant"]);
		r.store.close();
	});

	test("distinct text parts stream with a seam — blocks must not fuse in the bubble", async () => {
		// A multi-step turn (text, tool call, more text) emits several text
		// parts. The chat bubble must show them as blocks, not one run-on —
		// "yo 👋 what's up" + "Workspace…" streamed as "upWorkspace" once.
		const edge = scriptedEdge([
			[
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "yo 👋 what's up" },
				{ type: "text-end", id: "t1" },
				{ type: "text-start", id: "t2" },
				{ type: "text-delta", id: "t2", delta: "Workspace is basically fresh" },
				{ type: "text-end", id: "t2" },
				finishPart("stop", 1, 2),
			],
		]);
		const r = rig({ model: edge.model });
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("yo 👋 what's up\n\nWorkspace is basically fresh");
		r.store.close();
	});

	test("a two-step turn streams its blocks with seams — even when step 2 reuses step 1's part id", async () => {
		// The real shape: text + tool call in step 1, tool executes, text
		// continues in step 2. Providers synthesizing part ids per request
		// can hand step 2 the SAME id ("t1") — the seam must survive that,
		// so the step boundary itself has to reset the tracker.
		const textBit = (delta: string): LanguageModelV4StreamPart[] => [
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", delta },
			{ type: "text-end", id: "t1" },
		];
		const edge = scriptedEdge([
			[
				{ type: "stream-start", warnings: [] },
				...textBit("yo 👋 what's up"),
				toolCallPart("c1", "probe"),
				finishPart("tool-calls"),
			],
			// Same id as step 1 — deliberate.
			[
				{ type: "stream-start", warnings: [] },
				...textBit("Workspace is basically fresh"),
				finishPart("stop"),
			],
		]);
		let executed = false;
		const r = rig({
			model: edge.model,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executed = true;
						return { ok: true };
					},
				}),
			},
		});
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(executed).toBe(true); // step 2 really ran — this is the real shape
		expect(sink.text).toBe("yo 👋 what's up\n\nWorkspace is basically fresh");
		r.store.close();
	});

	test("a failed model stream reports error — no silent completion, no partial append", async () => {
		const edge = scriptedEdge([
			[
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "partial" },
				{ type: "error", error: new Error("provider blew up") },
			],
		]);
		const r = rig({ model: edge.model });
		const sink = submit(r, "hi");
		const d = await sink.done;
		expect(d.kind).toBe("error");
		expect((d as { message: string }).message).toContain("provider blew up");
		// the failed turn must not commit its partial assistant output
		expect(roles(r)).toEqual(["user"]);
		r.store.close();
	});

	test("an attachment part the model can't consume degrades to its path reference", async () => {
		const { model, prompts } = recordingModel(["ok"], 5);
		const r = rig({ model }); // no inputModalities → text-only
		// Stored intake record: path + metadata, no payload.
		r.store.append(r.conv.id, [
			{
				id: "u1",
				role: "user",
				parts: [
					{
						type: "data-attachment",
						data: {
							path: "/gone/x.png",
							mediaType: "image/png",
							filename: "x.png",
							size: 10,
						},
					},
				],
			},
		]);
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts[0]).toContain("[attachment: /gone/x.png");
		expect(prompts[0]).not.toContain("data:image/png");
		r.store.close();
	});

	test("an attachment part materializes inline for a capable model", async () => {
		const dir = tmpDir("goblin-rt-att-");
		const f = join(dir, "x.png");
		writeFileSync(f, "pngdata");
		const { model, prompts } = recordingModel(["ok"], 5);
		const r = rig({ model, step: { inputModalities: new Set(["text", "image"]) } });
		r.store.append(r.conv.id, [
			{
				id: "u1",
				role: "user",
				parts: [
					{
						type: "data-attachment",
						data: { path: f, mediaType: "image/png", filename: "x.png", size: 7 },
					},
				],
			},
		]);
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(prompts[0]).toContain("image/png");
		expect(prompts[0]).not.toContain("[attachment:");
		r.store.close();
	});

	test("a throwing sink still gets exactly one onDone", async () => {
		const r = rig({ deltas: ["a"], delayMs: 5 });
		let calls = 0;
		submit(r, "hi", {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {
				calls++;
				throw new Error("sink blew up");
			},
		});
		await waitUntil(() => calls >= 1, "onDone called");
		await drain(r);
		expect(calls).toBe(1);
		r.store.close();
	});
});

// A provider-side context overflow: the OpenAI wording over a 400
// APICallError — the shape a provider actually throws out of doStream.
function overflowError(): APICallError {
	return new APICallError({
		message:
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
		url: "https://api.openai.com/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 400,
	});
}

// Enough completed exchanges that chooseBoundary has a span to fold.
function seedExchanges(store: Store, convId: string): void {
	const big = "x".repeat(600);
	for (let i = 0; i < 3; i++) {
		store.append(convId, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
		store.append(
			convId,
			[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
			{ anchorSeq: store.lastUserSeq(convId) },
		);
	}
}

describe("context overflow recovery", () => {
	test("an overflow on the first call compacts and resumes — one stored reply", async () => {
		const s = scripted([overflowError(), textParts("the answer")], { extra: textParts("ok") });
		const summaries: string[] = [];
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async (_conv, _system, prompt) => {
						summaries.push(prompt);
						return "the folded era";
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "live question");
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(sink.text).toBe("the answer");
		// Exactly one compaction ran; the resumed call read the compacted
		// view — summary carried first, the live question kept in the tail.
		expect(summaries).toHaveLength(1);
		expect(s.prompts).toHaveLength(2);
		expect(s.prompts[1]).toContain("the folded era");
		expect(s.prompts[1]).toContain("live question");
		// The held error never reached the client stream.
		expect(sink.chunkTypes).not.toContain("error");
		// One stored assistant reply — the failed attempt left nothing.
		const history = r.store.history(r.conv.id);
		expect(history.filter((m) => m.role === "assistant")).toHaveLength(4); // 3 seeded + this turn's
		const last = history.at(-1)!;
		expect(last.role).toBe("assistant");
		const lastText = last.parts.find((p) => p.type === "text") as { text: string } | undefined;
		expect(lastText?.text).toBe("the answer");
		r.store.close();
	});

	test("a mid-turn overflow resumes without re-running tools — one merged reply", async () => {
		const s = scripted(
			[
				[
					{ type: "stream-start", warnings: [] },
					toolCallPart("c1", "probe"),
					finishPart("tool-calls"),
				],
				overflowError(),
				textParts("the final answer"),
			],
			{ extra: textParts("ok") },
		);
		let executions = 0;
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return "probe-result-7f3a";
					},
				}),
			},
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => "folded past",
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "run the probe");
		expect(await sink.done).toEqual({ kind: "completed" });
		// The whole point of the continuation: the failed attempt's tool
		// work is never re-run.
		expect(executions).toBe(1);
		expect(s.prompts).toHaveLength(3);
		// The resumed prompt carries the failed attempt's tool result —
		// the model continues from where it died, not from scratch.
		expect(s.prompts[2]).toContain("probe-result-7f3a");
		// The held error never reached the wire, and every `start` chunk —
		// the failed attempt's and the resume's — names the ONE stored
		// message id: the resume continues the partial, it doesn't start
		// a sibling.
		expect(sink.chunkTypes).not.toContain("error");
		const stored = r.store.history(r.conv.id).at(-1)!;
		expect(stored.role).toBe("assistant");
		const starts = sink.chunks.filter((c) => c.type === "start");
		expect(starts.length).toBeGreaterThanOrEqual(2);
		for (const c of starts) {
			expect((c as { messageId?: string }).messageId).toBe(stored.id);
		}
		// ONE stored reply holds the completed tool part AND the answer.
		const types = stored.parts.map((p) => p.type);
		expect(types).toContain("tool-probe");
		expect(types).toContain("text");
		const text = stored.parts.find((p) => p.type === "text") as { text: string } | undefined;
		expect(text?.text).toBe("the final answer");
		expect(r.store.history(r.conv.id).filter((m) => m.role === "assistant")).toHaveLength(4);
		r.store.close();
	});

	test("an overflow with nothing left to compact ends with a plain message", async () => {
		const s = scripted([overflowError(), textParts("unreached")], { extra: textParts("ok") });
		let summarizeCalls = 0;
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => {
						summarizeCalls++;
						return "folded";
					},
				},
			},
		});
		const sink = submit(r, "hi");
		const done = await sink.done;
		expect(done.kind).toBe("error");
		if (done.kind !== "error") return;
		expect(done.message).toContain("nothing left to compact");
		expect(done.message.length).toBeLessThan(200);
		// No boundary was written, and the turn never re-asked the model.
		expect(summarizeCalls).toBe(0);
		expect(s.prompts).toHaveLength(1);
		r.store.close();
	});

	test("a second overflow on the resumed attempt ends the turn", async () => {
		const s = scripted([overflowError(), overflowError(), textParts("unreached")], {
			extra: textParts("ok"),
		});
		let summarizeCalls = 0;
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => {
						summarizeCalls++;
						return "folded past";
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "live question");
		const done = await sink.done;
		expect(done.kind).toBe("error");
		if (done.kind !== "error") return;
		expect(done.message).toContain("still full after compacting");
		expect(done.message.length).toBeLessThan(200);
		// One recovery per turn: one compaction, one resume call, no loop.
		expect(summarizeCalls).toBe(1);
		expect(s.prompts).toHaveLength(2);
		r.store.close();
	});

	test("a non-overflow provider error does not compact or resume", async () => {
		const auth = new APICallError({
			message: "Authentication Failed",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 401,
		});
		const s = scripted([auth, textParts("unreached")], { extra: textParts("ok") });
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => "folded",
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({
			kind: "error",
			message: "Authentication Failed",
			modelCalls: 0,
			transient: false,
		});
		expect(s.prompts).toHaveLength(1);
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("a mid-stream provider error leaves modelCalls at 0 — the retry ladder's precondition", async () => {
		// The error arrives as a stream part, not a doStream rejection —
		// the 200-then-SSE-error shape (upstream 429s) the scheduler's
		// zero-call retry ladder exists to re-fire.
		const s = scripted([[{ type: "error", error: new Error("Rate limit reached for requests") }]]);
		const r = rig({ model: s.model, step: { contextWindow: 1000 } });
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "hi");
		expect(await sink.done).toEqual({
			kind: "error",
			message: "Rate limit reached for requests",
			modelCalls: 0,
			transient: true,
		});
		expect(s.prompts).toHaveLength(1);
		r.store.close();
	});

	test("/stop during the overflow compaction fences the turn — no resume", async () => {
		const s = scripted([overflowError(), textParts("unreached")], { extra: textParts("ok") });
		// Gate the summary call so the stop lands mid-compaction: the
		// compact abort controller must end the attempt, never resume.
		const started = deferred<void>();
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: (_conv, _system, _prompt, signal) => {
						started.resolve();
						return signal.aborted
							? Promise.reject(new Error("summarize aborted"))
							: new Promise<string>(() => {});
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "live question");
		await started.promise;
		stop(r);
		expect(await sink.done).toEqual({ kind: "fenced" });
		// The compaction died with the stop; no resume call ever ran —
		// shutdown bounds every lane, so a resume would have had to run.
		await r.runtime.shutdown();
		expect(s.prompts).toHaveLength(1);
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("a store read failure after the resume claim settles the claimed joiner too (#114)", async () => {
		const s = scripted([overflowError(), textParts("not reached")], { extra: textParts("ok") });
		const started = deferred<void>();
		const gate = deferred<void>();
		const store = openStore(tmpDb("goblin-rt-"));
		// The store boundary breaks exactly at the resumed admission's
		// history read — after the resume claim already took the joiner.
		let failRead = false;
		const wrappedStore = new Proxy(store, {
			get(target, key) {
				if (key === "modelEntries")
					return (id: string) => {
						if (failRead) throw new Error("Synthetic SQLite read failure");
						return target.modelEntries(id);
					};
				return Reflect.get(target, key);
			},
		});
		const r = rig({
			model: s.model,
			step: { contextWindow: 1000 },
			store: wrappedStore,
			deps: {
				compaction: {
					modelRef: () => "fixture",
					contextWindow: () => 1000,
					summarize: async () => {
						started.resolve();
						await gate.promise;
						failRead = true;
						return "folded fixture history";
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const head = submit(r, "first");
		const joiner = new RecordingSink();
		let joinerSettled = false;
		joiner.done.then(() => {
			joinerSettled = true;
		});
		await started.promise;
		// Queued while the overflow compaction holds the lane; the resumed
		// admission claims it before reading history.
		submit(r, "joined during compact", joiner);
		gate.resolve();
		expect((await head.done).kind).toBe("error");
		// The claim must have put the joiner on a settlement surface: the
		// crash may not strand a claimed-but-untracked submit — its stream
		// would hang forever, shutdown included. Awaiting done is the proof.
		await joiner.done;
		expect(joinerSettled).toBe(true);
		// Unstamped: the crash died in admission, before the attempt's try —
		// drain's last-ditch settlement cannot know modelCalls/transient.
		expect(await joiner.done).toEqual({ kind: "error", message: "Synthetic SQLite read failure" });
		await r.runtime.shutdown();
		expect(r.runtime.busy(r.conv.id)).toBe(false);
		r.store.close();
	});
});

describe("cache stability", () => {
	// The request for turn N+1 is the request for turn N with new content
	// appended — bytes already sent are never rewritten. This is the
	// end-to-end guard: history out of SQLite, through materialization
	// and conversion, onto the wire.
	function prefixOf(request: string, count: number): string {
		const msgs = JSON.parse(request) as unknown[];
		return JSON.stringify(msgs.slice(0, count));
	}
	function messageCount(request: string): number {
		return (JSON.parse(request) as unknown[]).length;
	}

	test("turn N+1's request is turn N's request with content appended", async () => {
		const { model, prompts } = recordingModel(["hello world"], 5);
		const r = rig({ model });
		expect(await submit(r, "hi").done).toEqual({ kind: "completed" });
		expect(await submit(r, "again").done).toEqual({ kind: "completed" });
		expect(prompts.length).toBe(2);
		// The whole first request survives verbatim as the head of the
		// second — provider prefix caches stay valid across turns.
		expect(prefixOf(prompts[1]!, messageCount(prompts[0]!))).toBe(prompts[0]!);
		r.store.close();
	});

	test("inlined image bytes don't move when new media arrives later", async () => {
		const dir = tmpDir("goblin-rt-cache-");
		const a = join(dir, "a.png");
		const b = join(dir, "b.png");
		writeFileSync(a, "pngdata-a");
		writeFileSync(b, "pngdata-b");
		const { model, prompts } = recordingModel(["ok"], 5);
		const r = rig({ model, step: { inputModalities: new Set(["text", "image"]) } });
		const att = (f: string, name: string, size: number): UIMessage["parts"][number] => ({
			type: "data-attachment" as const,
			data: { path: f, mediaType: "image/png", filename: name, size },
		});
		const s1 = new RecordingSink();
		r.runtime.submit(
			r.conv,
			userMessage([att(a, "a.png", 9), { type: "text", text: "what is this" }]),
			s1,
		);
		expect(await s1.done).toEqual({ kind: "completed" });
		const s2 = new RecordingSink();
		r.runtime.submit(
			r.conv,
			userMessage([att(b, "b.png", 9), { type: "text", text: "and this" }]),
			s2,
		);
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(prompts.length).toBe(2);
		// The first photo's inlined bytes ride the head of the second
		// request unchanged — a new photo never re-decides an old one.
		expect(prefixOf(prompts[1]!, messageCount(prompts[0]!))).toBe(prompts[0]!);
		expect(prompts[0]!).toContain("image/png");
		expect(prompts[1]!).toContain("image/png");
		r.store.close();
	});

	test("window gauge and cached split land in the log", async () => {
		// One step, reporting a warm cache (700 of 900 input tokens cached)
		// against a 1000-token window — 90% utilization must warn.
		const edge = scriptedEdge([
			[...textParts("ok", 900).slice(0, -1), finishPart("stop", 900, 1, { read: 700 })],
		]);
		const r = rig({ model: edge.model, step: { contextWindow: 1000 } });
		const lines = await capturedLog(async () => {
			const sink = submit(r, "hi");
			expect(await sink.done).toEqual({ kind: "completed" });
		});
		const warn = lines.find(
			(l) => l.msg === "context window ≥80% — history is approaching the limit",
		);
		expect(warn).toMatchObject({ input: 900, limit: 1000, pct: 90 });
		const stepUsage = lines.find((l) => l.msg === "model step usage");
		expect(stepUsage).toMatchObject({
			inputTokens: 900,
			cacheReadTokens: 700,
			cacheWriteTokens: null,
			outputTokens: 1,
		});
		const completed = lines.find((l) => l.msg === "turn completed");
		expect(completed?.window).toEqual({ input: 900, limit: 1000, pct: 90 });
		expect(completed?.usage).toEqual({ input: 900, cacheRead: 700, cacheWrite: null, output: 1 });
		r.store.close();
	});

	test("a schema-rejected tool call leaves a trace in the log", async () => {
		// The Sep 28 outage class: a provider that cannot fill a tool
		// schema emits {} and the call dies in validation — before the
		// fix, nothing was logged and the only witness was the model.
		// read_file requires `path`; the model sent {}.
		const edge = scriptedEdge([
			[
				{ type: "stream-start", warnings: [] },
				toolCallPart("c1", "read_file"),
				finishPart("tool-calls"),
			],
			textParts("sorry"),
		]);
		const r = rig({
			model: edge.model,
			step: { contextWindow: 1000 },
			// The real read_file tool: its schema rejects {} at validation.
			tools: { read_file: readFileTool("/tmp") },
		});
		const lines = await capturedLog(async () => {
			const sink = submit(r, "read a file");
			expect(await sink.done).toEqual({ kind: "completed" });
		});
		const rejected = lines.find((l) => l.msg === "tool call rejected");
		expect(rejected).toMatchObject({ tool: "read_file", arg: "{}" });
		// The validation error names the missing field — the whole
		// diagnosis in one line.
		expect(String(rejected?.error)).toContain("path");
		// And the stop reason rides the completion line.
		expect(lines.find((l) => l.msg === "turn completed")?.finish).toBe("stop");
		r.store.close();
	});

	test("a throwing tool execute leaves a trace in the log", async () => {
		const edge = scriptedEdge([
			[
				{ type: "stream-start", warnings: [] },
				toolCallPart("c1", "boom"),
				finishPart("tool-calls"),
			],
			textParts("ok"),
		]);
		const r = rig({
			model: edge.model,
			step: { contextWindow: 1000 },
			tools: {
				boom: tool({
					description: "always throws",
					inputSchema: z.object({}),
					execute: async (): Promise<string> => {
						throw new Error("kapow");
					},
				}),
			},
		});
		const lines = await capturedLog(async () => {
			const sink = submit(r, "boom");
			expect(await sink.done).toEqual({ kind: "completed" });
		});
		const failed = lines.find((l) => l.msg === "tool execute failed");
		expect(failed).toMatchObject({ tool: "boom" });
		expect(String(failed?.error)).toContain("kapow");
		r.store.close();
	});

	test("a completed turn at ≥75% of the window compacts; below it does not", async () => {
		// Seed three big exchanges + the turn's own: the compactor must fold
		// the first three into a summary and keep the live one whole.
		const summaries: string[] = [];
		const r = rig({
			model: scriptedEdge([textParts("ok", 750)]).model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "zai/glm-5.3",
					contextWindow: () => 1000,
					summarize: async (_conv, _system, prompt) => {
						summaries.push(prompt);
						return "the folded era";
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "live question");
		expect(await sink.done).toEqual({ kind: "completed" });
		// The compaction runs in-lane AFTER the sinks are notified — done
		// resolving only means the reply landed. Poll for the pointer,
		// bounded, instead of a fixed sleep.
		await waitUntil(() => r.store.getCompaction(r.conv.id) !== null, "compaction pointer lands");
		// Exactly 75% is inclusive — the trigger fired. The compactor ran
		// in-lane before onDone settled the next queued turn's snapshot —
		// here, before done resolves.
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toContain("q0");
		const pointer = r.store.getCompaction(r.conv.id);
		// The budget keeps a chunky recent tail (whole exchanges only), so
		// the cut lands at the end of the second exchange — seq 4 — with the
		// live exchange (u7/a7) whole in the tail.
		expect(pointer).toMatchObject({
			boundarySeq: 4,
			summary: "the folded era",
			model: "zai/glm-5.3",
		});
		// The record stays whole; the model view is summary + kept tail.
		expect(r.store.history(r.conv.id)).toHaveLength(8);
		const view = r.store.modelEntries(r.conv.id);
		expect(view).toHaveLength(5);
		expect((view[0]!.message.parts[0] as { text: string }).text).toContain("the folded era");
		const lastText = view
			.at(-1)!
			.message.parts.find((p) => (p as { type: string }).type === "text") as
			| { text: string }
			| undefined;
		expect(lastText?.text).toBe("ok");
		r.store.close();

		// Just below the threshold (74%): no compaction, no pointer.
		const r2 = rig({
			model: scriptedEdge([textParts("ok", 740)]).model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => {
						throw new Error("must not compact");
					},
				},
			},
		});
		expect(await submit(r2, "hi").done).toEqual({ kind: "completed" });
		expect(r2.store.getCompaction(r2.conv.id)).toBeNull();
		r2.store.close();
	});

	test("/compact serializes behind a running turn — no orphaned exchange", async () => {
		const r = rig({
			deltas: ["slow ", "reply"],
			delayMs: 40,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => "folded",
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const sink = submit(r, "live question");
		// The manual compact queues while the turn still runs — it must not
		// choose a cut until the turn's response is appended to history.
		const compacted = r.runtime.compact(r.conv);
		await sink.done;
		const outcome = await compacted;
		expect(outcome.kind).toBe("compacted");
		const boundary = r.store.getCompaction(r.conv.id)!.boundarySeq;
		// The invariant: the model view's tail is exactly the events whose
		// causal position follows the boundary — nothing orphaned (an
		// anchored reply without its question), and nothing silently
		// swallowed (an event neither summarized nor shown).
		const tail = r.store
			.modelEntries(r.conv.id)
			.slice(1)
			.map((e) => e.seq);
		const expected = r.store
			.historyDetail(r.conv.id)
			.filter((e) => (e.anchorSeq ?? e.seq) > boundary)
			.map((e) => e.seq);
		expect(tail).toEqual(expected);
		r.store.close();
	});

	test("/stop drops a queued /compact — it resolves as a noop", async () => {
		const r = rig({
			deltas: ["slow ", "reply"],
			delayMs: 40,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: async () => "folded",
				},
			},
		});
		const sink = submit(r, "hi");
		await sink.firstDelta; // mid-stream: the compact queues behind the turn
		const compacted = r.runtime.compact(r.conv);
		const { stopped } = stop(r);
		expect(stopped).toBe(true);
		// stop means stop — the queued job drops like a queued turn, but
		// its promise still settles so the /compact reply fires.
		expect(await compacted).toEqual({ kind: "noop", reason: "stopped" });
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("/stop during a pending contextWindow lookup aborts the compaction — no pointer written", async () => {
		// The window lookup hangs until the stop has landed: the abort
		// controller must be registered BEFORE this await, or the stop
		// aborts a null controller and the compaction runs on despite it.
		const windowGate = deferred<void>();
		const r = rig({
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => windowGate.promise.then(() => 1000),
					// Fails fast on an already-aborted signal, as a real model call
					// does — the summary must never run past a stop.
					summarize: (_conv, _system, _prompt, signal) =>
						signal.aborted
							? Promise.reject(new Error("summarize aborted"))
							: Promise.resolve("must not summarize"),
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const compacted = r.runtime.compact(r.conv);
		// The compaction is now suspended inside the window lookup with its
		// controller registered — stop must see (and abort) it.
		const { stopped } = stop(r);
		expect(stopped).toBe(true);
		windowGate.resolve();
		// /stop carries two fences — the epoch bump and the abort — and the
		// authority check lands first now: the compaction rejects as fenced
		// before the (pre-aborted) summary call could even start.
		await expect(compacted).rejects.toThrow("turn fenced");
		// No history pointer was written despite the summary path being
		// reachable — the crossing retries on the next threshold.
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("a settings fence during the window lookup rejects a manual /compact — never a noop", async () => {
		// Nothing to fold: before the early authority check this returned
		// "nothing worth compacting". The fence now wins over the noop —
		// the pass genuinely lost authority, so the operator sees the
		// rejection, not a false all-clear.
		const windowGate = deferred<void>();
		const lookupStarted = deferred<void>();
		const r = rig({
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => {
						lookupStarted.resolve();
						return windowGate.promise.then(() => 1000);
					},
					summarize: async () => "must not summarize",
				},
			},
		});
		const compacted = r.runtime.compact(r.conv);
		await lookupStarted.promise;
		r.store.bumpEpoch(r.conv.id); // settings change — no abort, only the epoch
		windowGate.resolve();
		await expect(compacted).rejects.toThrow("turn fenced");
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("a settings epoch change fences an in-flight compaction — no pointer, snapshot kept", async () => {
		// Gate the summary call so the settings change lands mid-compaction.
		// /memory bumps the epoch without touching the abort signal — unlike
		// /stop there is no abort to carry the fence, only the commit check.
		const started = deferred<void>();
		const gate = deferred<string>();
		let summarizeCalls = 0;
		// Turn one crosses the threshold (75%); the barrier turn below stays
		// far under it so it triggers no second compaction.
		const edge = scriptedEdge([textParts("ok", 750)], { extra: textParts("ok", 50) });
		const r = rig({
			model: edge.model,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: (_conv, _system, _prompt, signal) => {
						if (signal.aborted) return Promise.reject(new Error("summarize aborted"));
						summarizeCalls++;
						started.resolve();
						return gate.promise;
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		// The frozen prompt snapshot the completed turn holds — the fenced
		// compaction must not clear it: that refresh belongs to the
		// compaction that actually lands.
		r.store.savePromptSnapshot(r.conv.id, "frozen system prompt", ["seed"]);
		const sink = submit(r, "live question");
		expect(await sink.done).toEqual({ kind: "completed" });
		await started.promise; // the threshold compaction's summary is now in flight
		// A queued successor settles only after the in-lane compaction —
		// its done is the barrier proving the fenced commit attempt ran.
		const barrier = submit(r, "follow-up");
		// The epoch-changing mutation /memory uses — no /stop, no abort.
		r.store.applySettings(r.conv.id, { memoryExcluded: true });
		expect(r.store.get(r.conv.id)?.epoch).toBe(1);
		gate.resolve("the folded era");
		expect(await barrier.done).toEqual({ kind: "completed" });
		// Settle the lane before closing the store — the barrier turn's
		// post-done work must finish first.
		await r.runtime.shutdown();
		// The summary resolved, but the pointer never landed and the frozen
		// snapshot survived — the next threshold crossing retries under the
		// new settings.
		expect(summarizeCalls).toBe(1);
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		expect(r.store.promptSnapshot(r.conv.id)).toEqual({
			text: "frozen system prompt",
			sources: ["seed"],
		});
		r.store.close();
	});

	test("a settings epoch change fences a manual /compact mid-summary — it rejects, no pointer", async () => {
		const started = deferred<void>();
		const gate = deferred<string>();
		const r = rig({
			deltas: ["reply"],
			delayMs: 1,
			step: { contextWindow: 1000 },
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1000,
					summarize: (_conv, _system, _prompt, signal) => {
						if (signal.aborted) return Promise.reject(new Error("summarize aborted"));
						started.resolve();
						return gate.promise;
					},
				},
			},
		});
		seedExchanges(r.store, r.conv.id);
		const compacted = r.runtime.compact(r.conv);
		await started.promise; // the manual job's summary is now in flight
		r.store.applySettings(r.conv.id, { memoryExcluded: true }); // epoch bump, no abort
		gate.resolve("the folded era");
		// The job rejects with the fence — the /compact reply reports it and
		// nothing was written.
		await expect(compacted).rejects.toThrow("turn fenced");
		await r.runtime.shutdown();
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("/stop while completion delivery is pending prevents a new auto-compaction", async () => {
		let builds = 0;
		const pendingDelivery = deferred<void>();
		const r = rig({
			deltas: ["ok"],
			delayMs: 1,
			step: { contextWindow: 1 },
			buildStep: () => {
				builds++;
				return { model: fakeModel(["ok"], 1), system: "test", contextWindow: 1 };
			},
			deps: {
				compaction: {
					modelRef: () => "m",
					contextWindow: () => 1,
					summarize: async () => "should not run",
				},
			},
		});
		const sink = new RecordingSink();
		const delivered = sink.onDone.bind(sink);
		sink.onDone = async (done) => {
			await pendingDelivery.promise;
			delivered(done);
		};
		r.runtime.submit(r.conv, userMessage([{ type: "text", text: "hi" }]), sink);
		await sink.firstDelta;
		// Let the turn reach onDone, then revoke its authority while the
		// delivery remains parked.
		await waitUntil(() => r.store.history(r.conv.id).length >= 2, "assistant reply lands");
		stop(r);
		pendingDelivery.resolve();
		await sink.done;
		await drain(r);
		expect(builds).toBe(1);
		expect(r.store.getCompaction(r.conv.id)).toBeNull();
		r.store.close();
	});

	test("compaction metadata never mints or rewrites the frozen prompt", async () => {
		// The real systemPromptFor at the buildStep edge — the fake model
		// only ever reads what it froze. A /compact pass reads window
		// metadata only: it must not build a snapshot, and nothing but a
		// landed boundary may clear one.
		useHome("goblin-rt-prompt-");
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const summarizeStarted = deferred<void>();
		let summarizeImpl: (signal: AbortSignal) => Promise<string> = async () => "folded";
		const runtime = new Runtime({
			store,
			buildStep: (c, toolset) => ({
				model: fakeModel(["ok"], 1),
				system: systemPromptFor(store, c, toolNames(toolset)).text,
			}),
			makeTools: () => ({
				memory_search: tool({
					inputSchema: z.object({ q: z.string() }),
					execute: async () => "no memory",
				}),
			}),
			compaction: {
				modelRef: () => "m",
				contextWindow: () => 1000,
				summarize: (_c, _system, _prompt, signal) => summarizeImpl(signal),
			},
		});
		try {
			// Fresh conversation — nothing to fold. The metadata pass must
			// not have built a prompt for it.
			expect(await runtime.compact(conv)).toEqual({
				kind: "noop",
				reason: "nothing worth compacting",
			});
			expect(store.promptSnapshot(conv.id)).toBeNull();

			// The first real turn freezes the real prompt: the deployment's
			// tool names and the memory framing they unlock.
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			const frozen = store.promptSnapshot(conv.id);
			expect(frozen).not.toBeNull();
			expect(frozen!.text).toContain("memory_search");
			expect(frozen!.text).toContain("Long-term memory is on");

			// A no-op compact leaves the frozen bytes untouched.
			expect((await runtime.compact(conv)).kind).toBe("noop");
			expect(store.promptSnapshot(conv.id)).toEqual(frozen);

			seedExchanges(store, conv.id);
			// A failed summary leaves them too.
			summarizeImpl = async () => {
				throw new Error("summarizer exploded");
			};
			await expect(runtime.compact(conv)).rejects.toThrow("summarizer exploded");
			expect(store.promptSnapshot(conv.id)).toEqual(frozen);

			// As does a stop that lands mid-summary.
			summarizeImpl = (signal) => {
				summarizeStarted.resolve();
				return new Promise<string>((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("summarize aborted")), {
						once: true,
					});
				});
			};
			const stopped = runtime.compact(conv);
			await summarizeStarted.promise;
			runtime.stop(conv.id);
			await expect(stopped).rejects.toThrow();
			expect(store.promptSnapshot(conv.id)).toEqual(frozen);

			// Only a landed boundary clears it for the rebuild.
			summarizeImpl = async () => "the folded era";
			expect((await runtime.compact(conv)).kind).toBe("compacted");
			expect(store.promptSnapshot(conv.id)).toBeNull();
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("provider warnings are logged, not dropped", async () => {
		const edge = scriptedEdge([
			[
				{
					type: "stream-start",
					warnings: [{ type: "unsupported", feature: "temperature" }],
				},
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "ok" },
				{ type: "text-end", id: "t1" },
				finishPart("stop"),
			],
		]);
		const r = rig({ model: edge.model });
		// The warn rides the same turn's log trail — a warning that never
		// lands was the fail-quiet seam this guards against.
		const lines = await capturedLog(async (logFile) => {
			const sink = submit(r, "hi");
			expect(await sink.done).toEqual({ kind: "completed" });
			await waitUntil(
				() => readFileSync(logFile, "utf8").includes("model warnings"),
				"warnings land in the log",
			);
		});
		expect(lines.find((l) => l.msg === "model warnings")?.warnings).toEqual([
			"unsupported:temperature",
		]);
		r.store.close();
	});

	test("pruneBetweenTurns commits markers before the claimed batch's view is built", async () => {
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		store.append(conv.id, [
			userMessage([{ type: "text", text: "old question" }]),
			{
				id: "a-tool",
				role: "assistant",
				parts: [
					{
						type: "tool-bash",
						toolCallId: "t1",
						state: "output-available",
						input: { command: "seq" },
						output: "ORIGINAL_TOOL_OUTPUT",
					},
				],
			} as unknown as UIMessage,
		]);
		const { model, prompts } = recordingModel(["ok"], 5);
		const calls: string[] = [];
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model, system: "test" }),
			makeTools: () => ({}),
			pruneBetweenTurns: (convId) => {
				calls.push(convId);
				store.applyEventProjections(convId, [
					{
						seq: 2,
						toolCallId: "t1",
						replacement: "PRUNED_MARKER",
						routeKey: "a".repeat(64),
						settingsHash: "b".repeat(64),
					},
				]);
			},
		});
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "next" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await runtime.shutdown();
		expect(calls).toEqual([conv.id]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("PRUNED_MARKER");
		expect(prompts[0]).not.toContain("ORIGINAL_TOOL_OUTPUT");
		// The events row keeps the original bytes.
		const part = store.history(conv.id)[1]!.parts[0] as { output?: unknown };
		expect(part.output).toBe("ORIGINAL_TOOL_OUTPUT");
		store.close();
	});

	test("a throwing pruneBetweenTurns is logged and the turn still runs", async () => {
		const dir = tmpDir("goblin-rt-log-");
		const logFile = join(dir, "goblin.log");
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["ok"], 5), system: "test" }),
			makeTools: () => ({}),
			pruneBetweenTurns: () => {
				throw new Error("projection store exploded");
			},
		});
		setLogFile(logFile);
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			await runtime.shutdown();
			expect(readFileSync(logFile, "utf8")).toContain("cache pruning pass failed");
		} finally {
			setLogFile(null);
			store.close();
		}
	});
});

describe("skill reviewer hook", () => {
	test("shutdown fences a held gate after its conversation lane has drained", async () => {
		const r = rig({ deltas: ["answer"], delayMs: 1 });
		const held = deferred<void>();
		const atGate = deferred<void>();
		r.runtime.setReviewer(
			new Reviewer({
				gate: {
					decide: async () => {
						atGate.resolve();
						await held.promise;
						return { answers: { correction: 1 }, inputTokens: 1, cost: 0 };
					},
				},
				thresholds: { correction: 0.8, procedure: 0.8 },
				queueCap: 3,
				evidence: { calls: 8, argChars: 300, outChars: 300 },
				reviewModel: async () => {
					throw new Error("shutdown let a review start");
				},
				store: r.store,
				skillsDir: "/none",
				proposedDir: "/none",
				workspaceDir: "/none",
				notify: async () => {},
			}),
		);
		expect(await submit(r, "save this").done).toEqual({ kind: "completed" });
		await atGate.promise;
		// A settled drain removes the lane; shutdown must still find the gate.
		await drain(r);
		await r.runtime.shutdown();
		r.store.close();
		held.resolve();
		await sleep(20); // settle window: the released gate's continuation has no handle
	});
	test("a fenced turn never gates", async () => {
		const r = rig({ deltas: ["a", "b", "c", "d", "e"], delayMs: 20 });
		let gated = false;
		r.runtime.setReviewer(
			new Reviewer({
				gate: {
					decide: async () => {
						gated = true;
						return { answers: {}, inputTokens: null, cost: null };
					},
				},
				thresholds: { correction: 0.8, procedure: 0.8 },
				queueCap: 3,
				evidence: { calls: 8, argChars: 300, outChars: 300 },
				reviewModel: async () => {
					throw new Error("must not resolve");
				},
				store: r.store,
				skillsDir: "/none",
				proposedDir: "/none",
				workspaceDir: "/none",
				notify: async () => {},
			}),
		);
		const sink = submit(r, "hi");
		await sink.firstDelta;
		r.store.bumpEpoch(r.conv.id);
		expect(await sink.done).toEqual({ kind: "fenced" });
		await sleep(50); // the fire-and-forget gate would have fired by now
		expect(gated).toBe(false);
		r.store.close();
	});
});

// The gate blocks the tool's execute, so the step boundary (prepareStep
// before call #2) opens exactly when the test decides.
function gatedToolModel(secondText: string) {
	return scripted(
		[
			[
				{ type: "stream-start", warnings: [] },
				toolCallPart("c1", "probe"),
				finishPart("tool-calls"),
			],
			textParts(secondText),
		],
		{ extra: textParts(secondText) },
	);
}

function steeringSetup(model: LanguageModel, gate?: Promise<void>, modalities?: Set<string>) {
	return rig({
		model,
		step: modalities ? { inputModalities: modalities } : {},
		tools: {
			probe: tool({
				inputSchema: z.object({}),
				execute: async () => {
					if (gate) await gate;
					return { ok: true };
				},
			}),
		},
	});
}

describe("steering", () => {
	test("a submit during a live turn joins the next model call", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise);
		const s1 = submit(r, "start this");
		// Turn 1 is mid-tool-call (step 1 done, tool gated). Submit —
		// this is the steer.
		await s1.firstToolCall;
		const s2 = submit(r, "actually pivot");
		gate.resolve();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s1.text).toBe("adjusted"); // call #1 streams no text — only the tool call
		expect(s2.text).toBe(""); // delta-style text is the head's delivery seam
		// The steered member's chunk stream must not run dry — it saw the
		// same wire as the head: replay of what preceded the join, live
		// tail after. One turn, one reply, every screen sees it.
		expect(s2.chunks).toEqual(s1.chunks);
		expect(s2.chunks.some((c) => c.type === "start")).toBe(true);
		// One turn, two model calls; the second call's wire prompt
		// carries the steered message as an appended user message.
		expect(s.prompts).toHaveLength(2);
		const wire = JSON.parse(s.prompts[1]!) as {
			role: string;
			content: { type: string; text?: string }[];
		}[];
		const texts = wire
			.filter((m) => m.role === "user")
			.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text!));
		expect(texts).toEqual(["start this", "actually pivot"]);
		// History: both user messages, then one assistant exchange. The
		// reply anchors after the steered message — the burst it
		// actually answered.
		const detail = r.store.historyDetail(r.conv.id);
		expect(detail.map((d) => d.message.role)).toEqual(["user", "user", "assistant"]);
		expect(detail[2]!.anchorSeq).toBe(detail[1]!.seq);
		r.store.close();
	});

	describe("live chunk subscription (resumable streams)", () => {
		test("a mid-turn subscriber gets replay + live tail + one end; idle lanes are null", async () => {
			const gate = deferred<void>();
			const s = gatedToolModel("tail text");
			const r = steeringSetup(s.model, gate.promise);
			const s1 = new RecordingSink();
			// No submit yet — no lane, nothing to attach to.
			expect(
				r.runtime.subscribeLiveChunks(
					r.conv.id,
					() => {},
					() => {},
				),
			).toBeNull();
			submit(r, "go", s1);
			await s1.firstToolCall; // step 1 (the tool call) is on the wire, tool gated
			const seen: UIMessageChunk[] = [];
			const endedRef: { done: TurnDone | null } = { done: null };
			const replay = r.runtime.subscribeLiveChunks(
				r.conv.id,
				(c) => seen.push(c),
				(d) => {
					endedRef.done = d;
				},
			);
			expect(replay).not.toBeNull();
			// Replay begins at the wire's first chunk — the tool call the
			// late joiner missed is included, not resumed mid-sentence.
			expect(replay!.some((c) => c.type === "start")).toBe(true);
			expect(replay!.some((c) => c.type === "tool-input-available")).toBe(true);
			gate.resolve();
			expect(await s1.done).toEqual({ kind: "completed" });
			expect(endedRef.done?.kind).toBe("completed");
			// The subscriber saw the same wire as the head, gapless.
			expect(seen).toEqual(s1.chunks.slice(replay!.length));
			// After the turn settles, there is nothing left to attach to.
			expect(
				r.runtime.subscribeLiveChunks(
					r.conv.id,
					() => {},
					() => {},
				),
			).toBeNull();
			r.store.close();
		});
	});

	test("a submit during the turn's startup steers into the first call", async () => {
		const { model, prompts } = recordingModel(["done"], 5);
		const stepGate = deferred<void>();
		// buildStep still pending when the second submit lands.
		const r = rig({
			buildStep: async () => {
				await stepGate.promise;
				return { model, system: "test" };
			},
		});
		const s1 = submit(r, "one");
		const s2 = submit(r, "two");
		stepGate.resolve();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s2.text).toBe(""); // delta-style text stays the head's seam
		expect(s2.chunks).toEqual(s1.chunks); // the chunk stream fans out to every member
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("one");
		expect(prompts[0]).toContain("two");
		r.store.close();
	});

	test("input after the final model call queues into a successor turn", async () => {
		const s = gatedToolModel("second");
		const r = steeringSetup(s.model);
		const s1 = submit(r, "one");
		await s1.done; // turn fully over — no boundary left
		const s2 = submit(r, "two");
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s.prompts).toHaveLength(3); // turn 1's tool loop = 2 calls + successor
		expect(roles(r)).toEqual(["user", "assistant", "user", "assistant"]);
		r.store.close();
	});

	test("a fenced turn requeues the steer instead of consuming it", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("never seen");
		const r = steeringSetup(s.model, gate.promise);
		const s1 = submit(r, "one");
		await s1.firstToolCall; // mid-tool-call
		r.store.bumpEpoch(r.conv.id); // fence, without stop()'s queue drop
		const s2 = submit(r, "two");
		gate.resolve();
		expect(await s1.done).toEqual({ kind: "fenced" });
		// The steered submit was requeued at the fence, not consumed —
		// the successor turn answers it.
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s.prompts).toHaveLength(3);
		expect(s.prompts[2]).toContain("two");
		await drain(r);
		r.store.close();
	});

	test("a submit landing mid-conversion stays above the ownership mark", async () => {
		// The steer is a photo whose readFile parks on a FIFO — a
		// deterministic window to land a follow-up while the boundary is
		// mid-conversion. The mark must claim the photo (injected) and
		// never the follow-up (still pending, never read).
		const dir = tmpDir("goblin-rt-fifo-");
		const fifo = join(dir, "photo.png");
		execSync(`mkfifo '${fifo}'`);
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise, new Set(["text", "image"]));
		const s1 = submit(r, "start this");
		await s1.firstToolCall; // parked mid-tool-call
		const s2 = new RecordingSink();
		r.runtime.submit(
			r.conv,
			{
				id: "steer-photo",
				role: "user",
				parts: [
					{
						type: ATTACHMENT_PART,
						data: { path: fifo, mediaType: "image/png", filename: "photo.png", size: 7 },
					},
				],
			} as UIMessage,
			s2,
		);
		gate.resolve(); // tool resolves → prepareStep splices the photo → readFile parks on the FIFO
		await sleep(30); // park window: a blocked FIFO read has no event surface to await
		const s3 = submit(r, "follow-up");
		// Unpark the photo and let the turn finish.
		await writeFile(fifo, "pngdata");
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		// Swap the FIFO for a regular file: the successor's admission would
		// otherwise re-read the FIFO with no writer left and park forever.
		unlinkSync(fifo);
		writeFileSync(fifo, "pngdata");
		// The follow-up was never injected — a successor turn answers it.
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(s.prompts).toHaveLength(3);
		// Call #2 carried the photo, not the follow-up.
		expect(s.prompts[1]).toContain("photo.png");
		expect(s.prompts[1]).not.toContain("follow-up");
		// Turn 1's reply anchors after the photo — never after input it
		// didn't read. The successor's reply anchors after the follow-up.
		const detail = r.store.historyDetail(r.conv.id);
		const seqOf = (id: string) => detail.find((d) => d.message.id === id)!.seq;
		const assistants = detail.filter((d) => d.message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]!.anchorSeq).toBe(seqOf("steer-photo"));
		// The follow-up is the newest user message; the successor's reply
		// anchors there.
		const followUpSeq = Math.max(
			...detail.filter((d) => d.message.role === "user").map((d) => d.seq),
		);
		expect(assistants[1]!.anchorSeq).toBe(followUpSeq);
		r.store.close();
	});

	test("a steered message that cannot convert errors its own delivery, not the conversation", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise);
		const s1 = submit(r, "start this");
		await s1.firstToolCall; // parked mid-tool-call
		// Poison: a file part with an invalid URL — materializeAttachments
		// passes it through untouched, convertToModelMessages throws.
		const s2 = new RecordingSink();
		r.runtime.submit(
			r.conv,
			{
				id: "poison",
				role: "user",
				parts: [
					{ type: "text", text: "read this" },
					{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
				],
			} as UIMessage,
			s2,
		);
		gate.resolve();
		// The poison's own delivery errors; turn 1 completes over the rest.
		expect(await s1.done).toEqual({ kind: "completed" });
		const poisoned = await s2.done;
		expect(poisoned.kind).toBe("error");
		// Call #2 never saw the poison; the reply anchors at the trigger,
		// not at the message it couldn't carry.
		expect(s.prompts[1]).not.toContain("read this");
		const first = r.store.historyDetail(r.conv.id);
		const firstReply = first.filter((d) => d.message.role === "assistant")[0]!;
		expect(firstReply.anchorSeq).toBe(first.find((d) => d.message.id === "poison")!.seq - 1);
		// A successor turn must survive the poison sitting in history:
		// admission degrades it to a placeholder and the turn completes.
		const s3 = submit(r, "still there?");
		expect(await s3.done).toEqual({ kind: "completed" });
		expect(s.prompts).toHaveLength(3);
		expect(s.prompts[2]).toContain("could not be prepared for the model");
		expect(s.prompts[2]).toContain("still there?");
		r.store.close();
	});

	test("an epoch change during a successful steer conversion fences it before join or replay (#115)", async () => {
		const dir = tmpDir("goblin-rt-fifo-");
		const fifo = join(dir, "photo.png");
		execSync(`mkfifo '${fifo}'`);
		const gate = deferred<void>();
		const s = gatedToolModel("never reaches the client");
		const r = steeringSetup(s.model, gate.promise, new Set(["text", "image"]));
		const joinerChunks: UIMessageChunk[] = [];
		class JoiningSink extends RecordingSink {
			override onStreamChunk(c: UIMessageChunk) {
				joinerChunks.push(c);
			}
		}
		const joiner = new JoiningSink();
		const head = submit(r, "first");
		await head.firstToolCall; // parked mid-tool-call
		// The steer's conversion parks reading the FIFO; the epoch dies
		// while it waits, and the conversion then SUCCEEDS — the fence
		// must still hold on the success path, before join/replay/fold.
		r.runtime.submit(
			r.conv,
			{
				id: "photo-steer",
				role: "user",
				parts: [
					{
						type: ATTACHMENT_PART,
						data: { path: fifo, mediaType: "image/png", filename: "photo.png", size: 7 },
					},
				],
			} as UIMessage,
			joiner,
		);
		gate.resolve();
		await sleep(40); // park window: conversion is blocked on the FIFO read
		r.store.bumpEpoch(r.conv.id);
		await writeFile(fifo, "pngdata");
		expect(await head.done).toEqual({ kind: "fenced" });
		expect(await joiner.done).toEqual({ kind: "fenced" });
		// The joiner never joined: no wire replay reached it after the
		// fence, and no model request ever carried its content.
		expect(joinerChunks).toHaveLength(0);
		expect(s.prompts.every((p) => !p.includes("photo.png"))).toBe(true);
		await sleep(20); // settle window before close: successor work has no handle here
		r.store.close();
	});
});

describe("app channel", () => {
	// The turn loop is shared machinery — an app conversation submits,
	// steers, fences and persists exactly like a telegram one; only the
	// sink differs. The basic app turn is pinned end-to-end through the
	// real door in http/app-channel.test.ts; what stays here is the
	// Runtime-level steering pin the HTTP surface cannot assert directly.
	test("steering into a running app turn works through the same queue", async () => {
		const { model, prompts } = recordingModel(["done"], 0);
		const stepGate = deferred<void>();
		// buildStep still pending when the second submit lands — the
		// steer folds it into the first model call.
		const r = rig({
			addr: appAddress("chat-01"),
			buildStep: async () => {
				await stepGate.promise;
				return { model, system: "test" };
			},
		});
		const s1 = submit(r, "one");
		const s2 = submit(r, "two");
		stepGate.resolve();
		expect(await s1.done).toEqual({ kind: "completed" });
		expect(await s2.done).toEqual({ kind: "completed" });
		expect(s2.text).toBe(""); // delta-style text stays the head's seam
		expect(s2.chunks).toEqual(s1.chunks); // the chunk stream fans out to every member
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("one");
		expect(prompts[0]).toContain("two");
		expect(roles(r)).toEqual(["user", "user", "assistant"]);
		await r.runtime.shutdown();
		r.store.close();
	});
});

// A submit "streams" iff its sink defines onStreamChunk. A turn headed
// by a headless sink — e.g. the spin-off's bell — must never absorb a
// streaming submit: the merged sink would see only onDone and the client
// watching the stream would wait forever.
describe("streaming lane boundary", () => {
	test("a headless turn never absorbs a streaming submit — it heads the next turn", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise);
		const headless = new HeadlessSink();
		submit(r, "start this", headless);
		await waitUntil(() => s.prompts.length >= 1, "step 1 on the wire"); // tool gated
		const streaming = submit(r, "watch me");
		gate.resolve();
		expect(await headless.done).toEqual({ kind: "completed" });
		// Not folded into the headless turn — a successor turn ran and
		// the streaming sink got the raw chunks as its head.
		expect(await streaming.done).toEqual({ kind: "completed" });
		expect(streaming.chunkTypes).toContain("text-delta");
		expect(streaming.text).toBe("adjusted");
		expect(s.prompts[1]).not.toContain("watch me");
		expect(s.prompts[2]).toContain("watch me");
		r.store.close();
	});

	test("a streaming head absorbs both sink kinds, as before", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise);
		const streaming = submit(r, "one");
		await streaming.firstToolCall; // parked mid-tool-call
		const headless = new HeadlessSink();
		submit(r, "two", headless);
		gate.resolve();
		expect(await streaming.done).toEqual({ kind: "completed" });
		expect(await headless.done).toEqual({ kind: "completed" });
		// One turn — the steered message rode call #2's prompt.
		expect(s.prompts).toHaveLength(2);
		expect(s.prompts[1]).toContain("two");
		r.store.close();
	});

	test("a headless turn still steers headless followers into the live call", async () => {
		const gate = deferred<void>();
		const s = gatedToolModel("adjusted");
		const r = steeringSetup(s.model, gate.promise);
		const first = new HeadlessSink();
		submit(r, "one", first);
		await waitUntil(() => s.prompts.length >= 1, "step 1 on the wire"); // tool gated
		const second = new HeadlessSink();
		submit(r, "two", second);
		gate.resolve();
		expect(await first.done).toEqual({ kind: "completed" });
		expect(await second.done).toEqual({ kind: "completed" });
		expect(s.prompts).toHaveLength(2);
		expect(s.prompts[1]).toContain("two");
		r.store.close();
	});

	// The lane boundary must hold at admission too: drain's splice leaves
	// a streaming submit queued behind a headless head; its message is
	// durable history (every submit appends before admission), so the
	// headless turn's admission snapshot would otherwise read it, anchor
	// its reply to it — and the client's own successor turn would answer
	// the same message a second time. Multiple pending submits at
	// admission, not arrivals during the model loop.
	test("admission never reads a queued streaming submit — the client keeps its own turn", async () => {
		const { model, prompts } = recordingModel(["answer"], 5);
		const r = rig({ model });
		const gate = deferred<void>();
		const parked = new ParkedDoneSink(gate.promise);
		const background = new HeadlessSink();
		const client = new RecordingSink();
		submit(r, "first turn", parked);
		// The drain loop is parked in the first turn's delivery completion —
		// the two submits below only queue (lane still running).
		await parked.done;
		r.runtime.submit(
			r.conv,
			{ id: "same-id", role: "user", parts: [{ type: "text", text: "background beat" }] } as UIMessage,
			background,
		);
		r.runtime.submit(
			r.conv,
			{ id: "same-id", role: "user", parts: [{ type: "text", text: "client owns me" }] } as UIMessage,
			client,
		);
		gate.resolve();
		expect(await background.done).toEqual({ kind: "completed" });
		expect(await client.done).toEqual({ kind: "completed" });
		// Three turns ran: parked, background, the client's own. The
		// background turn's model request never contained the client's
		// message — ownership, not durability, bounds the view.
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).toContain("background beat");
		expect(prompts[1]).not.toContain("client owns me");
		expect(prompts[2]).toContain("background beat");
		expect(prompts[2]).toContain("client owns me");
		expect(client.text).toBe("answer");
		// Causal view: the background reply sorts after its own burst and
		// BEFORE the client's input — it never anchors to a message this
		// turn didn't read. The client's reply anchors to the client's
		// message it actually answered.
		const detail = r.store.historyDetail(r.conv.id);
		expect(detail.map((d) => d.message.role)).toEqual([
			"user",
			"assistant", // first turn
			"user",
			"assistant", // background beat answered before the client's input
			"user",
			"assistant", // the client's own turn
		]);
		expect(detail[3]!.anchorSeq).toBe(detail[2]!.seq);
		expect(detail[5]!.anchorSeq).toBe(detail[4]!.seq);
		r.store.close();
	});
});

describe("loop landings", () => {
	// A turn has no step cap — loops are caught, not capped: the repeat
	// detector (10 identical call+result pairs warn, 20 cut), the system1
	// loop watchdog (two consecutive stuck verdicts cut), and the context
	// landing (a step at ≥85% of the window lands tools-off). The fixture
	// model is tool-greedy while tools exist, answering the moment
	// toolChoice goes none — the compliant model every forced step
	// relies on.
	function loopModel(
		opts: { calls?: number; input?: (n: number) => unknown; inputTokens?: number } = {},
	) {
		const requests: { toolChoice: unknown; prompt: string }[] = [];
		const edge = scriptedEdge([], {
			modelId: "loop-test",
			onStream: (options, index) => {
				const n = index + 1;
				requests.push({
					toolChoice: options.toolChoice?.type ?? null,
					prompt: JSON.stringify(options.prompt ?? []),
				});
				const callTool =
					options.toolChoice?.type !== "none" && (opts.calls === undefined || n <= opts.calls);
				return callTool
					? [
							{ type: "stream-start" as const, warnings: [] },
							toolCallPart(`c${n}`, "probe", JSON.stringify(opts.input?.(n) ?? {})),
							finishPart("tool-calls", opts.inputTokens ?? 10),
						]
					: textParts("the wrapped answer", opts.inputTokens ?? 10);
			},
		});
		return { model: edge.model, requests };
	}
	function loopSetup(
		model: LanguageModel,
		opts: {
			execute?: () => unknown;
			executeAsync?: () => Promise<unknown>;
			contextWindow?: number;
		} = {},
	) {
		let executions = 0;
		const r = rig({
			model,
			addr: appAddress("loop"),
			step: opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {},
			tools: {
				probe: tool({
					inputSchema: z.looseObject({}),
					execute: async () => {
						executions++;
						return opts.executeAsync ? opts.executeAsync() : (opts.execute?.() ?? "ok");
					},
				}),
			},
		});
		return { ...r, executions: () => executions };
	}
	const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
	const WARN_BIT = "same tool call and gotten the same result 10 times";
	const CUT_BIT = "kept returning the same result";

	test("no cap: 80 distinct tool calls complete normally, unforced", async () => {
		const { model, requests } = loopModel({ calls: 80, input: (n) => ({ n }) });
		const { store, conv, runtime, executions } = loopSetup(model);
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "dig everywhere" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();
		// 80 tool steps then the answer step — no forced landing.
		expect(requests).toHaveLength(81);
		expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
		expect(executions()).toBe(80);
		expect(sink.text).toBe("the wrapped answer");
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBeUndefined();
		store.close();
	});

	test("repeat detector: identical call+result warns once at 10, cuts at 20", async () => {
		// Every step re-issues the same call; the tool returns the same
		// result — the definition of no progress.
		const { model, requests } = loopModel();
		const { store, conv, runtime } = loopSetup(model, { execute: () => "same result" });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "spin" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed", forced: "repeat" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();
		// 20 tool steps: warn appended at the request after the 10th
		// result, cut lands tools-off on the request after the 20th.
		expect(requests).toHaveLength(21);
		// The warning lands exactly once per request — appended once at a
		// boundary and carried forward by the SDK, never re-appended.
		expect(requests.slice(0, 10).every((r) => !r.prompt.includes(WARN_BIT))).toBe(true);
		for (const r of requests.slice(10)) {
			expect(occurrences(r.prompt, WARN_BIT)).toBe(1);
		}
		expect(requests[20]!.toolChoice).toBe("none");
		expect(occurrences(requests[20]!.prompt, CUT_BIT)).toBe(1);
		expect(requests.slice(0, 20).every((r) => !r.prompt.includes(CUT_BIT))).toBe(true);
		expect(sink.text).toBe("the wrapped answer");
		// The landing stamps itself in the stored metadata.
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBe("repeat");
		store.close();
	});

	test("same call with changing results never trips the detector", async () => {
		const { model, requests } = loopModel({ calls: 25, input: () => ({ poll: true }) });
		const { store, conv, runtime } = loopSetup(model, { execute: () => `fresh ${Math.random()}` });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "poll" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed" });
		expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
		expect(requests.every((r) => !r.prompt.includes(WARN_BIT))).toBe(true);
		store.close();
	});

	describe("loop watchdog", () => {
		// Every N completed calls the turn's own digest ring is scored
		// "stuck": ≥0.7 warns, a second consecutive ≥0.7 cuts, a pass
		// resets. Fail-open.
		function decideScript(scores: (number | Error)[]): {
			decide: System1Client["decide"];
			states: { totalToolCalls: number; recentCalls: { result: string }[] }[];
			// A check in flight survives onDone (the verdict lands after the
			// turn's last request) — tests that assert on calls must await it.
			settled(): Promise<void>;
		} {
			const states: { totalToolCalls: number; recentCalls: { result: string }[] }[] = [];
			let i = 0;
			let pending = 0;
			const decide: System1Client["decide"] = async (state, questions) => {
				pending++;
				try {
					// Settle inside the next tool's execution so the verdict is
					// deterministic in time (probe's 20ms execution pads it).
					await sleep(5);
					expect(questions["stuck"]).toBeDefined();
					const s = state as {
						totalToolCalls: number;
						recentCalls: { result: string; tool: string }[];
					};
					expect(s.totalToolCalls).toBeGreaterThan(0);
					// The watchdog's own ring carries real results — never the
					// "(no result)" placeholder an evidence ring would show.
					expect(s.recentCalls.length).toBeGreaterThan(0);
					for (const c of s.recentCalls) {
						expect(c.result).not.toBe("(no result)");
						expect(c.result.length).toBeGreaterThan(0);
					}
					states.push({ totalToolCalls: s.totalToolCalls, recentCalls: s.recentCalls });
					const score = scores[i++];
					if (score instanceof Error) throw score;
					return { answers: { stuck: score ?? 0 }, inputTokens: 5, cost: 0 };
				} finally {
					pending--;
				}
			};
			return {
				decide,
				states,
				settled: () => waitUntil(() => pending <= 0, "reviews settle"),
			};
		}

		test("two consecutive stuck verdicts cut — the first warns", async () => {
			const { model, requests } = loopModel();
			const { decide, states } = decideScript([0.9, 0.9]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "spin" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed", forced: "watchdog" });
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			await runtime.shutdown();
			// Checks at calls 2 and 4: the first warns (lands in the next
			// boundary's request, tools still on), the second cuts — the
			// last request is the tools-off landing with the cut nudge.
			expect(states).toHaveLength(2);
			const cut = requests.length - 1;
			expect(requests[cut]!.toolChoice).toBe("none");
			expect(occurrences(requests[cut]!.prompt, "judged stuck twice in a row")).toBe(1);
			// The warning was appended once and carried forward — once in
			// the cut request too, never duplicated.
			expect(occurrences(requests[cut]!.prompt, "look stuck")).toBe(1);
			expect(requests.slice(0, cut).every((r) => r.toolChoice !== "none")).toBe(true);
			expect(sink.text).toBe("the wrapped answer");
			const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
				| { forcedCompletion?: unknown }
				| undefined;
			expect(md?.forcedCompletion).toBe("watchdog");
			store.close();
		});

		test("a sub-threshold check resets the escalation — no cut", async () => {
			const { model, requests } = loopModel({ calls: 6 });
			const { decide, states, settled } = decideScript([0.9, 0.1, 0.9]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "grind" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			await runtime.shutdown();
			await settled(); // the last check can outlive the answer step
			// warn, reset, warn — never two consecutive stuck verdicts.
			expect(states).toHaveLength(3);
			expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
			store.close();
		});

		test("an unavailable system1 fails open — the turn completes", async () => {
			const { model, requests } = loopModel({ calls: 4 });
			const { decide, settled } = decideScript([
				new Error("system1 down"),
				new Error("system1 down"),
			]);
			const { store, conv, runtime } = loopSetup(model, {
				executeAsync: async () => {
					await sleep(20);
					return "ok";
				},
			});
			runtime.setLoopWatchdog({ decide, every: 2 });
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "grind" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			await runtime.shutdown();
			await settled();
			expect(requests.every((r) => r.toolChoice !== "none")).toBe(true);
			store.close();
		});
	});

	test("context landing: a step at ≥85% of the window forces tools-off", async () => {
		const { model, requests } = loopModel({ calls: 5, inputTokens: 900 });
		const { store, conv, runtime } = loopSetup(model, { contextWindow: 1000 });
		const sink = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "fill me" }]), sink);
		expect(await sink.done).toEqual({ kind: "completed", forced: "context" });
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();
		// Step 1's 900/1000 input crossed the line — request 2 is the
		// tools-off landing with the context nudge, not call 5.
		expect(requests).toHaveLength(2);
		expect(requests[1]!.toolChoice).toBe("none");
		expect(occurrences(requests[1]!.prompt, "context window is nearly full")).toBe(1);
		expect(sink.text).toBe("the wrapped answer");
		const md = (store.history(conv.id)[1] as { metadata?: unknown }).metadata as
			| { forcedCompletion?: unknown }
			| undefined;
		expect(md?.forcedCompletion).toBe("context");
		store.close();
	});

	test("a poisoned steer at the landing step does not eat the cut", async () => {
		// The steer claims the pending queue but its conversion fails —
		// the landing must still land tools-off.
		let releaseTool: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseTool = r;
		});
		const { model, requests } = loopModel({ inputTokens: 900 });
		const { store, conv, runtime } = loopSetup(model, {
			contextWindow: 1000,
			executeAsync: async () => {
				await gate;
				return "ok";
			},
		});
		const s1 = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "start" }]), s1);
		await s1.firstToolCall; // parked mid-tool-call
		const s2 = new RecordingSink();
		runtime.submit(
			conv,
			{
				id: "poison",
				role: "user",
				parts: [
					{ type: "text", text: "read this" },
					{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
				],
			} as UIMessage,
			s2,
		);
		releaseTool();
		// The context cut (900/1000 on step 1) still lands: the steer
		// errored its own delivery and the forced step went tools-off.
		expect(await s1.done).toEqual({ kind: "completed", forced: "context" });
		expect((await s2.done).kind).toBe("error");
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();
		expect(requests.at(-1)!.toolChoice).toBe("none");
		expect(requests.at(-1)!.prompt).toContain("context window is nearly full");
		expect(s1.text).toBe("the wrapped answer");
		store.close();
	});
});

test("model/thinking changes do not interrupt admitted turns; next turn and manual compaction resolve latest channel settings", async () => {
	const store = openStore(tmpDb("goblin-rt-"));
	let cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/app",
		thinking: "high",
		operators: [7],
		allowedUsers: [7],
		telegram: { model: "test/telegram", thinking: "low" },
	});
	const app = store.resolve(appAddress("channel-settings"), "/work");
	const dm = store.resolve({ kind: "dm", chatId: 7 }, "/work");
	store.setMeta(dm.id, { model: "test/retired", thinking: "max" });
	let release: () => void = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	const summaries: string[] = [];
	const runtime = new Runtime({
		store,
		captureConversation: (conv) => captureConversationSettings(store, conv, cfg),
		async buildStep(conv) {
			if (++calls === 1) await held;
			return {
				model: fakeModel([`${conv.model}:${conv.thinking}`], 1),
				system: "test",
				label: conv.model!,
			};
		},
		makeTools: () => ({}),
		compaction: {
			modelRef: (conv) => conv.model!,
			contextWindow: () => null,
			summarize: async (conv) => {
				summaries.push(`${conv.model}:${conv.thinking}`);
				return "summary";
			},
		},
	});
	try {
		const first = new RecordingSink();
		runtime.submit(app, userMessage([{ type: "text", text: "first" }]), first);
		await first.admitted;
		store.setMeta(app.id, { model: "test/personal", thinking: "xhigh" });
		cfg = parseConfig({
			...cfg,
			model: "test/future",
			thinking: "off",
			telegram: { ...cfg.telegram, model: "test/telegram-new", thinking: "medium" },
		});
		release();
		expect((await first.done).kind).toBe("completed");
		expect(first.text).toBe("test/app:high");
		const second = new RecordingSink();
		runtime.submit(app, userMessage([{ type: "text", text: "second" }]), second);
		expect((await second.done).kind).toBe("completed");
		expect(second.text).toBe("test/personal:xhigh");
		const telegram = new RecordingSink();
		runtime.submit(dm, userMessage([{ type: "text", text: "telegram" }]), telegram);
		expect((await telegram.done).kind).toBe("completed");
		expect(telegram.text).toBe("test/telegram-new:medium");
		// Force enough history to compact, then use an intentionally stale
		// Conversation object: /compact resolves at execution, not enqueue.
		for (let i = 0; i < 4; i++)
			store.append(app.id, [
				userMessage([{ type: "text", text: "past ".repeat(25000) }]),
				{ id: `past-${i}`, role: "assistant", parts: [{ type: "text", text: "done" }] },
			]);
		store.setMeta(app.id, { model: "test/compact", thinking: "low" });
		expect((await runtime.compact(app)).kind).toBe("compacted");
		expect(summaries.every((s) => s === "test/compact:low")).toBe(true);
		expect(summaries.length).toBeGreaterThan(0);
		expect(store.getCompaction(app.id)!.model).toBe("test/compact");
	} finally {
		await runtime.shutdown();
		store.close();
	}
});

test("overflow compaction and resumed model call keep the admitted selection across settings edits", async () => {
	const store = openStore(tmpDb("goblin-rt-"));
	const conv = store.resolve(appAddress("overflow-settings"), "/work");
	seedExchanges(store, conv.id);
	const cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/original",
		thinking: "high",
		operators: [7],
		allowedUsers: [7],
	});
	const { model } = scripted([overflowError(), textParts("recovered"), textParts("next")], {
		extra: textParts("ok"),
	});
	const selections: string[] = [];
	const summarySelections: string[] = [];
	const runtime = new Runtime({
		store,
		captureConversation: (row) => captureConversationSettings(store, row, cfg),
		buildStep: (row) => {
			selections.push(`${row.model}:${row.thinking}`);
			return { model, system: "test", contextWindow: 1000 };
		},
		makeTools: () => ({}),
		compaction: {
			modelRef: (row) => row.model!,
			contextWindow: () => 1000,
			summarize: async (row) => {
				store.setMeta(row.id, { model: "test/changed", thinking: "low" });
				summarySelections.push(`${row.model}:${row.thinking}`);
				return "summary";
			},
		},
	});
	try {
		const first = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "recover" }]), first);
		expect((await first.done).kind).toBe("completed");
		expect(first.text).toBe("recovered");
		// buildStep counts model attempts only — the overflow recovery's
		// compaction reads window metadata, not a step.
		expect(selections).toEqual(["test/original:high", "test/original:high"]);
		expect(summarySelections).toEqual(["test/original:high"]);
		expect(store.getCompaction(conv.id)!.model).toBe("test/original");
		const next = new RecordingSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "continue" }]), next);
		expect((await next.done).kind).toBe("completed");
		expect(selections.at(-1)).toBe("test/changed:low");
	} finally {
		await runtime.shutdown();
		store.close();
	}
});

test("invalid durable app settings report admission error exactly once without starting a model call", async () => {
	const store = openStore(tmpDb("goblin-rt-"));
	const conv = store.resolve(appAddress("bad-settings"), "/work");
	store.setMeta(conv.id, { thinking: "corrupt-disk-value" });
	const cfg = parseConfig({
		providers: { test: { kind: "codex" } },
		model: "test/chat",
		operators: [7],
		allowedUsers: [7],
	});
	let modelCalls = 0;
	let completions = 0;
	const sink = new RecordingSink();
	const runtime = new Runtime({
		store,
		captureConversation: (row) => captureConversationSettings(store, row, cfg),
		buildStep: () => {
			modelCalls++;
			return { model: fakeModel(["unused"]), system: "test" };
		},
		makeTools: () => ({}),
	});
	try {
		runtime.submit(conv, userMessage([{ type: "text", text: "test" }]), {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone(done) {
				completions++;
				sink.onDone(done);
			},
		});
		expect((await sink.done).kind).toBe("error");
		await runtime.shutdown();
		expect(modelCalls).toBe(0);
		expect(completions).toBe(1);
	} finally {
		store.close();
	}
});

describe("turn journal", () => {
	test("a completed tool loop leaves a completed run with settled call rows", async () => {
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const edge = scriptedEdge([
			[toolCallPart("call-1", "probe", "{}"), finishPart("tool-calls")],
			textParts("done"),
		]);
		const runtime = new Runtime({
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => ({ ok: true, out: "done" }),
				}),
			}),
		});
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			expect(await sink.done).toEqual({ kind: "completed" });
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			await runtime.shutdown();
			const ids = store.db.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs").all();
			expect(ids).toHaveLength(1);
			const run = journal.get(ids[0]!.run_id)!;
			expect(run.status).toBe("completed");
			expect(run.delivery).toBe("delivered");
			expect(run.finishedMs).not.toBeNull();
			expect(journal.interrupted()).toEqual([]);
			const calls = journal.callsFor(run.runId);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.toolCallId).toBe("call-1");
			expect(calls[0]!.state).toBe("completed");
			expect(calls[0]!.result).toBe('{"ok":true,"out":"done"}');
		} finally {
			store.close();
		}
	});

	test("a fenced turn stamps 'fenced' — reopen must not read it as interrupted", async () => {
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const gated = pauseFakeModelAtDelta(["a", "b", "c", "d", "e"], 1);
		const runtime = new Runtime({
			store,
			turnJournal: journal,
			buildStep: () => ({ model: gated.model, system: "test" }),
			makeTools: () => ({}),
		});
		try {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			await sink.firstDelta;
			await gated.entered;
			store.bumpEpoch(conv.id);
			gated.release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			const ids = store.db.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs").all();
			expect(ids).toHaveLength(1);
			const run = journal.get(ids[0]!.run_id)!;
			expect(run.status).toBe("fenced");
			expect(run.delivery).toBe("undelivered");
			// 'fenced' is terminal: a boot reclassify must never claim it.
			expect(journal.interrupted()).toEqual([]);
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("a journal dispatch write that throws fails the turn — later calls never execute", async () => {
		const store = openStore(tmpDb("goblin-rt-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const real = openTurnJournal(store.db);
		let dispatchNotes = 0;
		const journal: TurnJournal = {
			...real,
			noteToolDispatch(runId, callId, name, args) {
				dispatchNotes++;
				if (dispatchNotes === 2) {
					throw new Error("injected journal dispatch failure");
				}
				return real.noteToolDispatch(runId, callId, name, args);
			},
		};
		const edge = scriptedEdge([
			[toolCallPart("call-1", "probe", "{}"), finishPart("tool-calls")],
			[
				toolCallPart("call-2", "probe", "{}"),
				toolCallPart("call-3", "probe", "{}"),
				finishPart("tool-calls"),
			],
			textParts("SENTINEL-SHOULD-NOT-STREAM"),
		]);
		let executions = 0;
		const runtime = new Runtime({
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: () => ({
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executions++;
						return { ok: true };
					},
				}),
			}),
		});
		try {
			const sink = new RecordingSink();
			let dones = 0;
			const onDone = sink.onDone.bind(sink);
			sink.onDone = (d) => {
				dones++;
				onDone(d);
			};
			runtime.submit(conv, userMessage([{ type: "text", text: "hi" }]), sink);
			const done = await sink.done;
			expect(done.kind).toBe("error");
			if (done.kind === "error") {
				expect(done.message).toContain("injected journal dispatch failure");
			}
			expect(dones).toBe(1);
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			expect(dispatchNotes).toBe(2);
			expect(dones).toBe(1);
			expect(edge.streamCalls).toHaveLength(2);
			expect(edge.streamCalls[1]?.abortSignal?.aborted).toBe(true);
			expect(executions).toBe(1);
			expect(store.history(conv.id).map((m) => m.role)).not.toContain("assistant");
			const ids = store.db.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs").all();
			expect(ids).toHaveLength(1);
			const run = journal.get(ids[0]!.run_id)!;
			expect(run.status).toBe("error");
			expect(run.delivery).toBe("failed");
			const calls = journal.callsFor(run.runId);
			expect(calls.find((c) => c.toolCallId === "call-1")?.state).toBe("completed");
			expect(calls.find((c) => c.toolCallId === "call-1")?.result).toBe('{"ok":true}');
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});
});

describe("tool context", () => {
	test("makeTools receives runId and a sourceMessageId bound to owned membership", async () => {
		const store = openStore(tmpDb("goblin-rt-ctx-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const seen: { runId: string; source: string }[] = [];
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: fakeModel(["ok"]), system: "test" }),
			makeTools: (_c, _v, _r, _f, _a, context) => {
				seen.push({ runId: context!.runId, source: context!.sourceMessageId() });
				return {};
			},
		});
		const s = new RecordingSink();
		const msg = userMessage([{ type: "text", text: "hi" }]);
		runtime.submit(conv, msg, s);
		await s.done;
		expect(seen).toHaveLength(1);
		expect(seen[0]!.runId).not.toBe("");
		expect(seen[0]!.source).toBe(msg.id);
		store.close();
	});

	test("sourceMessageId follows a joined steer, never a queued stream; runId is the journal run", async () => {
		const store = openStore(tmpDb("goblin-rt-ctx2-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const gate = deferred<void>();
		const entered = deferred<void>();
		const contexts: { runId: string; sourceMessageId(): string }[] = [];
		const edge = scriptedEdge([
			[toolCallPart("c1", "probe"), finishPart("tool-calls")],
			[...textParts("done"), finishPart("stop", 10)],
			[...textParts("again"), finishPart("stop", 10)],
		]);
		const runtime = new Runtime({
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: (_c, _v, _r, _f, _a, context) => {
				contexts.push(context!);
				return {
					probe: tool({
						inputSchema: z.object({}),
						execute: async () => {
							entered.resolve();
							await gate.promise;
							return { ok: true };
						},
					}),
				};
			},
		});
		const msg1 = userMessage([{ type: "text", text: "one" }]);
		const head = new HeadlessSink();
		runtime.submit(conv, msg1, head);
		await entered.promise;
		expect(contexts).toHaveLength(1);
		expect(contexts[0]!.sourceMessageId()).toBe(msg1.id);
		const msg2 = userMessage([{ type: "text", text: "steer" }]);
		const steer = new HeadlessSink();
		runtime.submit(conv, msg2, steer);
		const msg3 = userMessage([{ type: "text", text: "queued stream" }]);
		const queued = new RecordingSink();
		runtime.submit(conv, msg3, queued);
		gate.resolve();
		await waitUntil(() => contexts[0]!.sourceMessageId() === msg2.id, "steer joins the turn");
		expect(contexts[0]!.sourceMessageId()).not.toBe(msg3.id);
		expect(await head.done).toEqual({ kind: "completed" });
		expect(journal.get(contexts[0]!.runId)).not.toBeNull();
		await queued.done;
		expect(contexts).toHaveLength(2);
		expect(contexts[1]!.sourceMessageId()).toBe(msg3.id);
		expect(contexts[1]!.runId).not.toBe(contexts[0]!.runId);
		store.close();
	});
});
