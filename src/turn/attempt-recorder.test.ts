import { describe, expect, test } from "bun:test";
import type { MessageChunk } from "../message.ts";
import { TurnState } from "./state.ts";
import { emitChunk, openLive, type WireMember } from "./stream.ts";
import { openAttemptRecorder } from "./attempt-recorder.ts";
import type { StepRules } from "./step-rules.ts";
import type { TurnJournal } from "../turn-journal.ts";

function fixture(
	authority = true,
	holdZeroEffectError = false,
	journal?: TurnJournal,
) {
	const live = openLive();
	const received: MessageChunk[] = [];
	const member: WireMember = {
		seq: 1,
		message: { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
		sink: {
			delivery: "stream",
			onTextDelta() {},
			onReasoningDelta() {},
			onToolCall() {},
			onStreamChunk: (chunk) => received.push(chunk),
			onDone() {},
		},
	};
	const state = new TurnState({ convId: "attempt-test", watchdog: null, request: "hi" });
	const calls: Array<{ inputTokens: number | null; failed: boolean }> = [];
	const rules: StepRules = {
		contextFill: () => null,
		beforeCall: () => null,
		afterCall: (call) => calls.push(call),
		callFailed: async () => false,
		filterRetryUsed: () => false,
	};
	const patches: unknown[] = [];
	const deltas: string[] = [];
	const deps = {
		convId: "attempt-test",
		members: [member],
		live,
		head: {
			onTextDelta: (delta: string) => deltas.push(delta),
			onReasoningDelta() {},
			onToolCall() {},
		},
		state,
		toolCalls: [] as string[],
		digest: [] as { id: string; entry: never }[],
		seenText: false,
		steerMarkSeed: 3,
		ownedInputSeqs: [1],
		evidence: undefined,
		journal,
		runId: "run-1",
		saveStep: (patch: unknown) => patches.push(patch),
		turnStartMs: 0,
		holdZeroEffectError,
		fallbackMisses: undefined,
		rules,
		holdsAuthority: () => authority,
	};
	return {
		live,
		received,
		state,
		calls,
		patches,
		deltas,
		recorder: openAttemptRecorder(deps, "test/model", (chunk) =>
			emitChunk("attempt-test", [member], live, chunk),
		),
	};
}

describe("attempt recorder", () => {
	test("joins text parts with a separator only when the part id changes", () => {
		const { recorder, deltas } = fixture();
		recorder.textDelta("a", "hello");
		recorder.textDelta("a", " world");
		recorder.textDelta("b", "again");
		expect(deltas).toEqual(["hello", " world", "\n\n", "again"]);
		expect(recorder.seenText).toBe(true);
	});

	test("checkpoints the streamed tail at most once per second and resets it at step end", () => {
		const realNow = Date.now;
		let now = 10_000;
		Date.now = () => now;
		try {
			const { recorder, patches } = fixture();
			recorder.textDelta("a", "one");
			recorder.textDelta("a", "two");
			expect(patches).toHaveLength(1);
			now += 1_001;
			recorder.textDelta("a", "three");
			expect(patches).toHaveLength(2);
			recorder.stepEnded({
				usage: { input: 8, cacheRead: 2, cacheWrite: null, output: 3 },
				failed: false,
			});
			now += 1_001;
			recorder.textDelta("a", "next");
			expect(patches.at(-1)).toEqual({
				partial: [
					{ role: "assistant", content: [{ type: "text", text: "next" }] },
				],
			});
		} finally {
			Date.now = realNow;
		}
	});

	test("step end runs rules, saves the checkpoint, logs context, and keeps newest quota", () => {
		const { recorder, calls, patches, received } = fixture();
		recorder.appendPartial({ role: "assistant", content: "done" });
		recorder.stepEnded({
			usage: { input: 10, cacheRead: 4, cacheWrite: 2, output: 6 },
			failed: true,
			quota: {
				limitName: "requests",
				primary: { usedPercent: 60, windowMinutes: 60, resetsAt: 100 },
				secondary: null,
			},
		});
		recorder.stepEnded({
			usage: { input: 11, cacheRead: null, cacheWrite: null, output: 7 },
			failed: false,
		});
		expect(calls).toEqual([
			{ inputTokens: 10, failed: true },
			{ inputTokens: 11, failed: false },
		]);
		expect(patches[0]).toEqual({
			loopState: expect.any(Object),
			filterRetryUsed: false,
			partial: [{ role: "assistant", content: "done" }],
		});
		expect(received.filter((chunk) => chunk.type === "data-context")).toHaveLength(2);
		expect(recorder.lastInput).toBe(11);
		expect(recorder.lastCacheRead).toBeNull();
		expect(
			recorder.metadata({
				finishReason: "stop",
				forcedCompletion: null,
				usage: { input: 21, output: 13, cacheRead: 4, cacheWrite: 2 },
				promptChars: null,
			}).quota,
		).toEqual({
			limitName: "requests",
			primary: { usedPercent: 60, windowMinutes: 60, resetsAt: 100 },
			secondary: null,
		});
	});

	test("model-call accounting spends once per start and not after a dropped call", () => {
		const { recorder, state } = fixture();
		recorder.callStarted();
		recorder.spendCall();
		recorder.spendCall();
		recorder.callStarted();
		recorder.dropCall();
		recorder.spendCall();
		expect(state.snapshot().modelCalls).toBe(1);
	});

	test("error hold and context emission respect recovery and authority", () => {
		const held = fixture(true, true);
		expect(held.recorder.holdsError()).toBe(true);
		held.recorder.holdForRecovery();
		expect(held.recorder.holdsError()).toBe(false);
		held.recorder.stepEnded({
			usage: { input: 1, cacheRead: null, cacheWrite: null, output: 1 },
			failed: false,
		});
		expect(held.received).toHaveLength(0);

		const fenced = fixture(false);
		fenced.recorder.stepEnded({
			usage: { input: 1, cacheRead: null, cacheWrite: null, output: 1 },
			failed: false,
		});
		expect(fenced.received).toHaveLength(0);
	});

	test("outcomes null the window before the first step and retry reset keeps tool events", () => {
		const { recorder } = fixture();
		recorder.toolInput("call-1", "echo", {});
		recorder.resetForRetry();
		expect(
			recorder.ok({
				responseMessage: null,
				usage: null,
				finishReason: "stop",
				window: { v: 1, system: "", tools: [], messages: [], segments: {} as never },
			}),
		).toMatchObject({ kind: "ok", window: null, toolCalls: ["echo"], steps: 0 });
	});

	test("tool errors settle journaled planned calls only", () => {
		const writes: Array<{ runId: string; callId: string; error: unknown }> = [];
		const journal = {
			noteToolInput() {},
			noteToolError: (runId: string, callId: string, error: unknown) => {
				writes.push({ runId, callId, error });
			},
		} as unknown as TurnJournal;
		const { recorder } = fixture(true, false, journal);
		recorder.toolError("not-planned", "unplanned failure");
		expect(writes).toEqual([]);
		recorder.toolInput("planned", "echo", {});
		recorder.toolError("planned", "planned failure");
		expect(writes).toHaveLength(1);
		expect(writes[0]!.runId).toBe("run-1");
		expect(writes[0]!.callId).toBe("planned");
		expect(writes[0]!.error).toMatchObject({ name: "Error", message: "planned failure" });
	});
});
