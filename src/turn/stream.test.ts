import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type LanguageModel, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import {
	APICallError,
	type LanguageModelV4,
	type LanguageModelV4CallOptions,
	type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { scriptedModel as scriptedEdge } from "../testkit/fake-model.ts";
import { ATTACHMENT_PART } from "../agent/attachments.ts";
import { log } from "../log.ts";
import { LOOP_DETECT_WARN } from "../loop-detect.ts";
import { TurnState } from "./state.ts";
import {
	claimMembers,
	driveStream,
	emitChunk,
	endLive,
	joinMember,
	openLive,
	type MemberSettlement,
	type StreamDeps,
	type WireMember,
} from "./stream.ts";

const fifoDirs: string[] = [];
afterEach(() => {
	for (const d of fifoDirs) rmSync(d, { recursive: true, force: true });
	fifoDirs.length = 0;
});

test("a failed attach subscriber is logged and detached without losing the shared wire", () => {
	const warning = spyOn(log, "warn").mockImplementation(() => {});
	try {
		const live = openLive();
		const failure = new Error("subscriber disconnected");
		live.subscribers.add({
			onChunk() {
				throw failure;
			},
			onEnd() {},
		});
		const received: UIMessageChunk[] = [];
		live.subscribers.add({ onChunk: (chunk) => received.push(chunk), onEnd() {} });
		const chunk: UIMessageChunk = { type: "text-start", id: "synthetic" };
		emitChunk("app/test", [], live, chunk);
		expect(live.subscribers.size).toBe(1);
		expect(live.chunks).toEqual([chunk]);
		expect(received).toEqual([chunk]);
		expect(warning).toHaveBeenCalledWith("subscriber onChunk failed — stream detached", failure, {
			conversation: "app/test",
		});
	} finally {
		warning.mockRestore();
	}
});

function scriptedModel(scripts: Array<LanguageModelV4StreamPart[] | Error>) {
	const prompts: string[] = [];
	const toolChoices: string[] = [];
	const edge = scriptedEdge(scripts, { extra: textReply("ok") });
	const inner = edge.model as unknown as LanguageModelV4;
	const model = {
		...inner,
		doStream(o: LanguageModelV4CallOptions) {
			prompts.push(JSON.stringify(o.prompt));
			toolChoices.push(JSON.stringify(o.toolChoice ?? null));
			return inner.doStream(o);
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

function member(text: string, streaming = true, inputSeq: number | null = null): RecMember {
	const chunks: UIMessageChunk[] = [];
	return {
		message: { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] },
		// Ownership rides the durable seq, not the app-controlled id.
		inputSeq,
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
		view: {
			convId: "c1",
			tools: {},
			modalities: new Set(["text"]),
			carries: () => true,
			skillRef: () => {
				throw new Error("no skill parts expected in this fixture");
			},
		},
		claimSteers: () => queue.splice(0, queue.length),
		unrequeueSteers: (steered) => unrequeued.push(steered),
		settle: (m, done) => settlements.push({ m, done }),
		steerMarkSeed: 0,
		ownedInputSeqs: [],
		partial: null,
		seenText: false,
		toolCalls: [],
		digest: [],
		filterRetryUsed: false,
		overflowRecoverable: false,
		evidence: undefined,
		runId: "rig-run",
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
		prompts,
		toolChoices,
	};
}

// ---------- the membership seam ----------

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
		const members: RecMember[] = [];
		const claimed = claimMembers("c1", () => [joiner], live, members);
		expect(claimed).toEqual([joiner]);
		// Registration rides the claim: the joiner is on the attempt's
		// settlement surface from the splice, before admission reads on.
		expect(members).toEqual([joiner]);
		// Gapless: the joiner saw the same wire the head saw — the tool
		// call the failed attempt emitted was REPLAYED to it, not
		// mid-sentence.
		expect(joiner.chunks).toEqual(before);
	});

	test("a non-streaming member claims without replay", () => {
		const live = openLive();
		live.chunks.push({ type: "start", messageId: "m1" });
		const plain = member("quiet", false);
		const members: RecMember[] = [];
		expect(claimMembers("c1", () => [plain], live, members)).toEqual([plain]);
		expect(members).toEqual([plain]);
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
		const members: RecMember[] = [];
		expect(() => claimMembers("c1", () => [boom], live, members)).not.toThrow();
		expect(members).toEqual([boom]);
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
		endLive(live, { kind: "completed" }, "app/t");
		endLive(live, { kind: "error", message: "late" }, "app/t");
		expect(ends).toEqual(["completed"]);
		expect(live.ended).toBe(true);
	});

	test("a throwing onEnd is detached loudly, and later subscribers still get the terminal event", () => {
		const live = openLive();
		const ends: string[] = [];
		live.subscribers.add({
			onChunk: () => {},
			onEnd: () => {
				throw new Error("wire gone");
			},
		});
		live.subscribers.add({
			onChunk: () => {},
			onEnd: (d) => ends.push(d.kind),
		});
		endLive(live, { kind: "completed" }, "app/t");
		expect(ends).toEqual(["completed"]);
		expect(live.subscribers.size).toBe(0);
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

	test("turn metadata separates the billed sum from the final step's window", async () => {
		const probe = probeTool();
		const r = rig([
			toolCallStep("c1", 10),
			[
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "done" },
				{ type: "text-end", id: "t1" },
				{
					type: "finish",
					finishReason: { unified: "stop", raw: undefined },
					usage: {
						inputTokens: { total: 50, noCache: undefined, cacheRead: 40, cacheWrite: undefined },
						outputTokens: { total: 5, text: undefined, reasoning: undefined },
					},
				},
			],
		]);
		r.deps.tools = { probe };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		const md = outcome.responseMessage?.metadata as {
			usage: {
				input: number | null;
				lastInput: number | null;
				cacheRead: number | null;
				lastCacheRead: number | null;
			};
			promptChars: Record<string, number> | undefined;
		};
		// input bills every re-sent prompt across the loop; lastInput is
		// the final step — the window occupancy the gauge reads.
		expect(md.usage.input).toBe(60);
		expect(md.usage.lastInput).toBe(50);
		expect(md.usage.lastCacheRead).toBe(40);
		// The itemization measured the final step's outbound prompt.
		expect(md.promptChars).toBeDefined();
		expect(md.promptChars!["history"]).toBeGreaterThan(0);
		expect(md.promptChars!["toolDefs"]).toBeGreaterThan(0);
		expect(md.promptChars!["identity"]).toBe("test".length);
	});

	test("a submit landing mid-turn folds into the next request, joins, and is replayed", async () => {
		const probe = probeTool();
		const r = rig([toolCallStep("c1", 1), textReply("folded answer")]);
		r.deps.tools = { probe };
		const steered = member("steered mid-turn", true, 7);
		r.queue.push(steered);
		// The member carries its own durable seq — ownership advances by
		// inputSeq, never by rediscovering ids in history.
		expect(steered.inputSeq).toBe(7);
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

	test("a fence landing mid-conversion settles the successful steer — no join, no fold (#115)", async () => {
		// The steer is a photo whose conversion parks reading a FIFO — the
		// deterministic window for the epoch to die mid-await. The
		// conversion then SUCCEEDS; the success path must re-check before
		// the join, the replay, and the fold.
		const dir = mkdtempSync(join(tmpdir(), "goblin-st-fifo-"));
		fifoDirs.push(dir);
		const fifo = join(dir, "photo.png");
		execSync(`mkfifo '${fifo}'`);
		let holds = true;
		const r = rig([textReply("answer")], {
			holdsAuthority: () => holds,
			view: {
				convId: "c1",
				tools: {},
				modalities: new Set(["text", "image"]),
				carries: () => true,
				skillRef: () => {
					throw new Error("no skill parts expected in this fixture");
				},
			},
		});
		const steer = member("photo steer");
		steer.message = {
			id: "photo-steer",
			role: "user",
			parts: [
				{
					type: ATTACHMENT_PART,
					data: { path: fifo, mediaType: "image/png", filename: "photo.png", size: 7 },
				},
			],
		} as UIMessage;
		r.queue.push(steer);
		const driving = driveStream(r.deps);
		await new Promise((res) => setTimeout(res, 20)); // conversion parked on the FIFO
		holds = false; // the epoch dies while the conversion waits
		await writeFile(fifo, "pngdata");
		const outcome = await driving;
		expect(outcome.kind).toBe("ok");
		// Settled fenced like the failure branch — NOT requeued: the splice
		// already took this submit out of stop()'s reach.
		expect(r.settlements).toEqual([{ m: steer, done: { kind: "fenced" } }]);
		expect(r.unrequeued).toEqual([]);
		expect(r.members).toEqual([]);
		expect(steer.chunks).toEqual([]);
		expect(r.prompts[0]).not.toContain("photo.png");
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

	test("a rejected tool call still feeds the repeat detector — warning at threshold", async () => {
		// A provider emitting invalid input gets tool-input-error, then the
		// SDK's tool-error carrying only the id (mapped to tool-output-error).
		// Without the callById record the detector hashes each rejection under
		// a random id and never trips; with it, ten identical rejections warn.
		const input = JSON.stringify({ q: "same" });
		const oneRejection = (n: number): LanguageModelV4StreamPart[] => [
			{ type: "stream-start", warnings: [] },
			{
				type: "tool-call",
				toolCallId: `rej-${n}`,
				toolName: "probe",
				input,
				invalid: true,
				error: new Error("invalid input"),
				dynamic: false,
			} as unknown as LanguageModelV4StreamPart,
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const scripts = [
			...Array.from({ length: LOOP_DETECT_WARN }, (_, i) => oneRejection(i)),
			textReply("gave up asking"),
		];
		const badProbe = tool({
			inputSchema: z.object({ want: z.string() }),
			execute: async () => "unreachable — schema rejects first",
		});
		const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
		try {
			const r = rig(scripts);
			r.deps.tools = { probe: badProbe };
			const outcome = await driveStream(r.deps);
			expect(outcome.kind).toBe("ok");
			// Ten identical rejected calls hit the detector's warn threshold;
			// the detector's warn line fires (plus the ten rejection lines).
			const detectorWarns = warnSpy.mock.calls.filter((c) => c[0] === "loop detector");
			expect(detectorWarns).toHaveLength(1);
			expect(detectorWarns[0]![1]).toMatchObject({ tool: "probe", count: LOOP_DETECT_WARN });
			// The warning rides the next request as a Loop check tail.
			expect(r.prompts.at(-1)).toContain("Loop check:");
		} finally {
			warnSpy.mockRestore();
		}
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

	test("a script output's call record expands into script.<tool> digest entries and tool calls", async () => {
		const script = tool({
			inputSchema: z.object({ code: z.string() }),
			execute: async () => ({
				text: "Script completed in 0.1s · 2 tool calls\ndigest",
				calls: [
					{ tool: "bash", args: '{"command":"ls"}', ok: true, result: "file1" },
					{ tool: "fetch", args: '{"url":"https://x"}', ok: false, result: "dead" },
				],
			}),
		});
		const scriptStep: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-call", toolCallId: "c1", toolName: "script", input: '{"code":"x"}' },
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const r = rig([scriptStep, textReply("done")], {
			evidence: { calls: 8, argChars: 40, outChars: 60 },
		});
		r.deps.tools = { script };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		// The script itself is one call to the loop machinery; its nested
		// calls surface only in the reviewer's view.
		expect(outcome.toolCalls).toEqual(["script", "script.bash", "script.fetch"]);
		const tools = outcome.digestRing.map((d) => d.entry.tool);
		expect(tools).toEqual(["script", "script.bash", "script.fetch"]);
		const bash = outcome.digestRing[1]!.entry;
		expect(bash.ok).toBe(true);
		expect(bash.args).toContain("command");
		const fetch = outcome.digestRing[2]!.entry;
		expect(fetch.ok).toBe(false);
		expect(fetch.result).toContain("dead");
	});

	test("a completed write into the skills catalog records provenance for the turn's conversation", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-skillwatch-"));
		const recorded: Array<{ conversationId: string; skill: string }> = [];
		const writeFile = tool({
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			execute: async () => ({ path: join(ws, "skills", "foo", "SKILL.md"), bytes: 3 }),
		});
		const writeStep: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "write_file",
				input: '{"path":"skills/foo/SKILL.md","content":"x"}',
			},
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const r = rig([writeStep, textReply("done")], {
			skillWatch: {
				skillsDir: join(ws, "skills"),
				proposedDir: join(ws, "skills-proposed"),
				record: (conversationId, skill) => recorded.push({ conversationId, skill }),
			},
		});
		r.deps.tools = { write_file: writeFile };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(recorded).toEqual([{ conversationId: "c1", skill: "foo" }]);
	});

	test("a write outside the catalog records nothing", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-skillwatch-"));
		const recorded: unknown[][] = [];
		const writeFile = tool({
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			execute: async () => ({ path: join(ws, "notes", "x.md"), bytes: 3 }),
		});
		const writeStep: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "write_file",
				input: '{"path":"notes/x.md","content":"x"}',
			},
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const r = rig([writeStep, textReply("done")], {
			skillWatch: {
				skillsDir: join(ws, "skills"),
				proposedDir: join(ws, "skills-proposed"),
				record: (...args) => recorded.push(args),
			},
		});
		r.deps.tools = { write_file: writeFile };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(recorded).toEqual([]);
	});

	test("a script's nested write into the catalog records provenance — the seam adc003fd pinned", async () => {
		const ws = mkdtempSync(join(tmpdir(), "goblin-skillwatch-"));
		const recorded: Array<{ conversationId: string; skill: string }> = [];
		const script = tool({
			inputSchema: z.object({ code: z.string() }),
			execute: async () => ({
				text: "done",
				calls: [
					{
						tool: "write_file",
						args: '{"path":"skills/nested/SKILL.md","content":"x"}',
						ok: true,
						result: JSON.stringify({ path: join(ws, "skills/nested/SKILL.md"), bytes: 1 }),
					},
				],
			}),
		});
		const scriptStep: LanguageModelV4StreamPart[] = [
			{ type: "stream-start", warnings: [] },
			{ type: "tool-call", toolCallId: "c1", toolName: "script", input: '{"code":"x"}' },
			{
				type: "finish",
				finishReason: { unified: "tool-calls", raw: undefined },
				usage: {
					inputTokens: {
						total: 1,
						noCache: undefined,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: undefined, reasoning: undefined },
				},
			},
		];
		const r = rig([scriptStep, textReply("done")], {
			skillWatch: {
				skillsDir: join(ws, "skills"),
				proposedDir: join(ws, "skills-proposed"),
				record: (conversationId, skill) => recorded.push({ conversationId, skill }),
			},
		});
		r.deps.tools = { script };
		const outcome = await driveStream(r.deps);
		expect(outcome.kind).toBe("ok");
		expect(recorded).toEqual([{ conversationId: "c1", skill: "nested" }]);
	});
});
