// Live check — the compaction memory flush reuses the turn's cached
// prompt prefix on the codex backend (design/compaction.md → Memory
// flush; #617). Run once after a model-view or codex-adapter change:
//
//   GOBLIN_CODEX_LIVE=1 bun test src/turn/prefix-summary.live.test.ts
//
// Reproduces the production seam end to end on gpt-6-luna: two real
// streamText turns land replies in a real ConversationStore the way
// runtime persists them, then the step builder's prefixStep +
// prefixFlush replay the stored model view with the flush instruction
// appended — the same request shape makePrefix builds. The flush's
// usage must report cached input: a zero means the replayed prefix
// diverged from the turn's and the flush pays full prompt cost.
// Auth resolves from the configured codex file and is never printed;
// the asks are public filler. ~4 billed generations; assertions are
// on token counts and prompt-hash prefixes, never on content. Red
// means the flush's wire prefix moved — diff the logged call hashes
// against the warm turn's and fix the replay path.

import { randomUUID } from "node:crypto";
import type { Usage } from "../message.ts";
import { expect, test } from "bun:test";
import { streamText, type ToolSet, toUIMessageStream } from "ai";
import { z } from "zod";
import { makeStepBuilder } from "../agent/step.ts";
import { codexSessionId } from "../agent/codex/session.ts";
import {
	cacheRouteFor,
	carriesMedia,
	observedModel,
	resolveModel,
} from "../agent/providers.ts";
import { thinkingOptions } from "../agent/thinking.ts";
import { noteTool } from "../agent/tools/note.ts";
import { resolveSkillRef } from "../agent/skill-inject.ts";
import type { AuthStore } from "../auth.ts";
import type { CacheCallInput, CacheObservation } from "../cache-observation.ts";
import { configSchema } from "../config-schema.ts";
import { openStore } from "../conversation.ts";
import { log } from "../log.ts";
import type { Message } from "../message.ts";
import { openNotes } from "../notes.ts";
import { openProjects } from "../projects.ts";
import { tmpDb, useHome } from "../testkit.ts";
import { defineTool } from "../tool.ts";
import { toToolSet } from "./ai-sdk-tools.ts";
import { buildModelView, type ViewContext } from "./view.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";
const MODEL_REF = "codex/gpt-6-luna";
const SYSTEM = [
	"You are goblin, a personal agent for one operator.",
	"Answer briefly and only from what the conversation shows.",
].join("\n");
// The provider's cache floor needs a shared prefix past ~1k tokens;
// this padding keeps the warm prefix comfortably above it.
const PADDING = Array.from(
	{ length: 200 },
	(_, i) => `reference line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
).join("\n");

type CallRecord = { input: CacheCallInput; usage: Usage | null };

test(
	"the memory flush replays the turn prefix and reads it from cache (live)",
	async () => {
		if (!LIVE) return;
		useHome("goblin-flush-live-");
		const store = openStore(tmpDb("goblin-flush-live-"));
		try {
			const calls: CallRecord[] = [];
			const observation: CacheObservation = {
				begin(input) {
					const rec: CallRecord = { input, usage: null };
					calls.push(rec);
					return {
						callId: input.callId,
						routeKey: input.routeKey,
						idleMs: null,
						prefixRelation: "first",
						sharedMessages: 0,
						finish(usage) {
							rec.usage = usage ?? null;
						},
						fail() {},
					};
				},
				lastCompleted: () => null,
				completedReceipts: () => [],
				suspendPruning: () => {},
				pruningSuspension: () => null,
				idleCacheCall: () => null,
				recentConversations: () => [],
			};
			const cfg = configSchema.parse({
				providers: { codex: { kind: "codex" } },
				model: MODEL_REF,
				operators: [1],
			});
			const auth: AuthStore = {
				resolve: () => Promise.reject(new Error("the codex lane never reads auth.jsonl")),
				has: () => false,
				names: () => [],
			};
			const conv0 = store.resolve(
				{ kind: "app", appId: "live-flush", chatId: 0, threadId: 0 },
				"/w",
				{ model: MODEL_REF, thinking: "low" },
			);
			store.savePromptSnapshot(conv0.id, SYSTEM, ["live-check"]);
			const conv = store.get(conv0.id)!;
			const projects = openProjects(store);
			const notes = openNotes(store, { projects });
			const domainTools = {
				note: noteTool({
					notes,
					projects,
					conversation: conv.id,
					projectId: conv.projectId,
				}),
				probe_echo: defineTool({
					description: "Echoes the input text back.",
					input: z.object({ text: z.string() }),
					execute: async (input) => input.text,
				}),
			};
			const sdkTools = toToolSet(domainTools);
			const view: ViewContext = {
				convId: conv.id,
				modelRef: MODEL_REF,
				tools: domainTools,
				sdkTools,
				modalities: new Set(["text"]),
				carries: (mediaType, position) => carriesMedia("codex", mediaType, position),
				keepProviderExecuted: true,
				skillRef: resolveSkillRef,
			};
			const turnModel = observedModel(
				await resolveModel(cfg, auth, MODEL_REF, { sessionId: codexSessionId(conv.id) }),
				{ conversation: conv.id, observation, route: cacheRouteFor(cfg, MODEL_REF) },
			);
			// One warm turn: user event in, streamText on the view, reply
			// persisted as the runtime lands it.
			const turn = async (askText: string): Promise<Message> => {
				const seqs = store.append(conv.id, [
					{ id: randomUUID(), role: "user", parts: [{ type: "text", text: askText }] },
				]);
				const messages = await buildModelView(view, {
					entries: store.modelEntries(conv.id),
					prior: [],
					current: null,
					partial: null,
					summarySeq: store.memoryEligibility(conv.id).summarySeq,
					ownedSeqs: seqs,
					assertAuthority: () => {},
				});
				const providerOptions = thinkingOptions(cfg, MODEL_REF, "low");
				const result = streamText({
					model: turnModel,
					instructions: SYSTEM,
					tools: sdkTools,
					messages,
					...(providerOptions !== undefined ? { providerOptions } : {}),
				});
				let reply: Message | undefined;
				const uiStream = toUIMessageStream<ToolSet, Message>({
					stream: result.stream,
					sendReasoning: true,
					generateMessageId: randomUUID,
					messageMetadata: ({ part }) =>
						part.type === "finish" ? { model: MODEL_REF } : undefined,
					onFinish: ({ responseMessage, isAborted, outcome }) => {
						if (isAborted || outcome.status === "failed") return;
						reply = responseMessage;
					},
				});
				for await (const _chunk of uiStream) {
					// Drain the wire; the reply lands in onFinish.
				}
				expect(reply).toBeDefined();
				store.append(conv.id, [reply!], { anchorSeq: seqs[0] ?? null });
				return reply!;
			};

			await turn(
				`The operator keeps backups at /mnt/backup and prefers dark themes.\n\n${PADDING}\n\nAcknowledge briefly; call no tools.`,
			);
			const reply2 = await turn(
				"What backup path did I just mention? Answer in one sentence; call no tools.",
			);
			expect(calls.length).toBe(2);
			const warm = calls[1]!.input;

			const builder = makeStepBuilder({
				configRef: { current: cfg, ttsDown: false },
				auth,
				store,
				projects,
				notes,
				observation,
			});
			const compaction = builder.compaction;
			expect(compaction).toBeDefined();
			const step = await compaction!.prefixStep!(conv, MODEL_REF);
			expect(step).not.toBeNull();
			const keptText = reply2.parts.find(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof part.text === "string",
			)?.text;
			const flush = compaction!.prefixFlush!({
				conv,
				modelRef: MODEL_REF,
				step: step!,
				tools: sdkTools,
				foldCeiling: () => null,
				assertAuthority: () => {},
			});
			expect(flush).not.toBeNull();
			const flushAt = calls.length;
			await flush!(
				keptText === undefined ? null : keptText.replace(/\s+/g, " ").trim().slice(0, 200),
				false,
				new AbortController().signal,
			);
			const flushCall = calls[flushAt];
			expect(flushCall).toBeDefined();
			log.info("codex live flush cache observation", {
				conversation: conv.id,
				calls: calls.map((call) => ({
					purpose: call.input.purpose,
					messages: call.input.promptHashes.length,
					headHash: call.input.headHash.slice(0, 12),
					settingsHash: call.input.settingsHash.slice(0, 12),
					input: call.usage?.inputTokens ?? null,
					cacheRead: call.usage?.inputTokenDetails.cacheReadTokens ?? null,
					cacheWrite: call.usage?.inputTokenDetails.cacheWriteTokens ?? null,
				})),
			});
			// The flush's wire head (system + tool definitions) and its
			// view-derived message prefix must be byte-identical to the
			// warm turn's.
			expect(flushCall!.input.headHash).toBe(warm.headHash);
			expect(flushCall!.input.settingsHash).toBe(warm.settingsHash);
			expect(
				flushCall!.input.promptHashes.slice(0, warm.promptHashes.length),
			).toEqual(warm.promptHashes);
			const cacheRead = flushCall!.usage?.inputTokenDetails.cacheReadTokens ?? 0;
			expect(
				cacheRead,
				`flush read ${cacheRead} cached tokens — the replayed prefix diverged from the turn's`,
			).toBeGreaterThan(0);
		} finally {
			store.close();
		}
	},
	240_000,
);
