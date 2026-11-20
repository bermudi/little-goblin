// Test support only — only *.test.ts files import this.
//
// A scriptable ClaudeQuery: the engine's injectable query seam driven by
// declarative steps that translate into the pinned event sequences the
// real CLI emits (translate.ts shapes — no vendor import, boundary-safe).
// Tool steps run a caller-supplied closure (the engine test wires the
// real bridge's invoke) and echo its outcome, exercising the full
// tool_use → bridge execution → tool_result adoption path. Steers the
// engine pushes during a tool step are drained right after it; `ack`
// and `result` steps script how the CLI answers them (live behaviour:
// design/model.md → claude-code).

import type {
	ClaudeAssistantEvent,
	ClaudeContentBlock,
	ClaudeEvent,
	ClaudeQuery,
	ClaudeQueryCall,
	ClaudeResultEvent,
	ClaudeSteer,
	ClaudeStreamEvent,
	ClaudeUsage,
} from "../agent/claude-code/translate.ts";

export interface FakeUsageInput {
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	ephemeral5m?: number | null;
	ephemeral1h?: number | null;
}

function usage(u: FakeUsageInput = {}): ClaudeUsage {
	return {
		input_tokens: u.inputTokens ?? 100,
		output_tokens: u.outputTokens ?? 10,
		cache_read_input_tokens: u.cacheRead ?? null,
		cache_creation_input_tokens: u.cacheWrite ?? null,
		...(u.ephemeral5m !== undefined || u.ephemeral1h !== undefined
			? {
					cache_creation: {
						...(u.ephemeral5m !== undefined ? { ephemeral_5m_input_tokens: u.ephemeral5m } : {}),
						...(u.ephemeral1h !== undefined ? { ephemeral_1h_input_tokens: u.ephemeral1h } : {}),
					},
				}
			: {}),
	};
}

export type FakeStep =
	| {
			kind: "stream-text";
			text: string;
			usage?: FakeUsageInput;
			deltaUsage?: FakeUsageInput;
			/** Stall after the text streams, before the block closes: the step is mid-stream. */
			hold?: { onEnter?: () => void; until: Promise<void> };
	  }
	| { kind: "text"; text: string; usage?: FakeUsageInput }
	| { kind: "reasoning"; text: string; usage?: FakeUsageInput }
	| {
			kind: "tool";
			name: string;
			input: unknown;
			/** Runs the real execution (bridge.invoke) between call and echo. */
			run?: () => Promise<{ output: unknown; error: string | null }>;
			/** Echo payload when no adoption should apply (fallback rendering). */
			content?: string;
			isError?: boolean;
			usage?: FakeUsageInput;
	  }
	| {
			kind: "error";
			/** Throw from the query instead of a clean result frame. */
			throw?: Error;
			/** A clean result frame with is_error — the CLI's error result. */
			resultText?: string;
			assistantError?: string;
	  }
	| {
			/** Provider silence: yields nothing until `until` resolves. */
			kind: "hold";
			/** Fires when the hold is reached — the test's inside-the-call signal. */
			onEnter?: () => void;
			until: Promise<void>;
	  }
	| { kind: "raw"; events: ClaudeEvent[] }
	/** The CLI acks every drained, unacked steer (a `folded` frame). */
	| { kind: "ack" }
	/** A mid-script success result — the CLI turn ends, a follow-up may run. */
	| { kind: "result"; usage?: FakeUsageInput };

export interface FakeClaudeHandle {
	query: ClaudeQuery;
	/** One entry per query() call, in order. */
	calls: ClaudeQueryCall[];
	/** Every assistant-frame uuid emitted, in order — the #418 head anchors. */
	assistantUuids: string[];
	/** Every steer the engine pushed, in order, drained after tool steps. */
	steers: ClaudeSteer[];
	/** Script for the NEXT uncalled turn (tests usually script one). */
	script(steps: FakeStep[]): void;
	/** Per-call scripts consumed in order — resume-failure retries need two. */
	scriptSequence(scripts: FakeStep[][]): void;
}

let blockSeq = 0;
const nextId = (p: string): string => `${p}-fake-${(blockSeq += 1)}`;

export function fakeClaude(initial: FakeStep[] = []): FakeClaudeHandle {
	const calls: ClaudeQueryCall[] = [];
	const assistantUuids: string[] = [];
	const steers: ClaudeSteer[] = [];
	let nextScript: FakeStep[] | null = initial.length > 0 ? initial : null;
	let scriptQueue: FakeStep[][] = [];
	const noteUuid = (uuid: string): string => {
		assistantUuids.push(uuid);
		return uuid;
	};

	const stepEvents = async function* (
		steps: FakeStep[],
		call: ClaudeQueryCall,
	): AsyncGenerator<ClaudeEvent> {
		let unacked: string[] = [];
		const resultUsage: ClaudeUsage = {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
		};
		let turns = 0;
		const accumulate = (u: Partial<ClaudeUsage> | undefined): void => {
			if (u === undefined) return;
			resultUsage.input_tokens = (resultUsage.input_tokens ?? 0) + (u.input_tokens ?? 0);
			resultUsage.output_tokens = (resultUsage.output_tokens ?? 0) + (u.output_tokens ?? 0);
		};
		const deltaUsage = (u: FakeUsageInput | undefined): Partial<ClaudeUsage> | null =>
			u === undefined
				? null
				: {
						...(u.inputTokens !== undefined ? { input_tokens: u.inputTokens } : {}),
						...(u.outputTokens !== undefined ? { output_tokens: u.outputTokens } : {}),
						...(u.cacheRead !== undefined ? { cache_read_input_tokens: u.cacheRead } : {}),
						...(u.cacheWrite !== undefined ? { cache_creation_input_tokens: u.cacheWrite } : {}),
						...(u.ephemeral5m !== undefined || u.ephemeral1h !== undefined
							? {
									cache_creation: {
										...(u.ephemeral5m !== undefined
											? { ephemeral_5m_input_tokens: u.ephemeral5m }
											: {}),
										...(u.ephemeral1h !== undefined
											? { ephemeral_1h_input_tokens: u.ephemeral1h }
											: {}),
									},
								}
							: {}),
					};
		for (const step of steps) {
			turns += 1;
			switch (step.kind) {
				case "stream-text": {
					const u = usage(step.usage);
					const delta = deltaUsage(step.deltaUsage);
					accumulate(delta ?? u);
					yield {
						type: "stream",
						event: { type: "message_start", message: { model: "fake", usage: u } },
					};
					yield {
						type: "stream",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text" },
						},
					};
					// Two deltas so part-id continuity is exercised; one when
					// held, so the whole text is on the wire (and in the first
					// throttled tail checkpoint) at onEnter.
					const mid = step.hold === undefined ? Math.ceil(step.text.length / 2) : step.text.length;
					for (const piece of [step.text.slice(0, mid), step.text.slice(mid)]) {
						if (piece === "") continue;
						yield {
							type: "stream",
							event: {
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: piece },
							},
						};
					}
					if (step.hold !== undefined) {
						step.hold.onEnter?.();
						await step.hold.until;
					}
					yield {
						type: "stream",
						event: { type: "content_block_stop", index: 0 },
					};
					yield {
						type: "stream",
						event: {
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: delta,
						},
					};
					yield { type: "stream", event: { type: "message_stop" } };
					yield {
						type: "assistant",
						uuid: noteUuid(nextId("uuid")),
						message: {
							id: nextId("msg"),
							model: "fake",
							role: "assistant",
							content: [{ type: "text", text: step.text }],
							stop_reason: "end_turn",
							usage: u,
						},
					};
					break;
				}
				case "text":
				case "reasoning": {
					const u = usage(step.usage);
					accumulate(u);
					const block: ClaudeContentBlock =
						step.kind === "text"
							? { type: "text", text: step.text }
							: { type: "thinking", thinking: step.text };
					yield {
						type: "assistant",
						uuid: noteUuid(nextId("uuid")),
						message: {
							id: nextId("msg"),
							model: "fake",
							role: "assistant",
							content: [block],
							stop_reason: "end_turn",
							usage: u,
						},
					};
					break;
				}
				case "tool": {
					const u = usage(step.usage);
					accumulate(u);
					const id = nextId("toolu");
					yield {
						type: "assistant",
						uuid: noteUuid(nextId("uuid")),
						message: {
							id: nextId("msg"),
							model: "fake",
							role: "assistant",
							content: [
								{ type: "tool_use", id, name: `mcp__goblin__${step.name}`, input: step.input },
							],
							stop_reason: "tool_use",
							usage: u,
						},
					};
					// The CLI executes the tool (in goblin: the bridge
					// handler) before echoing the result.
					let ran: { output: unknown; error: string | null } | null = null;
					if (step.run !== undefined) {
						try {
							ran = await step.run();
						} catch (err) {
							ran = { output: null, error: err instanceof Error ? err.message : String(err) };
						}
					}
					const pushed = call.steers?.drain() ?? [];
					steers.push(...pushed);
					unacked.push(...pushed.map((steer) => steer.uuid));
					const content =
						ran !== null ? (ran.error ?? "ok") : (step.content ?? "[cli rendered result]");
					yield {
						type: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: id,
								content,
								...(step.isError === true || ran?.error != null ? { is_error: true } : {}),
							},
						],
					};
					break;
				}
				case "error": {
					if (step.throw !== undefined) throw step.throw;
					const result: ClaudeResultEvent = {
						type: "result",
						subtype: "error_during_execution",
						isError: true,
						result: step.resultText ?? "claude code returned an error result",
						numTurns: turns,
						durationMs: 5,
						totalCostUsd: 0,
						usage: resultUsage,
						modelUsage: null,
					};
					yield result;
					return;
				}
				case "hold": {
					step.onEnter?.();
					await step.until;
					break;
				}
				case "raw": {
					yield* step.events;
					break;
				}
				case "ack": {
					if (unacked.length > 0) yield { type: "folded", uuids: unacked };
					unacked = [];
					break;
				}
				case "result": {
					yield {
						type: "result",
						subtype: "success",
						isError: false,
						result: "done",
						numTurns: turns,
						durationMs: 5,
						totalCostUsd: 0,
						usage: step.usage === undefined ? resultUsage : usage(step.usage),
						modelUsage: null,
					};
					resultUsage.input_tokens = 0;
					resultUsage.output_tokens = 0;
					break;
				}
			}
		}
		const result: ClaudeResultEvent = {
			type: "result",
			subtype: "success",
			isError: false,
			result: "done",
			numTurns: turns,
			durationMs: 5,
			totalCostUsd: 0,
			usage: resultUsage,
			modelUsage: null,
		};
		yield result;
	};

	const query: ClaudeQuery = (call) => {
		calls.push(call);
		const steps =
			scriptQueue.length > 0 ? scriptQueue.shift()! : (nextScript ?? []);
		nextScript = null;
		return stepEvents(steps, call);
	};

	return {
		query,
		calls,
		assistantUuids,
		steers,
		script: (steps) => {
			nextScript = steps;
		},
		scriptSequence: (scripts) => {
			scriptQueue = [...scripts];
			nextScript = null;
		},
	};
}

export type { ClaudeAssistantEvent, ClaudeStreamEvent };
