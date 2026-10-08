// Stream driver boundary tests (design/runtime-turn.md → test
// migration): the membership seam — #96's regression home, moved here
// from runtime.test.ts when the claim+replay got its one home — plus
// the steer fold's mechanics, fan-out/wire-log semantics, and the
// failed-outcome handoff. Landing decisions live in state.test.ts; the
// sink contract (exactly one onDone) and ownership-mark semantics stay
// e2e in runtime.test.ts.

import { describe, expect, test } from "bun:test";
import { tool, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { TurnState } from "./state.ts";
import {
	claimMembers,
	driveStream,
	endLive,
	joinMember,
	openLive,
	type MemberSettlement,
	type StreamDeps,
	type WireMember,
} from "./stream.ts";

// Fake the model at the provider edge (the suite's one fake): a script
// per doStream call — parts stream verbatim, an Error throws (a
// provider rejection the SDK surfaces as an error chunk). Every wire
// prompt and toolChoice is captured.
function scriptedModel(scripts: Array<LanguageModelV4StreamPart[] | Error>) {
	const prompts: string[] = [];
	const toolChoices: string[] = [];
	let calls = 0;
	const model = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "fake-1",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unimplemented");
		},
		doStream(o: { prompt: unknown; toolChoice?: unknown }) {
			prompts.push(JSON.stringify(o.prompt));
			toolChoices.push(JSON.stringify(o.toolChoice ?? null));
			const script = scripts[calls++] ?? textReply("ok");
			if (script instanceof Error) throw script;
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const p of script) controller.enqueue(p);
						controller.close();
					},
				}),
			};
		},
	} as unknown as LanguageModel;
	return { model, prompts, toolChoices };
}

function textReply(text: string): LanguageModelV4StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
		},
	];
}

function toolCallStep(id: string, inputTokens: number): LanguageModelV4StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "tool-call", toolCallId: id, toolName: "probe", input: "{}" },
		{
			type: "finish",
			finishReason: { unified: "tool-calls", raw: undefined },
			usage: {
				inputTokens: {
					total: inputTokens,
					noCache: undefined,
					cacheRead: undefined,
					cacheWrite: undefined,
				},
				outputTokens: { total: 1, text: undefined, reasoning: undefined },
			},
		},
	];
}

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

// Verbatim Telegram warning the filter classifier matches.
const filterWarning =
	"[System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation.][20261005061517b57fc824";

// A turn member with the wire's view of a sink: records every chunk it
// receives (replay or live).
interface RecMember extends WireMember {
	chunks: UIMessageChunk[];
}

function member(text: string, streaming = true): RecMember {
	const chunks: UIMessageChunk[] = [];
	return {
		message: { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] },
		sink: streaming ? { onStreamChunk: (c) => chunks.push(c) } : {},
		chunks,
	};
}

function headSink() {
	return {
		text: "",
		calls: [] as Array<{ tool: string; input: unknown }>,
		onTextDelta(d: string) {
			this.text += d;
		},
		onReasoningDelta() {},
		onToolCall(toolName: string, input: unknown) {
			this.calls.push({ tool: toolName, input });
		},
	};
}

function probeTool() {
	return tool({
		inputSchema: z.object({}),
		execute: async () => "probe-result-7f3a",
	});
}

// The driver's dependency rig: everything attempt-shaped is fake and
// inspectable — no store, no lanes, no runtime.
function rig(
	scripts: Array<LanguageModelV4StreamPart[] | Error>,
	over: Partial<StreamDeps<RecMember>> = {},
) {
	const { model, prompts, toolChoices } = scriptedModel(scripts);
	const live = openLive();
	const head = headSink();
	const members: RecMember[] = [];
	const queue: RecMember[] = [];
	const settlements: Array<{ m: RecMember; done: MemberSettlement }> = [];
	const unrequeued: RecMember[][] = [];
	const entries: Array<{ seq: number; message: UIMessage }> = [];
	const deps: StreamDeps<RecMember> = {
		convId: "c1",
		epoch: 1,
		head,
		members,
		live,
		state: new TurnState({ convId: "c1", watchdog: null, request: "run the thing" }),
		assertAuthority: () => {},
		holdsAuthority: () => true,
		step: { model, system: "test" },
		messages: [{ role: "user", content: "run the thing" }],
		tools: {},
		view: { convId: "c1", tools: {}, modalities: new Set(["text"]), carries: () => true },
		claimSteers: () => queue.splice(0, queue.length),
		unrequeueSteers: (steered) => unrequeued.push(steered),
		settle: (m, done) => settlements.push({ m, done }),
		modelEntries: () => entries,
		steerMarkSeed: 0,
		partial: null,
		seenText: false,
		toolCalls: [],
		digest: [],
		filterRetryUsed: false,
		overflowRecoverable: false,
		evidence: undefined,
		turnStartMs: 0,
		signal: new AbortController().signal,
		...over,
	};
	return {
		deps,
		head,
		members,
		live,
		queue,
		settlements,
		unrequeued,
		entries,
		prompts,
		toolChoices,
	};
}

// ---------- the membership seam (#96's regression home) ----------

describe("membership seam", () => {
	test("a streaming member claimed by the resume sees the pre-overflow wire replayed (#96)", () => {
		// Attempt 1 streamed a tool call onto the wire, then overflowed;
		// the compaction now holds the lane. A second client submitted
		// during that recovery window — the resume claim goes through
		// the seam.
		const live = openLive();
		const before: UIMessageChunk[] = [
			{ type: "start", messageId: "m1" },
			{ type: "tool-input-available", toolCallId: "c1", toolName: "probe", input: {} },
		];
		live.chunks.push(...before);
		const joiner = member("joined mid-recovery");
		const claimed = claimMembers("c1", () => [joiner], live);
		expect(claimed).toEqual([joiner]);
		// Gapless: the joiner saw the same wire the head saw — the tool
		// call the failed attempt emitted was REPLAYED to it, not
		// mid-sentence (design/app.md → Join replay).
		expect(joiner.chunks).toEqual(before);
	});

	test("a non-streaming member claims without replay", () => {
		const live = openLive();
		live.chunks.push({ type: "start", messageId: "m1" });
		const plain = member("quiet", false);
		expect(claimMembers("c1", () => [plain], live)).toEqual([plain]);
		expect(plain.chunks).toEqual([]);
	});

	test("a dead streaming client is detached during replay — never fatal", () => {
		const live = openLive();
		live.chunks.push(
			{ type: "start", messageId: "m1" },
			{ type: "text-delta", id: "t1", delta: "a" },
		);
		const boom = member("boom");
		boom.sink.onStreamChunk = () => {
			throw new Error("dead client");
		};
		expect(() => claimMembers("c1", () => [boom], live)).not.toThrow();
		expect(boom.streamFailed).toBe(true);
	});

	test("joinMember: a converted steer joins the membership and sees the whole wire", () => {
		const live = openLive();
		live.chunks.push({ type: "start", messageId: "m1" });
		const head = member("head");
		const members = [head];
		const steer = member("late joiner");
		joinMember("c1", live, members, steer);
		expect(members).toEqual([head, steer]);
		expect(steer.chunks).toEqual(live.chunks);
	});

	test("endLive fires onEnd once per subscriber and retires the log", () => {
		const live = openLive();
		const ends: string[] = [];
		live.subscribers.add({
			onChunk: () => {},
			onEnd: (d) => ends.push(d.kind),
		});
		endLive(live, { kind: "completed" });
		endLive(live, { kind: "error", message: "late" });
		expect(ends).toEqual(["completed"]);
		expect(live.ended).toBe(true);
	});
});

// ---------- the driver ----------

describe("driveStream", () => {
	test("deltas reach the head, chunks fan out to every streaming member, the wire logs them", async () => {
		const r = rig([textReply("the answer")]);
		const head = member("head");
		r.members.push(head);
		const subChunks: UIMessageChunk[] = [];
		r.live.subscribers.add({ onChunk: (c) => subChunks.push(c), onEnd: () => {} });
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(r.head.text).toBe("the answer");
		// One emission point: the member, the wire log, and the attached
		// subscriber all saw the same chunks in order.
		expect(head.chunks.length).toBeGreaterThan(0);
		expect(r.live.chunks).toEqual(head.chunks);
		expect(subChunks).toEqual(head.chunks);
		const text = outcome.responseMessage?.parts.find((p) => p.type === "text") as
			| { text: string }
			| undefined;
		expect(text?.text).toBe("the answer");
	});

	test("a throwing member sink is detached from the fan-out — never fatal", async () => {
		const r = rig([textReply("the answer")]);
		const healthy = member("healthy");
		const dead = member("dead");
		dead.sink.onStreamChunk = () => {
			throw new Error("dead client");
		};
		r.members.push(healthy, dead);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(dead.streamFailed).toBe(true);
		expect(healthy.chunks.length).toBeGreaterThan(0);
	});

	test("a submit landing mid-turn folds into the next request, joins, and is replayed", async () => {
		const probe = probeTool();
		const r = rig([toolCallStep("c1", 1), textReply("folded answer")]);
		r.deps.tools = { probe };
		const steered = member("steered mid-turn");
		r.queue.push(steered);
		// Durable history: the steered message at seq 7, an unclaimed
		// submit above it at seq 9 — the mark advances by identity, not
		// position.
		r.entries.push(
			{ seq: 7, message: steered.message },
			{
				seq: 9,
				message: {
					id: "u-other",
					role: "user",
					parts: [{ type: "text", text: "queued not steered" }],
				},
			},
		);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(r.prompts[1]).toContain("steered mid-turn");
		expect(r.members).toContain(steered);
		expect(r.settlements).toEqual([]);
		// The joiner saw step 1's wire (the tool call) replayed, then the
		// live answer — the seam's promise end to end.
		expect(steered.chunks.some((c) => c.type === "tool-input-available")).toBe(true);
		expect(steered.chunks.some((c) => c.type === "text-delta")).toBe(true);
		expect(outcome.steerMark).toBe(7);
	});

	test("a fenced claim goes back to the queue — no join, no fold", async () => {
		const r = rig([textReply("answer")], { holdsAuthority: () => false });
		const steered = member("fenced steer");
		r.queue.push(steered);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(r.unrequeued).toEqual([[steered]]);
		expect(r.members).toEqual([]);
		expect(r.prompts[0]).not.toContain("fenced steer");
	});

	test("a steer that cannot convert is settled with an error — it never joins the wire", async () => {
		const r = rig([textReply("answer")]);
		const poison = member("poison");
		// A file part with an invalid URL — materializeAttachments
		// passes it through untouched, convertToModelMessages throws.
		poison.message = {
			id: "poison",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as UIMessage;
		r.queue.push(poison);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(r.settlements.length).toBe(1);
		const settled = r.settlements[0]!.done;
		expect(settled.kind).toBe("error");
		if (settled.kind !== "error") return;
		expect(settled.message).toContain("could not be prepared");
		expect(r.members).toEqual([]);
		expect(poison.chunks).toEqual([]);
		expect(r.prompts[0]).not.toContain("read this");
	});

	test("an overflow on a recoverable attempt holds the failure off the wire for the resume", async () => {
		const r = rig([overflowError()], { overflowRecoverable: true });
		const head = member("head");
		r.members.push(head);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.holdForRecovery).toBe(true);
		expect(outcome.errorText).toBeTruthy();
		expect(outcome.loop.detector).toBeDefined();
		// The error chunk — and everything after — stayed off the wire.
		expect(r.live.chunks.some((c) => c.type === "error")).toBe(false);
		expect(head.chunks).toEqual(r.live.chunks);
	});

	test("an unrecoverable failure reaches the wire and reports its text", async () => {
		const r = rig([overflowError()]);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.holdForRecovery).toBe(false);
		expect(outcome.errorText).toContain("maximum context length");
		expect(r.live.chunks.some((c) => c.type === "error")).toBe(true);
	});

	test("a content-filtered attempt retries the identical request once and hides the error", async () => {
		const blocked: LanguageModelV4StreamPart = { type: "error", error: new Error(filterWarning) };
		const r = rig([[blocked], textReply("recovered")]);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(r.prompts).toHaveLength(2);
		expect(r.prompts[0]).toBe(r.prompts[1]);
		expect(r.live.chunks.some((c) => c.type === "error")).toBe(false);
	});

	test("a second filter exhausts the budget — the outcome reports the retry was spent", async () => {
		const blocked: LanguageModelV4StreamPart = { type: "error", error: new Error(filterWarning) };
		const r = rig([[blocked], [blocked]]);
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.filterRetryUsed).toBe(true);
		expect(outcome.errorText).toContain("blocked this request again");
	});

	test("a decided cut issues the tools-off landing: nudge tail, toolChoice none, exactly one step", async () => {
		const probe = probeTool();
		// Step 1 at 900/1000 of the window decides the cut; step 2 defies
		// toolChoice none (tool-calls finish) — stopWhen still ends the
		// loop after the one forced step.
		const r = rig([toolCallStep("c1", 900), toolCallStep("c2", 900)]);
		r.deps.step = { ...r.deps.step, contextWindow: 1000 };
		r.deps.tools = { probe };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(r.prompts).toHaveLength(2);
		expect(r.prompts[1]).toContain("context window is nearly full");
		expect(r.toolChoices[1]).toContain("none");
	});

	test("a fence mid-stream rejects the drive — the authority check is per chunk", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((res) => {
			release = res;
		});
		const parked = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "parked",
			supportedUrls: {},
			doGenerate() {
				throw new Error("unimplemented");
			},
			doStream() {
				return {
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						async start(controller) {
							const push = (p: LanguageModelV4StreamPart) => {
								try {
									controller.enqueue(p);
								} catch {
									/* reader gone — the drive threw */
								}
							};
							push({ type: "stream-start", warnings: [] });
							push({ type: "text-start", id: "t1" });
							push({ type: "text-delta", id: "t1", delta: "partial" });
							await gate;
							push({ type: "text-end", id: "t1" });
							push({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: {
										total: 1,
										noCache: undefined,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: { total: 1, text: undefined, reasoning: undefined },
								},
							});
							try {
								controller.close();
							} catch {
								/* already closed */
							}
						},
					}),
				};
			},
		} as unknown as LanguageModel;
		let holds = true;
		const r = rig([], {
			assertAuthority: () => {
				if (!holds) throw new Error("epoch advanced");
			},
			holdsAuthority: () => holds,
		});
		r.deps.step = { model: parked, system: "test" };
		const driving = driveStream(r.deps);
		await new Promise((res) => setTimeout(res, 20)); // first delta consumed, loop parked
		holds = false;
		release();
		await expect(driving).rejects.toThrow("epoch advanced");
	});

	test("the digest ring captures bounded evidence while the stream lives", async () => {
		const probe = probeTool();
		const r = rig([toolCallStep("c1", 1), textReply("done")], {
			evidence: { calls: 2, argChars: 40, outChars: 60 },
		});
		r.deps.tools = { probe };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(outcome.toolCalls).toEqual(["probe"]);
		expect(outcome.digestRing.length).toBe(1);
		expect(outcome.digestRing[0]!.entry.tool).toBe("probe");
		expect(outcome.digestRing[0]!.entry.result).toContain("probe-result-7f3a");
		expect(outcome.digestRing[0]!.entry.ok).toBe(true);
	});
});
