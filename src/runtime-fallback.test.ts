// The model fallback list at the runtime boundary (design/model.md →
// Model fallback list): advance only on a zero-effect failure, never
// mid-loop; the serving candidate stands in for conv.model; the wire
// never shows a withheld error; the run row keeps the operator's
// selection; the terminal error lists every miss.

import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { type LanguageModel, type ToolSet, tool } from "ai";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { Runtime, type RuntimeDeps, userMessage } from "./runtime.ts";
import type { ModelStep } from "./turn/engine.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import {
	finishPart,
	type StreamAttempt,
	scriptedModel,
	textParts,
	toolCallPart,
} from "./testkit/fake-model.ts";
import { RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import { openTurnJournal, type TurnJournal } from "./turn-journal.ts";

const quotaWall = (): APICallError =>
	new APICallError({
		message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-28 08:50:34",
		url: "https://api.z.ai/api/v1/responses",
		requestBodyValues: {},
		statusCode: 429,
		isRetryable: false,
	});

const overloaded = (): APICallError =>
	new APICallError({
		message: "server_is_overloaded",
		url: "https://chatgpt.com/backend-api/codex/responses",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: false,
	});

function lanes(scripts: Record<string, StreamAttempt[]>) {
	const models: Record<string, ReturnType<typeof scriptedModel>> = {};
	for (const [ref, attempts] of Object.entries(scripts)) models[ref] = scriptedModel(attempts);
	return models;
}

function rig(opts: {
	model: string;
	fallbacks: string[];
	models: Record<string, ReturnType<typeof scriptedModel>>;
	tools?: ToolSet;
	wrapJournal?: (journal: TurnJournal) => TurnJournal;
	compaction?: RuntimeDeps["compaction"];
}) {
	const store = openStore(tmpDb("goblin-fallback-"));
	const realJournal = openTurnJournal(store.db);
	const journal = opts.wrapJournal?.(realJournal) ?? realJournal;
	const conv = store.resolve({ kind: "app", appId: "app-fallback", chatId: 0, threadId: 0 }, "/w", {
		model: opts.model,
		thinking: "medium",
	});
	const built: string[] = [];
	const buildStep: RuntimeDeps["buildStep"] = (c): ModelStep => {
		built.push(c.model ?? "(null)");
		const m = opts.models[c.model ?? ""];
		if (m === undefined) throw new Error(`no provider for ${c.model}`);
		return { model: m.model as LanguageModel, system: "test", label: c.model ?? "", maxRetries: 0 };
	};
	const runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		buildStep,
		makeTools: () => opts.tools ?? {},
		turnJournal: journal,
		modelFallbacks: () => opts.fallbacks,
		...(opts.compaction !== undefined ? { compaction: opts.compaction } : {}),
	});
	const turn = async (text: string) => {
		const sink = new RecordingSink();
		runtime.submit(store.get(conv.id)!, userMessage([{ type: "text", text }]), sink);
		const done = await sink.done;
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		return { sink, done };
	};
	const lastRun = () => {
		const row = store.db
			.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs ORDER BY rowid DESC LIMIT 1")
			.get();
		return journal.get(row!.run_id)!;
	};
	return { store, conv, runtime, journal, built, turn, lastRun };
}

describe("model fallback list", () => {
	test("a zero-effect quota wall advances to the next model; the reply names who served", async () => {
		const models = lanes({
			"zai/glm-5.3": [quotaWall()],
			"codex/gpt-6.1-terra": [textParts("from codex")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { sink, done } = await r.turn("hello");
			expect(done).toEqual({
				kind: "completed",
				fallback: {
					servedBy: "codex/gpt-6.1-terra",
					misses: [{ ref: "zai/glm-5.3", reason: "quota exhausted" }],
				},
			});
			expect(sink.text).toBe("from codex");
			// The candidate stood in for conv.model at buildStep.
			expect(r.built).toEqual(["zai/glm-5.3", "codex/gpt-6.1-terra"]);
			// The withheld error never reached the wire.
			expect(sink.chunkTypes).not.toContain("error");
			// Finish metadata names the miss; the label names who served.
			const finish = sink.chunks.find((c) => c.type === "finish") as {
				messageMetadata?: { model?: string; fallback?: unknown };
			};
			expect(finish.messageMetadata?.model).toBe("codex/gpt-6.1-terra");
			expect(finish.messageMetadata?.fallback).toEqual({
				from: [{ ref: "zai/glm-5.3", reason: "quota exhausted" }],
			});
			// The run row keeps the operator's selection for the resume drift check.
			expect(r.lastRun().convSnapshot).toMatchObject({
				model: "codex/gpt-6.1-terra",
				configuredModel: "zai/glm-5.3",
			});
			// The stored selection is never written.
			expect(r.store.get(r.conv.id)!.model).toBe("zai/glm-5.3");
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("the next turn starts at the conversation's own model again — no hold", async () => {
		const models = lanes({
			"zai/glm-5.3": [quotaWall(), textParts("zai is back")],
			"codex/gpt-6.1-terra": [textParts("from codex")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			await r.turn("one");
			const two = await r.turn("two");
			expect(two.done).toEqual({ kind: "completed" });
			expect(two.sink.text).toBe("zai is back");
			expect(r.built).toEqual(["zai/glm-5.3", "codex/gpt-6.1-terra", "zai/glm-5.3"]);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a failure after a tool ran never falls back — never mid-loop", async () => {
		const ran: string[] = [];
		const tools: ToolSet = {
			note: tool({
				description: "note",
				inputSchema: z.object({}),
				execute: async () => {
					ran.push("note");
					return "noted";
				},
			}),
		};
		const models = lanes({
			"zai/glm-5.3": [[toolCallPart("c1", "note", "{}"), finishPart("tool-calls")], overloaded()],
			"codex/gpt-6.1-terra": [textParts("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models, tools });
		try {
			const { done, sink } = await r.turn("go");
			expect(done.kind).toBe("error");
			expect(ran).toEqual(["note"]);
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(models["codex/gpt-6.1-terra"]!.streamCalls).toHaveLength(0);
			expect(sink.chunkTypes).toContain("error");
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("every candidate failing ends with one error listing each miss; quota is not transient", async () => {
		const models = lanes({ "zai/glm-5.3": [quotaWall()], "codex/gpt-6.1-terra": [overloaded()] });
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done, sink } = await r.turn("hello");
			expect(done).toMatchObject({
				kind: "error",
				message:
					"every model failed — zai/glm-5.3: quota exhausted; codex/gpt-6.1-terra: server_is_overloaded",
				modelCalls: 0,
				transient: false,
			});
			// The held error goes out exactly once, with the full story.
			const errors = sink.chunks.filter((c) => c.type === "error");
			expect(errors).toHaveLength(1);
			expect((errors[0] as { errorText: string }).errorText).toContain("every model failed");
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a twice content-filtered request never advances — the filter rule ends the turn", async () => {
		const models = lanes({
			"zai/glm-5.3": [[finishPart("content-filter", 10)], [finishPart("content-filter", 10)]],
			"codex/gpt-6.1-terra": [textParts("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done, sink } = await r.turn("hello");
			expect(done).toMatchObject({
				kind: "error",
				message: "Provider blocked this request again after one retry.",
				modelCalls: 0,
			});
			expect(models["zai/glm-5.3"]!.streamCalls).toHaveLength(2);
			expect(models["codex/gpt-6.1-terra"]!.streamCalls).toHaveLength(0);
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(sink.chunks.filter((c) => c.type === "error")).toHaveLength(1);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a setup failure (unresolvable lane) advances too", async () => {
		const models = lanes({ "codex/gpt-6.1-terra": [textParts("from codex")] });
		const r = rig({ model: "gone/model", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done } = await r.turn("hello");
			expect(done).toMatchObject({
				kind: "completed",
				fallback: { servedBy: "codex/gpt-6.1-terra" },
			});
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("an empty list keeps today's behavior: the error reaches the wire unchanged", async () => {
		const models = lanes({ "zai/glm-5.3": [quotaWall()] });
		const r = rig({ model: "zai/glm-5.3", fallbacks: [], models });
		try {
			const { done, sink } = await r.turn("hello");
			expect(done).toMatchObject({ kind: "error", transient: false, modelCalls: 0 });
			expect((done as { message: string }).message).toContain("Limit Exhausted");
			expect(sink.chunkTypes).toContain("error");
			expect(r.lastRun().convSnapshot).toEqual({
				model: "zai/glm-5.3",
				thinking: expect.anything(),
			});
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});
	test("a journal that cannot open the run row ends the turn as a journal fault — no advance", async () => {
		const models = lanes({
			"zai/glm-5.3": [textParts("must not serve")],
			"codex/gpt-6.1-terra": [textParts("must not serve either")],
		});
		const r = rig({
			model: "zai/glm-5.3",
			fallbacks: ["codex/gpt-6.1-terra"],
			models,
			wrapJournal: (j) => ({
				...j,
				beginRun: () => {
					throw new Error("database is locked");
				},
			}),
		});
		try {
			const { done } = await r.turn("hello");
			expect(done).toMatchObject({ kind: "error" });
			const message = (done as { message: string }).message;
			expect(message).toContain("database is locked");
			expect(message).not.toContain("every model failed");
			// No candidate was built, let alone advanced to.
			expect(r.built).toEqual([]);
			expect(models["codex/gpt-6.1-terra"]!.streamCalls).toHaveLength(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a journal read failing at the fallback gate ends the turn as a journal fault — no advance", async () => {
		const models = lanes({
			"zai/glm-5.3": [quotaWall()],
			"codex/gpt-6.1-terra": [textParts("must not serve")],
		});
		let reads = 0;
		const r = rig({
			model: "zai/glm-5.3",
			fallbacks: ["codex/gpt-6.1-terra"],
			models,
			// The recovery guard's read succeeds; the gate's probe throws.
			wrapJournal: (j) => ({
				...j,
				callsFor: (runId) => {
					reads++;
					if (reads > 1) throw new Error("disk I/O error");
					return j.callsFor(runId);
				},
			}),
		});
		try {
			const { done } = await r.turn("hello");
			expect(done).toMatchObject({ kind: "error" });
			const message = (done as { message: string }).message;
			expect(message).toContain("disk I/O error");
			expect(message).not.toContain("every model failed");
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(models["codex/gpt-6.1-terra"]!.streamCalls).toHaveLength(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a context overflow never advances, even with compaction unwired", async () => {
		const overflow = new APICallError({
			message:
				"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 400,
			isRetryable: false,
		});
		const models = lanes({
			"zai/glm-5.3": [overflow],
			"codex/gpt-6.1-terra": [textParts("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done } = await r.turn("hello");
			expect(done).toMatchObject({ kind: "error", modelCalls: 0 });
			expect((done as { message: string }).message).not.toContain("every model failed");
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(models["codex/gpt-6.1-terra"]!.streamCalls).toHaveLength(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("compaction walks the list and the fold names the ref that wrote it", async () => {
		const asked: string[] = [];
		const r = rig({
			model: "zai/glm-5.3",
			fallbacks: ["codex/gpt-6.1-terra"],
			models: lanes({}),
			compaction: {
				modelRef: (c) => c.model!,
				contextWindow: () => 1000,
				summarize: async (_conv, _system, _prompt, _signal, modelRef) => {
					asked.push(modelRef);
					if (modelRef === "zai/glm-5.3") throw quotaWall();
					return `folded by ${modelRef}`;
				},
			},
		});
		try {
			const big = "x".repeat(600);
			for (let i = 0; i < 3; i++) {
				r.store.append(r.conv.id, [userMessage([{ type: "text", text: `${big} q${i}` }])]);
				r.store.append(
					r.conv.id,
					[{ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `${big} r${i}` }] }],
					{ anchorSeq: r.store.lastUserSeq(r.conv.id) },
				);
			}
			const outcome = await r.runtime.compact(r.store.get(r.conv.id)!);
			expect(outcome).toMatchObject({
				kind: "compacted",
				summary: "folded by codex/gpt-6.1-terra",
			});
			expect(asked).toEqual(["zai/glm-5.3", "codex/gpt-6.1-terra"]);
			expect(r.store.listCompactions(r.conv.id).at(-1)).toMatchObject({
				model: "codex/gpt-6.1-terra",
			});
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});
});
