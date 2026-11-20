import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "../tool.ts";
import type { Message } from "../message.ts";
import { openStore } from "../conversation.ts";
import { Runtime, userMessage } from "../runtime.ts";
import { sdkScript } from "./turn-script-sdk.ts";
import { claudeScript } from "./turn-script-claude.ts";
import type { ScriptedModel } from "./turn-script.ts";
import { RecordingSink, tmpDb, waitUntil } from "../testkit.ts";

const echo = defineTool({
	description: "echo input",
	input: z.object({ message: z.string() }),
	execute: async ({ message }) => `echo:${message}`,
});
type Rig = ReturnType<typeof rig>;
function rig(model: ScriptedModel) {
	const store = openStore(tmpDb("goblin-turn-script-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const runtime = new Runtime({
		engines: model.engines,
		store,
		buildStep: () => model.step(),
	});
	runtime.mount({ makeTools: () => ({ echo }) });
	return { store, conv, runtime, model };
}
function run(r: Rig, text = "hello") {
	const sink = new RecordingSink();
	r.runtime.submit(r.conv, userMessage([{ type: "text", text }]), sink);
	return sink;
}
const textOf = (message: Message) => message.parts.flatMap((part) => part.type === "text" || part.type === "reasoning" ? [part.text] : []).join("");
const adapters = [sdkScript, claudeScript] as const;

describe("engine-neutral model scripts", () => {
	for (const make of adapters) {
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: reply is stored`, async () => {
			const model = make(); model.script({ kind: "reply", parts: [{ type: "text", text: "answer" }] });
			const r = rig(model);
			try {
				expect(await run(r).done).toMatchObject({ kind: "completed" });
				expect(r.store.history(r.conv.id).map((m) => m.role)).toEqual(["user", "assistant"]);
				expect(textOf(r.store.history(r.conv.id)[1]!)).toContain("answer");
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: tool input executes and parts persist`, async () => {
			let received = "";
			const model = make(); model.script(
				{ kind: "reply", parts: [{ type: "tool-call", toolName: "echo", input: { message: "scripted" } }] },
				{ kind: "reply", parts: [{ type: "text", text: "done" }] },
			);
			const r = rig(model);
			try {
				expect(await run(r).done).toMatchObject({ kind: "completed" });
				const parts = r.store.history(r.conv.id)[1]!.parts;
				expect(parts.some((part) => part.type === "tool-echo")).toBe(true);
				expect(textOf(r.store.history(r.conv.id)[1]!)).toContain("done");
				received = parts.map((part) => JSON.stringify(part)).join("");
				expect(received).toContain("echo:scripted");
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: reasoning is stored`, async () => {
			const model = make(); model.script({ kind: "reply", parts: [{ type: "reasoning", text: "thought" }, { type: "text", text: "answer" }] });
			const r = rig(model);
			try {
				expect(await run(r).done).toMatchObject({ kind: "completed" });
				expect(r.store.history(r.conv.id)[1]!.parts.some((part) => part.type === "reasoning" && part.text === "thought")).toBe(true);
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: empty failure stores no assistant`, async () => {
			const model = make(); model.script({ kind: "fail", parts: [], error: { message: "script failure" } });
			const r = rig(model);
			try {
				const sink = run(r);
				expect((await sink.done).kind).toBe("error");
				expect(sink.chunkTypes).toContain("error");
				expect(r.store.history(r.conv.id).map((m) => m.role)).toEqual(["user"]);
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: fail after text keeps delivered text`, async () => {
			const model = make(); model.script({ kind: "fail", parts: [{ type: "text", text: "partial" }], error: { message: "after text" } });
			const r = rig(model);
			try {
				const sink = run(r);
				expect((await sink.done).kind).toBe("error");
				expect(sink.text).toContain("partial");
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: hold blocks and releases`, async () => {
			let entered = false;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const model = make(); model.script({ kind: "hold", parts: [{ type: "text", text: "held" }], gate, entered: () => { entered = true; } });
			const r = rig(model);
			try {
				const sink = run(r);
				await waitUntil(() => entered, "script entered");
				expect(r.runtime.busy(r.conv.id)).toBe(true);
				release();
				expect(await sink.done).toMatchObject({ kind: "completed" });
			} finally { release(); await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: usage is carried in finish metadata`, async () => {
			const model = make(); model.script({ kind: "reply", parts: [{ type: "text", text: "usage" }], usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 } });
			const r = rig(model);
			try {
				const sink = run(r); await sink.done;
				const finish = sink.chunks.find((chunk) => chunk.type === "finish");
				if (model.engineId === "ai-sdk") {
					expect(finish).toMatchObject({ messageMetadata: { usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 } } });
				} else {
					// Claude reports billed input: input + cacheRead + cacheWrite.
					expect(finish).toMatchObject({ messageMetadata: { usage: { input: 16, output: 7, cacheRead: 3, cacheWrite: 2 } } });
				}
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: usage on a tool-only call is counted once`, async () => {
			const model = make();
			model.script(
				{ kind: "reply", parts: [{ type: "tool-call", toolName: "echo", input: { message: "x" } }], usage: { input: 11, output: 7 } },
				{ kind: "reply", parts: [{ type: "reasoning", text: "r" }, { type: "text", text: "after" }], usage: { input: 5, output: 3 } },
			);
			const r = rig(model);
			try {
				const sink = run(r); await sink.done;
				expect(sink.chunks.find((chunk) => chunk.type === "finish")).toMatchObject({ messageMetadata: { usage: { input: 16, output: 10 } } });
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: a tool loop continues across script() calls`, async () => {
			const model = make();
			model.script({ kind: "reply", parts: [{ type: "tool-call", toolName: "echo", input: { message: "split" } }] });
			model.script({ kind: "reply", parts: [{ type: "text", text: "later" }] });
			const r = rig(model);
			try {
				expect(await run(r).done).toMatchObject({ kind: "completed" });
				const reply = r.store.history(r.conv.id)[1]!;
				expect(reply.parts.some((part) => part.type === "tool-echo")).toBe(true);
				expect(textOf(reply)).toBe("later");
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: exhaustion names adapter`, async () => {
			const r = rig(make());
			try {
				const done = await run(r).done;
				expect(done).toMatchObject({ kind: "error" });
				expect(JSON.stringify(done)).toContain(r.model.engineId);
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: requests follow adapter contract`, async () => {
			const model = make();
			model.script(
				{ kind: "reply", parts: [{ type: "tool-call", toolName: "echo", input: { message: "request" } }] },
				{ kind: "reply", parts: [{ type: "text", text: "done" }] },
			);
			const r = rig(model);
			try {
				await run(r).done;
				if (make === sdkScript) {
					expect(model.requests()).toHaveLength(2);
				} else {
					expect(model.requests()).toBeNull();
				}
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
		test(`${make === sdkScript ? "ai-sdk" : "claude-code"}: queued scripts span turns and later script calls append`, async () => {
			const model = make();
			model.script(
				{ kind: "reply", parts: [{ type: "text", text: "first turn" }] },
				{ kind: "reply", parts: [{ type: "text", text: "second turn" }] },
			);
			const r = rig(model);
			try {
				expect(await run(r, "one").done).toMatchObject({ kind: "completed" });
				model.script({ kind: "reply", parts: [{ type: "text", text: "third turn" }] });
				expect(await run(r, "two").done).toMatchObject({ kind: "completed" });
				expect(await run(r, "three").done).toMatchObject({ kind: "completed" });
				const assistantText = r.store.history(r.conv.id)
					.filter((message) => message.role === "assistant")
					.map(textOf);
				expect(assistantText).toEqual(["first turn", "second turn", "third turn"]);
			} finally { await r.runtime.shutdown(); r.store.close(); }
		});
	}

	test("sdk finish reasons are observable; claude rejects unsupported finishes", async () => {
		for (const finish of ["length", "content-filter"] as const) {
			const model = sdkScript(); model.script(
				{ kind: "reply", parts: [], finish },
				{ kind: "reply", parts: [{ type: "text", text: "retry" }] },
			);
			const r = rig(model);
			try {
				const sink = run(r);
				expect(await sink.done).toMatchObject({ kind: "completed" });
				if (finish === "length") {
					expect(sink.chunks.find((chunk) => chunk.type === "finish")).toMatchObject({ finishReason: "length" });
				} else {
					expect(model.calls()).toBe(2);
				}
			}
			finally { await r.runtime.shutdown(); r.store.close(); }
		}
		expect(() => claudeScript().script({ kind: "reply", parts: [], finish: "content-filter" })).toThrow("claude-code");
		expect(() =>
			claudeScript().script({ kind: "fail", parts: [], error: { message: "quota", status: 429 } }),
		).not.toThrow();
		expect(() => claudeScript().script({ kind: "reply", parts: [], usage: { input: 1, output: 1 } }))
			.toThrow("claude-code cannot render usage");
	});
});
