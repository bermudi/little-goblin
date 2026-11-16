// The agent-children engine's observable behaviour through a real
// Runtime with a scripted fake model at the edge: spawn/settle, the
// maxRunning cap with queueing, stop, send follow-ups, and boot
// recovery. The model provider is faked; nothing else is.

import { describe, expect, test } from "bun:test";
import { GENERAL_AGENT_TYPE } from "./agent-types.ts";
import { startAgentChildren, type AgentChildren, type AgentChild } from "./agent-children.ts";
import { openStore } from "./conversation.ts";
import { Runtime } from "./runtime.ts";
import { tmpDb, useHome, waitUntil } from "./testkit.ts";
import {
	finishPart,
	scriptedModel,
	textParts,
	type ScriptedModel,
} from "./testkit/fake-model.ts";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import type { TurnSink } from "./turn/sink.ts";
import type { DevelopmentInput } from "./wake-store.ts";

// Unwrap an engine result union — the test wanted the child, not the error.
const childOf = (res: { child: AgentChild } | { error: string }): AgentChild => {
	if ("error" in res) throw new Error(res.error);
	return res.child;
};

// One scripted reply attempt: the text then the finish.
function reply(text: string): LanguageModelV4StreamPart[] {
	return [...textParts(text), finishPart("stop")];
}

// A model whose single call hangs until the test releases it — a child
// mid-task.
function gated(text: string): { model: ScriptedModel; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		model: scriptedModel([
			{
				drive: async (ctx) => {
					await gate;
					for (const part of reply(text)) ctx.enqueue(part);
					ctx.close();
				},
			},
		]),
		release,
	};
}

interface Rig {
	store: ReturnType<typeof openStore>;
	parent: ReturnType<ReturnType<typeof openStore>["resolve"]>;
	runtime: Runtime;
	engine: AgentChildren;
	recorded: DevelopmentInput[];
	queue: ScriptedModel[];
}

function rig(opts: { maxRunning?: number } = {}): Rig {
	useHome("goblin-agent-children-");
	const store = openStore(tmpDb("goblin-agent-children-"));
	// An app conversation — the one kind whose resolve persists settings,
	// so the parent carries the model the child inherits.
	const parent = store.resolve({ kind: "app", appId: "main", chatId: 0, threadId: 0 }, "/w", {
		model: "fake/parent",
		thinking: "low",
	});
	// One model per model-call, popped in call order — the test scripts
	// each turn and a call past the script fails loud.
	const queue: ScriptedModel[] = [];
	const runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		buildStep: () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("test rig: no scripted model left");
			return { model: next.model, system: "test" };
		},
		makeTools: () => ({}),
	});
	const recorded: DevelopmentInput[] = [];
	const quiet: TurnSink = {
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
		onDone() {},
	};
	const engine = startAgentChildren({
		store,
		runtime,
		record: (input) => {
			recorded.push(input);
			return { eventId: recorded.length, wakeId: 0, created: true };
		},
		bell: () => quiet,
		maxRunning: () => opts.maxRunning ?? 3,
	});
	return { store, parent, runtime, engine, recorded, queue };
}

const spawn = (r: Rig, task: string) =>
	r.engine.spawn({ parent: r.parent, type: GENERAL_AGENT_TYPE, task, tools: ["read_file"] });

describe("agent children engine", () => {
	test("spawn runs the child, settles done, wakes the parent with the fenced result", async () => {
		const r = rig();
		r.queue.push(scriptedModel([reply("CHILD RESULT")]));
		const { child, queued } = spawn(r, "do it");
		expect(queued).toBe(false);
		expect(child.status).toBe("running");
		// The child conversation carries the family marks.
		const conv = r.store.get(child.conversationId)!;
		expect(conv.parentId).toBe(r.parent.id);
		expect(conv.agentType).toBe("general");
		expect(conv.memoryExcluded).toBe(true);
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("CHILD RESULT");
		// The wake: one durable development on the parent, fenced.
		expect(r.recorded).toHaveLength(1);
		const wake = r.recorded[0]!;
		expect(wake.conversationId).toBe(r.parent.id);
		expect(wake.kind).toBe("agent");
		expect(wake.sourceKey).toBe(`agent:${child.conversationId}:1`);
		expect(wake.text).toContain("[agent: general · done]");
		expect(wake.text).toContain('<event source="agent">');
		expect(wake.text).toContain("CHILD RESULT");
		// list and read see the settled child.
		expect(r.engine.list(r.parent.id).map((c) => c.conversationId)).toEqual([
			child.conversationId,
		]);
		const read = r.engine.read(child.conversationId)!;
		expect(read.child.status).toBe("done");
		expect(read.messages.at(-1)).toMatchObject({ role: "assistant", text: "CHILD RESULT" });
		// allowlistFor serves the persisted spawn-time tools.
		expect(r.engine.allowlistFor(child.conversationId)).toEqual(["read_file"]);
		expect(r.engine.allowlistFor(r.parent.id)).toBeNull();
	});

	test("over maxRunning the spawn queues; a freed slot pumps it", async () => {
		const r = rig({ maxRunning: 1 });
		const first = gated("A DONE");
		const second = gated("B DONE");
		r.queue.push(first.model, second.model);
		const a = spawn(r, "a");
		expect(a.child.status).toBe("running");
		const b = spawn(r, "b");
		expect(b.queued).toBe(true);
		expect(b.child.status).toBe("queued");
		// Settling A frees the slot; pump starts B without a nudge. B's
		// gate opens with A's — the queue, not the gate, is what holds it.
		first.release();
		second.release();
		const sa = await r.engine.awaitSettlement(a.child.conversationId);
		expect(sa.child.status).toBe("done");
		expect(sa.result).toBe("A DONE");
		const sb = await r.engine.awaitSettlement(b.child.conversationId);
		expect(sb.child.status).toBe("done");
		expect(sb.result).toBe("B DONE");
		expect(r.recorded).toHaveLength(2);
	});

	test("stop closes a running child and a queued one, with no parent wake", async () => {
		const r = rig({ maxRunning: 1 });
		const gate = gated("NEVER SEEN");
		const queuedModel = scriptedModel([reply("QUEUED RUNS")]);
		r.queue.push(gate.model, queuedModel);
		const a = spawn(r, "a");
		const b = spawn(r, "b");
		expect(childOf(r.engine.stop(b.child.conversationId)).status).toBe("stopped");
		expect(childOf(r.engine.stop(a.child.conversationId)).status).toBe("stopped");
		// The foreground waiter resolves from the stop itself.
		const settlement = await r.engine.awaitSettlement(a.child.conversationId);
		expect(settlement.child.status).toBe("stopped");
		await waitUntil(() => !r.runtime.busy(a.child.conversationId), "child lane drains");
		// The freed slot pumps the queue — but B is stopped, so nothing
		// runs and the parent is never woken.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(r.recorded).toHaveLength(0);
		gate.release();
		await r.runtime.shutdown();
	});

	test("send to a done child runs a follow-up that settles and wakes again", async () => {
		const r = rig();
		r.queue.push(scriptedModel([reply("FIRST")]));
		const { child } = spawn(r, "one");
		await r.engine.awaitSettlement(child.conversationId);
		r.queue.push(scriptedModel([reply("SECOND")]));
		expect(childOf(r.engine.send(child.conversationId, "go again")).status).toBe("running");
		const second = await r.engine.awaitSettlement(child.conversationId);
		expect(second.child.status).toBe("done");
		expect(second.result).toBe("SECOND");
		expect(r.recorded).toHaveLength(2);
		expect(r.recorded[1]!.sourceKey).toBe(`agent:${child.conversationId}:2`);
	});

	test("send while the child runs rides that turn; the row settles once at its end", async () => {
		const r = rig();
		const gate = gated("STEER TARGET");
		r.queue.push(gate.model);
		const { child } = spawn(r, "slow");
		expect(childOf(r.engine.send(child.conversationId, "and also this")).status).toBe("running");
		gate.release();
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		// Both submitted sinks owe a done; the LAST one settles the row —
		// one wake, the child's final reply.
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("STEER TARGET");
		expect(r.recorded).toHaveLength(1);
	});

	test("a failed turn settles failed and names the error", async () => {
		const r = rig();
		r.queue.push(scriptedModel([new Error("model exploded")]));
		const { child } = spawn(r, "doomed");
		const settlement = await r.engine.awaitSettlement(child.conversationId);
		expect(settlement.child.status).toBe("failed");
		// A failed child's result slot carries the reason.
		expect(settlement.result).toBe("model exploded");
		const wake = r.recorded[0]!;
		expect(wake.text).toContain("[agent: general · failed]");
		expect(wake.text).toContain("model exploded");
	});

	test("boot recovery settles a cut child failed and pumps the queue", async () => {
		const r = rig({ maxRunning: 1 });
		const gate = gated("CUT SHORT");
		const queuedModel = scriptedModel([reply("QUEUED AFTER BOOT")]);
		r.queue.push(gate.model, queuedModel);
		const cut = spawn(r, "was running");
		const waiting = spawn(r, "was queued");
		expect(waiting.queued).toBe(true);
		// A fresh engine on the same store — the process restarted around
		// the same rows. The old runtime's lane is abandoned with its gate.
		const recorded: DevelopmentInput[] = [];
		const quiet: TurnSink = {
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onDone() {},
		};
		const after = startAgentChildren({
			store: r.store,
			runtime: r.runtime,
			record: (input) => {
				recorded.push(input);
				return { eventId: recorded.length, wakeId: 0, created: true };
			},
			bell: () => quiet,
			maxRunning: () => 1,
		});
		after.recoverAtBoot();
		expect(after.get(cut.child.conversationId)!.status).toBe("failed");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.text).toContain("[agent: general · failed]");
		expect(recorded[0]!.text).toContain("restart");
		// The queued child started on the freed slot.
		const settlement = await after.awaitSettlement(waiting.child.conversationId);
		expect(settlement.child.status).toBe("done");
		expect(settlement.result).toBe("QUEUED AFTER BOOT");
		gate.release();
		await r.runtime.shutdown();
	});
});
