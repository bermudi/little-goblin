// #418: one native Claude SDK session per (conversation, model ref) —
// resumed each turn at its recorded head with only the seq delta the
// session has not seen, the record advanced only on a landed reply.
// Covers: fresh persist+sessionId, resume+resumeSessionAt+delta,
// cross-engine deltas, failed turns leaving the record untouched,
// and separate records per Claude model ref.

import { describe, expect, test } from "bun:test";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { openClaudeSessions } from "./claude-sessions.ts";
import { type ClaudeEngineConfig, driveClaude } from "./agent/claude-code/engine.ts";
import type { ClaudeEngine, ClaudeStep } from "./agent/claude-code/mod.ts";
import { createToolBridge, type ToolBridge } from "./agent/claude-code/tools.ts";
import type { AuthStore } from "./auth.ts";
import type { Config, ConfigRef } from "./config.ts";
import { openStore } from "./conversation.ts";
import { Runtime, userMessage } from "./runtime.ts";
import type { ModelStep } from "./turn/engine.ts";
import { isClaudeStep } from "./turn/engine.ts";
import { aiSdkEngine } from "./turn/ai-sdk-engine.ts";
import { fakeClaude } from "./testkit/fake-claude.ts";
import { scriptedModel, textParts } from "./testkit/fake-model.ts";
import { RecordingSink, tmpDb, tmpDir, useHome, waitUntil } from "./testkit.ts";
import { openTurnJournal } from "./turn-journal.ts";

const fakeAuth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

const CLAUDE_REF = "claude/claude-sonnet-4-5";
const CLAUDE_REF_B = "claude/claude-opus-4-1";

function promptTextOf(call: { prompt: { blocks: Array<{ kind: string; text?: string }> } }): string {
	return call.prompt.blocks.map((b) => (b.kind === "text" ? (b.text ?? "") : "")).join("\n");
}

function claudeStepFor(label: string): ClaudeStep {
	const modelId = label.split("/")[1]!;
	return {
		engine: "claude-code",
		label,
		modelId,
		auth: "claude-code",
		system: "test",
		thinking: {},
	};
}

describe("claude native sessions (#418)", () => {
	test("first turn persists a fresh session; second resumes at its head with a delta", async () => {
		useHome("goblin-claude-session-");
		const store = openStore(tmpDb("goblin-claude-session-"));
		const journal = openTurnJournal(store.db);
		const sessions = openClaudeSessions(store.db);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");

		const fake = fakeClaude();
		const bridgeRef: { current: ToolBridge | null } = { current: null };
		const engineConfig: ClaudeEngineConfig = {
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-claude-session-cc-"),
			bridgeFactory: (d) => {
				const real = createToolBridge(d);
				bridgeRef.current = real;
				return real;
			},
		};
		const claudeEngine: ClaudeEngine = {
			id: "claude-code",
			accepts: isClaudeStep,
			run: (deps) => driveClaude(engineConfig, deps),
			compact: async () => "unused",
			nativeCompact: async () => null,
		};

		const runtime = new Runtime({
			store,
			engines: [claudeEngine],
			buildStep: () => claudeStepFor(CLAUDE_REF),
			makeTools: () => ({}),
			turnJournal: journal,
			claudeSessions: sessions,
		});
		const turn = async (text: string) => {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
			const done = await sink.done;
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			return { sink, done };
		};

		try {
			// (a) first turn: fresh session, full prompt, record written.
			fake.script([{ kind: "text", text: "CLAUDE-ONE" }]);
			const one = await turn("first ask");
			expect(one.done).toEqual({ kind: "completed" });
			expect(fake.calls).toHaveLength(1);
			const first = fake.calls[0]!;
			expect(first.options.persistSession).toBe(true);
			expect(typeof first.options.sessionId).toBe("string");
			expect(first.options.resume).toBeUndefined();
			expect(promptTextOf(first)).toContain("first ask");

			const rec1 = sessions.get(conv.id, CLAUDE_REF);
			expect(rec1).not.toBeNull();
			expect(rec1!.sessionId).toBe(first.options.sessionId!);
			expect(rec1!.headUuid).toBe(fake.assistantUuids.at(-1)!);
			expect(rec1!.replySeq).not.toBeNull();

			// (b) second turn: resume + resumeSessionAt, delta only.
			fake.script([{ kind: "text", text: "CLAUDE-TWO" }]);
			const two = await turn("second ask");
			expect(two.done).toEqual({ kind: "completed" });
			expect(fake.calls).toHaveLength(2);
			const second = fake.calls[1]!;
			expect(second.options.resume).toBe(rec1!.sessionId);
			expect(second.options.resumeSessionAt).toBe(rec1!.headUuid);
			expect(second.options.persistSession).toBe(true);
			const secondPrompt = promptTextOf(second);
			expect(secondPrompt).toContain("second ask");
			expect(secondPrompt).not.toContain("first ask");
			expect(secondPrompt).not.toContain("CLAUDE-ONE");

			const rec2 = sessions.get(conv.id, CLAUDE_REF);
			expect(rec2!.sessionId).toBe(rec1!.sessionId);
			expect(rec2!.headUuid).toBe(fake.assistantUuids.at(-1)!);
			expect(rec2!.headUuid).not.toBe(rec1!.headUuid);
			expect(rec2!.seenSeq).toBeGreaterThan(rec1!.seenSeq);
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("an AI-SDK turn between two claude turns lands in the delta; the session's own reply does not", async () => {
		useHome("goblin-claude-session-x-");
		const store = openStore(tmpDb("goblin-claude-session-x-"));
		const journal = openTurnJournal(store.db);
		const sessions = openClaudeSessions(store.db);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");

		const sdk = scriptedModel([textParts("SDK-MIDDLE")]);
		const fake = fakeClaude();
		const engineConfig: ClaudeEngineConfig = {
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-claude-session-x-cc-"),
		};
		const claudeEngine: ClaudeEngine = {
			id: "claude-code",
			accepts: isClaudeStep,
			run: (deps) => driveClaude(engineConfig, deps),
			compact: async () => "unused",
			nativeCompact: async () => null,
		};

		let lane: "claude" | "sdk" = "claude";
		const runtime = new Runtime({
			store,
			engines: [claudeEngine, aiSdkEngine],
			buildStep: () =>
				lane === "claude"
					? claudeStepFor(CLAUDE_REF)
					: ({ model: sdk.model, system: "test", label: "fake/fake-1" }) satisfies ModelStep,
			makeTools: () => ({}),
			turnJournal: journal,
			claudeSessions: sessions,
		});
		const turn = async (text: string) => {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
			const done = await sink.done;
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			return { sink, done };
		};

		try {
			fake.script([{ kind: "text", text: "CLAUDE-FIRST" }]);
			expect((await turn("claude ask one")).done).toEqual({ kind: "completed" });

			lane = "sdk";
			expect((await turn("sdk ask")).done).toEqual({ kind: "completed" });

			lane = "claude";
			fake.script([{ kind: "text", text: "CLAUDE-SECOND" }]);
			expect((await turn("claude ask two")).done).toEqual({ kind: "completed" });

			expect(fake.calls).toHaveLength(2);
			const third = fake.calls[1]!;
			const prompt = promptTextOf(third);
			// The other engine's reply is new to this session — it rides
			// the delta. Claude's own earlier reply does not.
			expect(prompt).toContain("SDK-MIDDLE");
			expect(prompt).toContain("claude ask two");
			expect(prompt).not.toContain("CLAUDE-FIRST");
			expect(prompt).not.toContain("claude ask one");
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("a failed turn leaves the record at the last finish; the next turn resumes the old head", async () => {
		useHome("goblin-claude-session-f-");
		const store = openStore(tmpDb("goblin-claude-session-f-"));
		const journal = openTurnJournal(store.db);
		const sessions = openClaudeSessions(store.db);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");

		const fake = fakeClaude();
		const engineConfig: ClaudeEngineConfig = {
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-claude-session-f-cc-"),
		};
		const claudeEngine: ClaudeEngine = {
			id: "claude-code",
			accepts: isClaudeStep,
			run: (deps) => driveClaude(engineConfig, deps),
			compact: async () => "unused",
			nativeCompact: async () => null,
		};
		const runtime = new Runtime({
			store,
			engines: [claudeEngine],
			buildStep: () => claudeStepFor(CLAUDE_REF),
			makeTools: () => ({}),
			turnJournal: journal,
			claudeSessions: sessions,
		});
		const turn = async (text: string) => {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
			const done = await sink.done;
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			return { sink, done };
		};

		try {
			fake.script([{ kind: "text", text: "CLAUDE-ONE" }]);
			expect((await turn("first ask")).done).toEqual({ kind: "completed" });
			const rec1 = sessions.get(conv.id, CLAUDE_REF)!;

			// The next turn dies on the provider — no landing, no record move.
			fake.script([{ kind: "error", resultText: "provider exploded" }]);
			const failed = await turn("doomed ask");
			expect(failed.done.kind).not.toBe("completed");
			const recAfterFail = sessions.get(conv.id, CLAUDE_REF)!;
			expect(recAfterFail).toEqual(rec1);

			// The retry turn resumes at the OLD head; the delta carries the
			// unlanded ask plus the new one — nothing the session produced
			// is re-sent, and the dead attempt's partial never landed.
			fake.script([{ kind: "text", text: "CLAUDE-RECOVERED" }]);
			const three = await turn("retry ask");
			expect(three.done).toEqual({ kind: "completed" });
			expect(fake.calls).toHaveLength(3);
			const retry = fake.calls[2]!;
			expect(retry.options.resume).toBe(rec1.sessionId);
			expect(retry.options.resumeSessionAt).toBe(rec1.headUuid);
			const prompt = promptTextOf(retry);
			expect(prompt).toContain("doomed ask");
			expect(prompt).toContain("retry ask");
			expect(prompt).not.toContain("CLAUDE-ONE");
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});

	test("two claude model refs keep separate session records", async () => {
		useHome("goblin-claude-session-g-");
		const store = openStore(tmpDb("goblin-claude-session-g-"));
		const journal = openTurnJournal(store.db);
		const sessions = openClaudeSessions(store.db);
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");

		const fake = fakeClaude();
		const engineConfig: ClaudeEngineConfig = {
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-claude-session-g-cc-"),
		};
		const claudeEngine: ClaudeEngine = {
			id: "claude-code",
			accepts: isClaudeStep,
			run: (deps) => driveClaude(engineConfig, deps),
			compact: async () => "unused",
			nativeCompact: async () => null,
		};

		let ref = CLAUDE_REF;
		const runtime = new Runtime({
			store,
			engines: [claudeEngine],
			buildStep: () => claudeStepFor(ref),
			makeTools: () => ({}),
			turnJournal: journal,
			claudeSessions: sessions,
		});
		const turn = async (text: string) => {
			const sink = new RecordingSink();
			runtime.submit(conv, userMessage([{ type: "text", text }]), sink);
			const done = await sink.done;
			await waitUntil(() => !runtime.busy(conv.id), "lane drains");
			return { sink, done };
		};

		try {
			fake.script([{ kind: "text", text: "SONNET-ONE" }]);
			expect((await turn("sonnet ask")).done).toEqual({ kind: "completed" });

			ref = CLAUDE_REF_B;
			fake.script([{ kind: "text", text: "OPUS-ONE" }]);
			expect((await turn("opus ask")).done).toEqual({ kind: "completed" });

			const recA = sessions.get(conv.id, CLAUDE_REF)!;
			const recB = sessions.get(conv.id, CLAUDE_REF_B)!;
			expect(recA).not.toBeNull();
			expect(recB).not.toBeNull();
			expect(recA.sessionId).not.toBe(recB.sessionId);

			// The opus turn was a FIRST session for its ref — full prompt,
			// including the sonnet exchange it has never seen.
			expect(fake.calls).toHaveLength(2);
			expect(fake.calls[1]!.options.resume).toBeUndefined();
			expect(promptTextOf(fake.calls[1]!)).toContain("SONNET-ONE");
			expect(promptTextOf(fake.calls[1]!)).toContain("sonnet ask");

			// Back on sonnet: its own session resumes; the opus exchange is
			// new content for it and rides the delta.
			ref = CLAUDE_REF;
			fake.script([{ kind: "text", text: "SONNET-TWO" }]);
			expect((await turn("sonnet ask two")).done).toEqual({ kind: "completed" });
			const third = fake.calls[2]!;
			expect(third.options.resume).toBe(recA.sessionId);
			expect(third.options.resumeSessionAt).toBe(recA.headUuid);
			const prompt = promptTextOf(third);
			expect(prompt).toContain("OPUS-ONE");
			expect(prompt).toContain("opus ask");
			expect(prompt).toContain("sonnet ask two");
			expect(prompt).not.toContain("SONNET-ONE");
		} finally {
			await runtime.shutdown();
			store.close();
		}
	});
});
