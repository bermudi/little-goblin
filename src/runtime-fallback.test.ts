import { foldSummary } from "./testkit/fake-summary.ts";
import { describe, expect, test } from "bun:test";
import { defineTool, type Tools } from "./tool.ts";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { Runtime, type RuntimeDeps, userMessage } from "./runtime.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import { sdkScript } from "./testkit/turn-script-sdk.ts";
import type { ScriptCall, ScriptedModel } from "./testkit/turn-script.ts";
import { RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import { openTurnJournal, type TurnJournal } from "./turn-journal.ts";

const quotaWall = (): ScriptCall => ({ kind: "fail", parts: [], error: { message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-28 08:50:34", status: 429 } });
const overloaded = (): ScriptCall => ({ kind: "fail", parts: [], error: { message: "server_is_overloaded", status: 503 } });
const reply = (text: string): ScriptCall => ({ kind: "reply", parts: [{ type: "text", text }] });
function lanes(scripts: Record<string, ScriptCall[]>) {
	const models: Record<string, ScriptedModel> = {};
	for (const [ref, calls] of Object.entries(scripts)) {
		const model = sdkScript({ label: ref });
		model.script(...calls);
		models[ref] = model;
	}
	return models;
}

function rig(opts: {
	model: string;
	fallbacks: string[];
	models: Record<string, ScriptedModel>;
	tools?: Tools;
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
	const buildStep: RuntimeDeps["buildStep"] = (c) => {
		built.push(c.model ?? "(null)");
		const m = opts.models[c.model ?? ""];
		if (m === undefined) throw new Error(`no provider for ${c.model}`);
		return m.step();
	};
	const runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		buildStep,
		turnJournal: journal,
		modelFallbacks: () => opts.fallbacks,
		...(opts.compaction !== undefined ? { compaction: opts.compaction } : {}),
	});
	runtime.mount({ makeTools: () => opts.tools ?? {} });
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
			"codex/gpt-6.1-terra": [reply("from codex")],
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
			expect(r.built).toEqual(["zai/glm-5.3", "codex/gpt-6.1-terra"]);
			expect(sink.chunkTypes).not.toContain("error");
			const finish = sink.chunks.find((c) => c.type === "finish") as {
				messageMetadata?: { model?: string; fallback?: unknown };
			};
			expect(finish.messageMetadata?.model).toBe("codex/gpt-6.1-terra");
			expect(finish.messageMetadata?.fallback).toEqual({
				from: [{ ref: "zai/glm-5.3", reason: "quota exhausted" }],
			});
			expect(r.lastRun().convSnapshot).toMatchObject({
				model: "codex/gpt-6.1-terra",
				configuredModel: "zai/glm-5.3",
			});
			expect(r.store.get(r.conv.id)!.model).toBe("zai/glm-5.3");
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("the next turn starts at the conversation's own model again — no hold", async () => {
		const models = lanes({
			"zai/glm-5.3": [quotaWall(), reply("zai is back")],
			"codex/gpt-6.1-terra": [reply("from codex")],
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
		const tools: Tools = {
			note: defineTool({
				description: "note",
				input: z.object({}),
				execute: async () => {
					ran.push("note");
					return "noted";
				},
			}),
		};
		const models = lanes({
			"zai/glm-5.3": [{ kind: "reply", parts: [{ type: "tool-call", toolName: "note", input: {} }] }, overloaded()],
			"codex/gpt-6.1-terra": [reply("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models, tools });
		try {
			const { done, sink } = await r.turn("go");
			expect(done.kind).toBe("error");
			expect(ran).toEqual(["note"]);
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(models["codex/gpt-6.1-terra"]!.calls()).toBe(0);
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
			"zai/glm-5.3": [
				{ kind: "reply", parts: [], finish: "content-filter" },
				{ kind: "reply", parts: [], finish: "content-filter" },
			],
			"codex/gpt-6.1-terra": [reply("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done, sink } = await r.turn("hello");
			expect(done).toMatchObject({
				kind: "error",
				message: "Provider blocked this request again after one retry.",
				modelCalls: 0,
			});
			expect(models["zai/glm-5.3"]!.calls()).toBe(2);
			expect(models["codex/gpt-6.1-terra"]!.calls()).toBe(0);
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(sink.chunks.filter((c) => c.type === "error")).toHaveLength(1);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a setup failure (unresolvable lane) advances too", async () => {
		const models = lanes({ "codex/gpt-6.1-terra": [reply("from codex")] });
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
			"zai/glm-5.3": [reply("must not serve")],
			"codex/gpt-6.1-terra": [reply("must not serve either")],
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
			expect(r.built).toEqual([]);
			expect(models["codex/gpt-6.1-terra"]!.calls()).toBe(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a journal read failing at the fallback gate ends the turn as a journal fault — no advance", async () => {
		const models = lanes({
			"zai/glm-5.3": [quotaWall()],
			"codex/gpt-6.1-terra": [reply("must not serve")],
		});
		let reads = 0;
		const r = rig({
			model: "zai/glm-5.3",
			fallbacks: ["codex/gpt-6.1-terra"],
			models,
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
			expect(models["codex/gpt-6.1-terra"]!.calls()).toBe(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("a context overflow never advances, even with compaction unwired", async () => {
		const models = lanes({
			"zai/glm-5.3": [{
				kind: "fail",
				parts: [],
				error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", status: 400 },
			}],
			"codex/gpt-6.1-terra": [reply("must not serve")],
		});
		const r = rig({ model: "zai/glm-5.3", fallbacks: ["codex/gpt-6.1-terra"], models });
		try {
			const { done } = await r.turn("hello");
			expect(done).toMatchObject({ kind: "error", modelCalls: 0 });
			expect((done as { message: string }).message).not.toContain("every model failed");
			expect(r.built).toEqual(["zai/glm-5.3"]);
			expect(models["codex/gpt-6.1-terra"]!.calls()).toBe(0);
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("compaction never walks the list: a down primary fails the fold and writes nothing (#871)", async () => {
		const asked: string[] = [];
		let primaryDown = true;
		const r = rig({
			model: "zai/glm-5.3",
			fallbacks: ["codex/gpt-6.1-terra"],
			models: lanes({}),
			compaction: {
				modelRef: (c) => c.model!,
				contextWindow: () => 1000,
				summarize: async (_conv, _system, prompt, _signal, modelRef) => {
					asked.push(modelRef);
					if (primaryDown && modelRef === "zai/glm-5.3") throw new Error("Weekly/Monthly Limit Exhausted");
					return foldSummary(`folded by ${modelRef}`, prompt);
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
			await expect(r.runtime.compact(r.store.get(r.conv.id)!)).rejects.toThrow(/^Weekly\/Monthly Limit Exhausted$/);
			expect(asked).toEqual(["zai/glm-5.3"]);
			expect(r.store.listCompactions(r.conv.id)).toEqual([]);

			primaryDown = false;
			asked.length = 0;
			const outcome = await r.runtime.compact(r.store.get(r.conv.id)!);
			expect(outcome).toMatchObject({ kind: "compacted" });
			if (outcome.kind === "compacted") {
				expect(outcome.summary).toStartWith("folded by zai/glm-5.3\n");
			}
			expect(asked).toEqual(["zai/glm-5.3"]);
			expect(r.store.listCompactions(r.conv.id).at(-1)).toMatchObject({
				model: "zai/glm-5.3",
			});
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});
});
