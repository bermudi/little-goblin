import { describe, expect, test } from "bun:test";
import { replyMetadata } from "./reply-metadata.ts";

describe("replyMetadata", () => {
	test("keeps the full wire object and key order", () => {
		const metadata = replyMetadata({
			label: "openai/gpt-test",
			finishReason: "stop",
			turnStartMs: 1_000,
			now: 1_250,
			firstTokenMs: 40,
			forcedCompletion: "context",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 30,
				cacheWrite: 4,
				lastInput: 80,
				lastCacheRead: 25,
			},
			promptChars: {
				identity: 1,
				environment: 2,
				project: 3,
				agentsMd: 4,
				userMd: 5,
				skills: 6,
				toolDefs: 7,
				history: 8,
				toolResults: 9,
			},
			quota: {
				limitName: "weekly",
				primary: { usedPercent: 10, windowMinutes: 60, resetsAt: 1_500 },
				secondary: null,
			},
			fallbackMisses: [{ ref: "openai/gpt-failed", reason: "offline" }],
		});

		expect(JSON.stringify(metadata)).toBe(
			'{"model":"openai/gpt-test","finishReason":"stop","durationMs":250,"createdAt":"1970-01-01T00:00:01.250Z","ttftMs":40,"forcedCompletion":"context","usage":{"input":100,"output":20,"cacheRead":30,"cacheWrite":4,"lastInput":80,"lastCacheRead":25},"promptChars":{"identity":1,"environment":2,"project":3,"agentsMd":4,"userMd":5,"skills":6,"toolDefs":7,"history":8,"toolResults":9},"quota":{"limitName":"weekly","primary":{"usedPercent":10,"windowMinutes":60,"resetsAt":1500},"secondary":null},"fallback":{"from":[{"ref":"openai/gpt-failed","reason":"offline"}]}}',
		);
	});

	test("omits optional metadata for a minimal input", () => {
		const metadata = replyMetadata({
			label: "claude/model",
			finishReason: "stop",
			turnStartMs: 5_000,
			now: 5_000,
			firstTokenMs: null,
			forcedCompletion: null,
			usage: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				lastInput: null,
				lastCacheRead: null,
			},
			promptChars: null,
			quota: null,
		});

		expect(JSON.stringify(metadata)).toBe(
			'{"model":"claude/model","finishReason":"stop","durationMs":0,"createdAt":"1970-01-01T00:00:05.000Z","usage":{"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"lastInput":null,"lastCacheRead":null}}',
		);
	});

	test("fallback metadata carries only ref and reason", () => {
		const metadata = replyMetadata({
			label: "openai/gpt-test",
			finishReason: "stop",
			turnStartMs: 1_000,
			now: 1_001,
			firstTokenMs: null,
			forcedCompletion: null,
			usage: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				lastInput: null,
				lastCacheRead: null,
			},
			promptChars: null,
			quota: null,
			fallbackMisses: [{ ref: "openai/failed", reason: "rate limit" }],
		});

		expect(metadata.fallback).toEqual({
			from: [{ ref: "openai/failed", reason: "rate limit" }],
		});
	});
});
