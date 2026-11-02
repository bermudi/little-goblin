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
import { type ModelStep, Runtime, type RuntimeDeps, userMessage } from "./runtime.ts";
import {
	finishPart,
	type StreamAttempt,
	scriptedModel,
	textParts,
	toolCallPart,
} from "./testkit/fake-model.ts";
import { RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

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
}) {
	const store = openStore(tmpDb("goblin-fallback-"));
	const journal = openTurnJournal(store.db);
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
		store,
		buildStep,
		makeTools: () => opts.tools ?? {},
		turnJournal: journal,
		modelFallbacks: () => opts.fallbacks,
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
});
