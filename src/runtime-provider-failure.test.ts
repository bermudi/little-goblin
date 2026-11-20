import { describe, expect, test } from "bun:test";
import { openStore } from "./conversation.ts";
import { Runtime, type RuntimeDeps, userMessage } from "./runtime.ts";
import { claudeScript } from "./testkit/turn-script-claude.ts";
import { sdkScript } from "./testkit/turn-script-sdk.ts";
import type { ScriptCall, ScriptedModel } from "./testkit/turn-script.ts";
import { RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

function rig(model: string, fallbacks: string[], models: Record<string, ScriptedModel>) {
	const store = openStore(tmpDb("goblin-provider-failure-"));
	const journal = openTurnJournal(store.db);
	const conv = store.resolve(
		{ kind: "app", appId: "app-provider-failure", chatId: 0, threadId: 0 },
		"/w",
		{ model, thinking: "medium" },
	);
	const buildStep: RuntimeDeps["buildStep"] = (c) => {
		const scripted = models[c.model ?? ""];
		if (scripted === undefined) throw new Error(`no provider for ${c.model}`);
		return scripted.step();
	};
	const engines = [...new Map(Object.values(models).flatMap((m) => m.engines).map((e) => [e.id, e])).values()];
	const runtime = new Runtime({ engines, store, buildStep, turnJournal: journal, modelFallbacks: () => fallbacks });
	runtime.mount({ makeTools: () => ({}) });
	const turn = async () => {
		const sink = new RecordingSink();
		runtime.submit(store.get(conv.id)!, userMessage([{ type: "text", text: "hello" }]), sink);
		const done = await sink.done;
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		return { sink, done };
	};
	return { store, runtime, turn };
}

function error(message: string, status: number, quota = false): ScriptCall {
	return { kind: "fail", parts: [], error: { message, status, ...(quota ? { quota: true } : {}) } };
}

const engines = [
	{ name: "ai-sdk", create: sdkScript },
	{ name: "claude-code", create: claudeScript },
] as const;

describe.each(engines)("$name provider failure classification at runtime", ({ create }) => {
	test("a quota wall with a bland message advances to the fallback", async () => {
		const failed = create({ label: "x/under-test" });
		failed.script(create === sdkScript ? error("request refused", 402) : error("request refused", 429, true));
		const backup = sdkScript({ label: "y/backup" });
		backup.script({ kind: "reply", parts: [{ type: "text", text: "from backup" }] });
		const r = rig("x/under-test", ["y/backup"], { "x/under-test": failed, "y/backup": backup });
		try {
			const { sink, done } = await r.turn();
			expect(done).toEqual({
				kind: "completed",
				fallback: { servedBy: "y/backup", misses: [{ ref: "x/under-test", reason: "quota exhausted" }] },
			});
			expect(sink.text).toBe("from backup");
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});

	test("bland 503 is transient without fallback", async () => {
		const failed = create({ label: "x/under-test" });
		failed.script(error("upstream said no", 503));
		const r = rig("x/under-test", [], { "x/under-test": failed });
		try {
			const { done } = await r.turn();
			expect(done).toMatchObject({ kind: "error", transient: true, modelCalls: 0 });
		} finally {
			await r.runtime.shutdown();
			r.store.close();
		}
	});
});
