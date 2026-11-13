// #418 engine-level session behavior: the resume plan's query options,
// the zero-effect resume-failure retry, and nativeCompact's /compact
// query + record head update. Runtime-level record lifecycle lives in
// src/runtime-claude-session.test.ts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore } from "../../conversation.ts";
import { openClaudeSessions } from "../../claude-sessions.ts";
import type { AuthStore } from "../../auth.ts";
import type { ConfigRef } from "../../config.ts";
import type { Config } from "../../config-schema.ts";
import { fakeClaude } from "../../testkit/fake-claude.ts";
import { tmpDb, tmpDir } from "../../testkit.ts";
import { type ClaudeEngineConfig, driveClaude } from "./engine.ts";
import { createClaudeEngine } from "./mod.ts";
import type { ClaudeStep } from "./mod.ts";
import { createToolBridge } from "./tools.ts";
import { TurnState } from "../../turn/state.ts";
import { openLive, type StreamDeps, type WireMember } from "../../turn/stream.ts";
import type { TurnJournal } from "../../turn-journal.ts";
import type { UIMessageChunk } from "ai";

const fakeAuth: AuthStore = {
	resolve: async (name) => `token-for-${name}`,
	has: () => true,
	names: () => ["claude-code"],
};

const STEP: ClaudeStep = {
	engine: "claude-code",
	label: "claude/claude-sonnet-4-5",
	modelId: "claude-sonnet-4-5",
	auth: "claude-code",
	system: "test system",
	thinking: {},
};

interface RecMember extends WireMember {
	chunks: UIMessageChunk[];
}

function headSink() {
	return {
		text: "",
		reasoning: "",
		calls: [] as Array<{ tool: string; input: unknown }>,
		onTextDelta() {},
		onReasoningDelta() {},
		onToolCall() {},
	};
}

function rig() {
	const members: RecMember[] = [
		{
			seq: 1,
			message: { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
			sink: { onStreamChunk: (c) => members[0]!.chunks.push(c) },
			chunks: [],
		},
	];
	const deps: Omit<StreamDeps<RecMember>, "step"> & { step: ClaudeStep } = {
		convId: "c-session",
		epoch: 1,
		head: headSink(),
		members,
		live: openLive(),
		state: new TurnState({ convId: "c-session", watchdog: null, request: "hi" }),
		assertAuthority: () => {},
		holdsAuthority: () => true,
		step: STEP,
		messages: [{ role: "user", content: [{ type: "text", text: "DELTA-ONLY" }] }],
		tools: {},
		view: {
			convId: "c-session",
			modelRef: STEP.label,
			tools: {},
			modalities: new Set(["text"]),
			carries: () => true,
			skillRef: () => {
				throw new Error("no skill parts expected");
			},
		},
		claimSteers: () => [],
		unrequeueSteers: () => {},
		settle: () => {},
		steerMarkSeed: 0,
		ownedInputSeqs: [],
		sourceInputSeq: () => null,
		partial: null,
		seenText: false,
		toolCalls: [],
		digest: [],
		filterRetryUsed: false,
		overflowRecoverable: false,
		evidence: undefined,
		runId: "run-session-1",
		saveStep: () => {},
		turnStartMs: Date.now(),
		signal: new AbortController().signal,
	};
	return deps;
}

const journal = { noteToolInput: () => {} } as unknown as TurnJournal;

function engineConfig(
	query: ReturnType<typeof fakeClaude>["query"],
	configDir = tmpDir("goblin-session-cc-"),
): ClaudeEngineConfig {
	return {
		query,
		auth: fakeAuth,
		configRef: {
			current: {
				providers: { claude: { kind: "claude-code", auth: "claude-code" } },
			} as unknown as Config,
			ttsDown: false,
		} satisfies ConfigRef,
		configDir,
		bridgeFactory: (d) => createToolBridge(d),
	};
}

describe("claude session plan (#418)", () => {
	test("a resume plan sends resume+resumeSessionAt with persistSession and the delta prompt", async () => {
		const fake = fakeClaude([{ kind: "text", text: "RESUMED-OK" }]);
		const outcome = await driveClaude(engineConfig(fake.query), {
			...rig(),
			journal,
			saveStep: () => {},
			claudeSession: {
				resume: { sessionId: "sess-1", headUuid: "head-uuid-1" },
				fullPrompt: async () => {
					throw new Error("fullPrompt must stay lazy");
				},
				onDrop: () => {},
			},
		});
		expect(outcome.kind).toBe("ok");
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0]!;
		expect(call.options.persistSession).toBe(true);
		expect(call.options.resume).toBe("sess-1");
		expect(call.options.resumeSessionAt).toBe("head-uuid-1");
		expect(call.options.sessionId).toBeUndefined();
		const text = call.prompt.blocks
			.filter((b) => b.kind === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		expect(text).toContain("DELTA-ONLY");
		expect(text).not.toContain("full history marker");
		if (outcome.kind === "ok") {
			expect(outcome.claudeSession?.sessionId).toBe("sess-1");
			expect(outcome.claudeSession?.headUuid).toBe(fake.assistantUuids.at(-1));
		}
	});

	test("a fresh plan (no resume) mints a sessionId and never resumes", async () => {
		const fake = fakeClaude([{ kind: "text", text: "FRESH-OK" }]);
		const outcome = await driveClaude(engineConfig(fake.query), {
			...rig(),
			journal,
			saveStep: () => {},
			claudeSession: { onDrop: () => {} },
		});
		expect(outcome.kind).toBe("ok");
		const call = fake.calls[0]!;
		expect(call.options.persistSession).toBe(true);
		expect(typeof call.options.sessionId).toBe("string");
		expect(call.options.resume).toBeUndefined();
		expect(call.options.resumeSessionAt).toBeUndefined();
	});

	test("a zero-effect resume rejection drops the record and retries once fresh with the full prompt", async () => {
		const fake = fakeClaude();
		fake.scriptSequence([
			[{ kind: "error", resultText: "Resume rejected: no conversation found for uuid" }],
			[{ kind: "text", text: "FRESH-RECOVERY" }],
		]);
		let dropped = 0;
		let fullBuilds = 0;
		const outcome = await driveClaude(engineConfig(fake.query), {
			...rig(),
			journal,
			saveStep: () => {},
			claudeSession: {
				resume: { sessionId: "sess-dead", headUuid: "head-dead" },
				fullPrompt: async () => {
					fullBuilds += 1;
					return [{ role: "user", content: [{ type: "text", text: "FULL-VIEW" }] }];
				},
				onDrop: () => {
					dropped += 1;
				},
			},
		});
		expect(outcome.kind).toBe("ok");
		expect(fake.calls).toHaveLength(2);
		expect(dropped).toBe(1);
		expect(fullBuilds).toBe(1);
		const retry = fake.calls[1]!;
		expect(retry.options.resume).toBeUndefined();
		expect(retry.options.resumeSessionAt).toBeUndefined();
		expect(typeof retry.options.sessionId).toBe("string");
		expect(retry.options.sessionId).not.toBe("sess-dead");
		const text = retry.prompt.blocks
			.filter((b) => b.kind === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		expect(text).toContain("FULL-VIEW");
		expect(text).not.toContain("DELTA-ONLY");
		if (outcome.kind === "ok") {
			expect(outcome.claudeSession?.sessionId).toBe(retry.options.sessionId);
		}
	});

	test("the child cwd is the stable workdir, not process.cwd() — releases must not orphan sessions", async () => {
		const configDir = tmpDir("goblin-session-cwd-");
		const fake = fakeClaude([{ kind: "text", text: "ONE" }]);
		const config = engineConfig(fake.query, configDir);
		const dirA = tmpDir("goblin-cwd-a-");
		const dirB = tmpDir("goblin-cwd-b-");
		const original = process.cwd();
		try {
			process.chdir(dirA);
			await driveClaude(config, { ...rig(), journal, saveStep: () => {} });
			process.chdir(dirB);
			await driveClaude(config, { ...rig(), journal, saveStep: () => {} });
			expect(fake.calls).toHaveLength(2);
			const expected = join(configDir, "workdir");
			expect(fake.calls[0]!.options.cwd).toBe(expected);
			expect(fake.calls[1]!.options.cwd).toBe(expected);
			expect(fake.calls[0]!.options.cwd).not.toBe(dirA);
			expect(fake.calls[0]!.options.cwd).not.toBe(dirB);
		} finally {
			process.chdir(original);
		}
	});

	test("a resume rejection after content reached the wire does not retry", async () => {
		const fake = fakeClaude();
		fake.scriptSequence([
			[
				{ kind: "text", text: "PARTIAL-THEN-DIE" },
				{ kind: "error", resultText: "resume rejected mid-stream" },
			],
		]);
		const outcome = await driveClaude(engineConfig(fake.query), {
			...rig(),
			journal,
			saveStep: () => {},
			claudeSession: {
				resume: { sessionId: "sess-x", headUuid: "head-x" },
				fullPrompt: async () => [{ role: "user", content: [{ type: "text", text: "FULL" }] }],
				onDrop: () => {},
			},
		});
		expect(outcome.kind).toBe("failed");
		expect(fake.calls).toHaveLength(1);
	});
});

describe("claude nativeCompact (#418)", () => {
	function compactFixture() {
		const store = openStore(tmpDb("goblin-native-compact-"));
		const sessions = openClaudeSessions(store.db);
		const fake = fakeClaude();
		const engine = createClaudeEngine({
			query: fake.query,
			auth: fakeAuth,
			configRef: {
				current: {
					providers: { claude: { kind: "claude-code", auth: "claude-code" } },
				} as unknown as Config,
				ttsDown: false,
			} satisfies ConfigRef,
			configDir: tmpDir("goblin-native-compact-cc-"),
			sessions,
		});
		return { store, sessions, fake, engine };
	}

	test("no record → no query, returns null", async () => {
		const { store, fake, engine } = compactFixture();
		try {
			const out = await engine.nativeCompact({
				conversationId: "c-none",
				modelRef: "claude/claude-sonnet-4-5",
				signal: new AbortController().signal,
			});
			expect(out).toBeNull();
			expect(fake.calls).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("resumes the record at its head, sends /compact verbatim-off, and advances the head", async () => {
		const { store, sessions, fake, engine } = compactFixture();
		try {
			sessions.put({
				conversationId: "c-1",
				modelRef: "claude/claude-sonnet-4-5",
				sessionId: "sess-9",
				headUuid: "head-9",
				seenSeq: 41,
				replySeq: 40,
			});
			fake.script([
				{
					kind: "raw",
					events: [
						{
							type: "compact_boundary",
							trigger: "auto",
							preTokens: 180_000,
							postTokens: 12_000,
							uuid: "boundary-1",
						},
						{
							type: "assistant",
							uuid: "compact-head",
							message: {
								id: "m-1",
								model: "fake",
								role: "assistant",
								content: [{ type: "text", text: "Compacted." }],
								stop_reason: "end_turn",
								usage: null,
							},
						},
					],
				},
			]);
			const head = await engine.nativeCompact({
				conversationId: "c-1",
				modelRef: "claude/claude-sonnet-4-5",
				signal: new AbortController().signal,
			});
			expect(fake.calls).toHaveLength(1);
			const call = fake.calls[0]!;
			expect(call.options.resume).toBe("sess-9");
			expect(call.options.resumeSessionAt).toBe("head-9");
			expect(call.options.persistSession).toBe(true);
			expect(call.options.verbatimPrompts).toBe(false);
			expect(call.options.maxTurns).toBe(1);
			const text = call.prompt.blocks
				.filter((b) => b.kind === "text")
				.map((b) => (b as { text: string }).text)
				.join("\n");
			expect(text).toBe("/compact");
			// The last chain uuid wins — the raw assistant frame's uuid.
			expect(head).toBe("compact-head");
			const rec = sessions.get("c-1", "claude/claude-sonnet-4-5")!;
			expect(rec.headUuid).toBe("compact-head");
			expect(rec.sessionId).toBe("sess-9");
			expect(rec.seenSeq).toBe(41);
			expect(rec.replySeq).toBe(40);
		} finally {
			store.close();
		}
	});

	test("a provider failure drops the record and rethrows", async () => {
		const { store, sessions, fake, engine } = compactFixture();
		try {
			sessions.put({
				conversationId: "c-2",
				modelRef: "claude/claude-sonnet-4-5",
				sessionId: "sess-bad",
				headUuid: "head-bad",
				seenSeq: 7,
				replySeq: 6,
			});
			fake.script([{ kind: "error", resultText: "session file missing" }]);
			await expect(
				engine.nativeCompact({
					conversationId: "c-2",
					modelRef: "claude/claude-sonnet-4-5",
					signal: new AbortController().signal,
				}),
			).rejects.toThrow();
			expect(sessions.get("c-2", "claude/claude-sonnet-4-5")).toBeNull();
		} finally {
			store.close();
		}
	});
});
