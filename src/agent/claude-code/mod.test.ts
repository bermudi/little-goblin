// pinEvent tests: the vendor-adapter projection from SDKMessage to the
// pinned ClaudeEvent union — consumed frames pass through with their
// semantics intact, subagent sidechains and chatter frames drop.

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { pinEvent } from "./mod.ts";

describe("pinEvent", () => {
	test("an init system frame projects its identity fields", () => {
		const msg = {
			type: "system",
			subtype: "init",
			session_id: "s-1",
			model: "claude-sonnet-4-5",
			claude_code_version: "2.1.311",
			tools: ["bash"],
			mcp_servers: [{ name: "goblin", status: "connected" }],
		} as unknown as SDKMessage;
		expect(pinEvent(msg)).toMatchObject({
			type: "init",
			sessionId: "s-1",
			model: "claude-sonnet-4-5",
			cliVersion: "2.1.311",
		});
	});

	test("non-init system frames drop", () => {
		const msg = { type: "system", subtype: "status", session_id: "s" } as unknown as SDKMessage;
		expect(pinEvent(msg)).toBeNull();
	});

	test("frames with parent_tool_use_id are subagent sidechains and drop", () => {
		const base = { session_id: "s", uuid: "u" };
		expect(
			pinEvent({
				...base,
				type: "assistant",
				parent_tool_use_id: "p",
				message: {},
			} as unknown as SDKMessage),
		).toBeNull();
		expect(
			pinEvent({
				...base,
				type: "user",
				parent_tool_use_id: "p",
				message: { role: "user", content: "x" },
			} as unknown as SDKMessage),
		).toBeNull();
		expect(
			pinEvent({
				...base,
				type: "stream_event",
				parent_tool_use_id: "p",
				event: { type: "message_stop" },
			} as unknown as SDKMessage),
		).toBeNull();
	});

	test("a stream frame passes its event through", () => {
		const msg = {
			type: "stream_event",
			parent_tool_use_id: null,
			event: { type: "message_stop" },
		} as unknown as SDKMessage;
		expect(pinEvent(msg)).toEqual({ type: "stream", event: { type: "message_stop" } });
	});

	test("an assistant frame keeps its message and typed error", () => {
		const message = {
			id: "msg_1",
			model: "claude-sonnet-4-5",
			role: "assistant" as const,
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				cache_read_input_tokens: null,
				cache_creation_input_tokens: null,
			},
		};
		const ok = pinEvent({
			type: "assistant",
			parent_tool_use_id: null,
			message,
			session_id: "s",
			uuid: "u",
		} as unknown as SDKMessage);
		expect(ok).toEqual({ type: "assistant", message, uuid: "u" });
		const errored = pinEvent({
			type: "assistant",
			parent_tool_use_id: null,
			message,
			error: "rate_limit",
			session_id: "s",
			uuid: "u",
		} as unknown as SDKMessage);
		expect(errored).toMatchObject({ type: "assistant", error: "rate_limit" });
	});

	test("a user frame projects string content and tool_result blocks only", () => {
		const stringContent = pinEvent({
			type: "user",
			parent_tool_use_id: null,
			message: { role: "user", content: "plain" },
			session_id: "s",
			uuid: "u",
		} as unknown as SDKMessage);
		expect(stringContent).toMatchObject({ type: "user", content: "plain" });
		const mixed = pinEvent({
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "noise" },
					{ type: "tool_result", tool_use_id: "t1", content: "out", is_error: false },
					{ type: "image", source: { type: "base64" } },
				],
			},
			tool_use_result: { shaped: true },
			session_id: "s",
			uuid: "u",
		} as unknown as SDKMessage);
		expect(mixed).toEqual({
			type: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: "out", is_error: false }],
			toolUseResult: { shaped: true },
			uuid: "u",
		});
	});

	test("a compact_boundary system frame keeps trigger, tokens and chain uuid (#418)", () => {
		const pinned = pinEvent({
			type: "system",
			subtype: "compact_boundary",
			session_id: "s",
			uuid: "boundary-uuid",
			compact_metadata: {
				trigger: "auto",
				pre_tokens: 180_000,
				post_tokens: 12_000,
			},
		} as unknown as SDKMessage);
		expect(pinned).toEqual({
			type: "compact_boundary",
			trigger: "auto",
			preTokens: 180_000,
			postTokens: 12_000,
			uuid: "boundary-uuid",
		});
	});

	test("a success result maps snake_case to the pinned camelCase", () => {
		const msg = {
			type: "result",
			subtype: "success",
			duration_ms: 1200,
			duration_api_ms: 900,
			is_error: false,
			num_turns: 3,
			result: "done",
			total_cost_usd: 0.42,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: null,
				cache_creation_input_tokens: null,
			},
			modelUsage: {},
			permission_denials: [],
			session_id: "s",
		} as unknown as SDKMessage;
		expect(pinEvent(msg)).toEqual({
			type: "result",
			subtype: "success",
			isError: false,
			result: "done",
			numTurns: 3,
			durationMs: 1200,
			totalCostUsd: 0.42,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: null,
				cache_creation_input_tokens: null,
			},
			modelUsage: {},
		});
	});

	test("an error result without a result field renders subtype+errors", () => {
		const msg = {
			type: "result",
			subtype: "error_max_turns",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 50,
			total_cost_usd: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			modelUsage: {},
			errors: ["reached max turns"],
			session_id: "s",
		} as unknown as SDKMessage;
		const pinned = pinEvent(msg);
		expect(pinned).toMatchObject({
			type: "result",
			isError: true,
			result: "error_max_turns: reached max turns",
		});
	});

	test("unconsumed frame types drop to null", () => {
		for (const msg of [
			{ type: "task_notification" },
			{ type: "hook_progress" },
			{ type: "rate_limit_event" },
		]) {
			expect(pinEvent(msg as unknown as SDKMessage)).toBeNull();
		}
	});
});
