// Wake dispatcher — the delivery half of durable wakes: commit once,
// submitPersisted, link the claimed wake to the journal run that
// actually owns its trigger (initial claim, resume queue claim,
// steer join, resume/overflow retarget), settle on the run's terminal
// stamp. Fakes live at the edges: the model is scripted, the runtime
// is real, the store/journal/wake store are real SQLite.

import { describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { type LanguageModel, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { Runtime, type RuntimeDeps, userMessage } from "./runtime.ts";
import { openTurnJournal, type TurnJournal } from "./turn-journal.ts";
import { deferred, fakeModel, HeadlessSink, RecordingSink, tmpDb, waitUntil } from "./testkit.ts";
import {
	finishPart,
	scriptedModel,
	type StreamAttempt,
	textParts,
	toolCallPart,
} from "./testkit/fake-model.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "./wake-dispatcher.ts";
import { openWakeStore, type WakeStore } from "./wake-store.ts";

setLogFile(null);

type Store = ReturnType<typeof openStore>;
type Conv = ReturnType<Store["resolve"]>;

interface Rig {
	store: Store;
	conv: Conv;
	journal: TurnJournal;
	wakes: WakeStore;
	runtime: Runtime;
	dispatcher: WakeDispatcher;
}

// The composition's shape: a real Runtime with the journal and the
// ownership hooks late-bound to the dispatcher — same wiring index.ts
// builds, minus Telegram.
function rig(
	opts: {
		model?: LanguageModel;
		tools?: ToolSet;
		makeTools?: RuntimeDeps["makeTools"];
		store?: Store;
		buildStep?: RuntimeDeps["buildStep"];
		compaction?: NonNullable<RuntimeDeps["compaction"]>;
		wrapWakes?: (wakes: WakeStore) => WakeStore;
	} = {},
): Rig {
	const store = opts.store ?? openStore(tmpDb("goblin-wd-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const journal = openTurnJournal(store.db);
	const wakes = opts.wrapWakes?.(openWakeStore(store.db)) ?? openWakeStore(store.db);
	let dispatcher!: WakeDispatcher;
	const runtime = new Runtime({
		store,
		turnJournal: journal,
		buildStep:
			opts.buildStep ?? (() => ({ model: opts.model ?? fakeModel(["ok"]), system: "test" })),
		makeTools: opts.makeTools ?? (() => opts.tools ?? {}),
		...(opts.compaction === undefined ? {} : { compaction: opts.compaction }),
		runOwnership: {
			begin: (e) => dispatcher.hooks.begin(e),
			members: (r, ids) => dispatcher.hooks.members(r, ids),
			end: (r, s, d) => dispatcher.hooks.end(r, s, d),
			preRunFailure: (e) => dispatcher.hooks.preRunFailure?.(e),
		},
	});
	dispatcher = makeWakeDispatcher({
		store,
		wakes,
		journal,
		runtime,
		sinkFor: () => new HeadlessSink(),
	});
	return { store, conv, journal, wakes, runtime, dispatcher };
}

const dev = (r: Rig, key: string, text = "worker went idle") =>
	r.dispatcher.record({
		sourceKey: key,
		conversationId: r.conv.id,
		kind: "done-candidate",
		text,
		facts: {},
		origin: "observer",
	});

const wake = (r: Rig, wakeId: number) => r.wakes.get(wakeId)!;
const texts = (r: Rig) =>
	r.store
		.historyEntries(r.conv.id)
		.filter((e) => e.message.role === "user")
		.map((e) => e.message);

// A wake claimed and appended but never submitted — the crash window
// between commit and submitPersisted, staged by hand.
function claimedOnly(r: Rig, key: string, text = "the one line") {
	const rec = r.wakes.record({
		sourceKey: key,
		conversationId: r.conv.id,
		kind: "done-candidate",
		text,
		facts: {},
		origin: "observer",
	});
	const claimed = r.wakes.commit(rec.wakeId, (t) => {
		const message: UIMessage = { id: t.id, role: "user", parts: [{ type: "text", text: t.text }] };
		r.store.append(r.conv.id, [message]);
	});
	return claimed;
}

describe("wake dispatcher", () => {
	test("/stop before journal creation never resubmits the canceled wake", async () => {
		const script = scriptedModel([textParts("must not run")]);
		const r = rig({ model: script.model });
		const rec = dev(r, "immediate-stop");
		expect(wake(r, rec.wakeId).runId).toBeNull();
		await r.runtime.stop(r.conv.id).settled;
		await waitUntil(
			() => !r.runtime.isAdmitted(r.conv.id, wake(r, rec.wakeId).messageId),
			"canceled admission drained",
		);
		r.dispatcher.pump();
		expect(wake(r, rec.wakeId).state).toBe("failed");
		// Reopening the store must preserve the cancellation fence.
		const reopened = openWakeStore(r.store.db);
		expect(reopened.reconcile(new Date().toISOString(), () => null).toResubmit).toHaveLength(0);
		expect(script.streamCalls).toHaveLength(0);
		await r.runtime.shutdown();
		r.store.close();
	});

	test("a pre-run failure fails the wake closed — no re-admission loop", async () => {
		const script = scriptedModel([textParts("must not run")]);
		// The attempt dies before its run row begins — the window where
		// reconcile has no run to read and would re-admit every pump.
		const r = rig({
			model: script.model,
			makeTools: () => {
				throw new Error("project dir vanished");
			},
		});
		const rec = dev(r, "prerun:1");
		await waitUntil(() => wake(r, rec.wakeId).state === "failed", "pre-run failure failed the wake");
		expect(wake(r, rec.wakeId).state).toBe("failed");
		expect(wake(r, rec.wakeId).lastError).toContain("project dir vanished");
		// The trigger landed exactly once and nothing re-admits it.
		const submissions = texts(r).length;
		expect(submissions).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		r.dispatcher.pump();
		r.dispatcher.pump();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(texts(r).length).toBe(submissions);
		expect(wake(r, rec.wakeId).state).toBe("failed");
		expect(script.streamCalls).toHaveLength(0);
		await r.runtime.shutdown();
		r.store.close();
	});

	test("a pending orphan fails terminally without stalling other deliveries", async () => {
		const script = scriptedModel([textParts("ok")]);
		const r = rig({ model: script.model });
		const orphanConv = r.store.resolve({ kind: "dm", chatId: 2 }, "/w");
		const orphan = r.wakes.record({
			sourceKey: "orphan:1",
			conversationId: orphanConv.id,
			kind: "done-candidate",
			text: "gone",
			facts: {},
			origin: "observer",
		});
		// Out-of-band surgery — deleteConversation would have swept the wake.
		r.store.db.run("PRAGMA foreign_keys = OFF");
		r.store.db.run("DELETE FROM conversations WHERE id = ?", [orphanConv.id]);
		r.store.db.run("PRAGMA foreign_keys = ON");
		// The healthy dev's record() pumps: the orphan takes its terminal
		// failOrphan transition while the healthy wake delivers.
		const healthy = dev(r, "healthy:1");
		expect(wake(r, orphan.wakeId).state).toBe("failed");
		expect(wake(r, orphan.wakeId).lastError).toBe("wake conversation row is missing");
		await waitUntil(() => wake(r, healthy.wakeId).state === "settled", "healthy wake settled");
		expect(script.streamCalls).toHaveLength(1);
		await r.runtime.shutdown();
		r.store.close();
	});

	test("overflow keeps wake claimed until its successful successor delivers", async () => {
		const overflow = new APICallError({
			message:
				"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
			url: "https://api.openai.com/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 400,
		});
		const script = scriptedModel([overflow, textParts("recovered")]);
		const continuation = deferred<void>();
		let builds = 0;
		const r = rig({
			buildStep: async () => {
				if (++builds === 3) await continuation.promise; // admission, compaction, successor
				return { model: script.model, system: "test", contextWindow: 1000 };
			},
			compaction: { modelRef: () => "m", summarize: async () => "folded era" },
		});
		for (let i = 0; i < 3; i++) {
			r.store.append(r.conv.id, [
				userMessage([{ type: "text", text: `${"x".repeat(600)} q${i}` }]),
			]);
			r.store.append(
				r.conv.id,
				[
					{
						id: `seed-${i}`,
						role: "assistant",
						parts: [{ type: "text", text: `${"x".repeat(600)} a${i}` }],
					},
				],
				{ anchorSeq: r.store.lastUserSeq(r.conv.id) },
			);
		}
		const rec = dev(r, "overflow-recovery");
		await waitUntil(() => builds === 3, "successor admission held");
		const firstRun = r.store.db
			.query<{ run_id: string }, []>("SELECT run_id FROM turn_runs WHERE status = 'error'")
			.get()!.run_id;
		expect(r.journal.get(firstRun)?.delivery).toBe("undelivered");
		r.dispatcher.pump(); // ticker while the successor is still building its prompt
		expect(wake(r, rec.wakeId).state).toBe("claimed");
		continuation.resolve();
		await waitUntil(() => wake(r, rec.wakeId).state === "settled", "successor delivered");
		expect(wake(r, rec.wakeId).runId).not.toBe(firstRun);
		expect(r.journal.get(wake(r, rec.wakeId).runId!)?.delivery).toBe("delivered");
		expect(script.streamCalls).toHaveLength(2);
		await r.runtime.shutdown();
		r.store.close();
	});

	test("record → pump appends the trigger once, links the real run, settles on completion", async () => {
		const r = rig();
		const rec = dev(r, "poll:1", "the development");
		expect(wake(r, rec.wakeId).state).toBe("claimed");
		const users = texts(r);
		expect(users).toHaveLength(1);
		expect(users[0]!.id).toBe(wake(r, rec.wakeId).messageId);
		await waitUntil(() => wake(r, rec.wakeId).state === "settled", "wake settled");
		const done = wake(r, rec.wakeId);
		expect(done.runId).not.toBeNull();
		expect(r.journal.get(done.runId!)?.status).toBe("completed");
		// The reply landed under the same run — exactly one turn ran.
		expect(r.journal.interrupted()).toHaveLength(0);
		r.store.close();
	});

	test("a sweep's developments coalesce into one trigger, one turn, one settle", async () => {
		const r = rig();
		const [a, b] = r.dispatcher.recordAll([
			{
				sourceKey: "poll:1",
				conversationId: r.conv.id,
				kind: "done-candidate",
				text: "line one",
				facts: {},
				origin: "observer",
			},
			{
				sourceKey: "poll:2",
				conversationId: r.conv.id,
				kind: "done-candidate",
				text: "line two",
				facts: {},
				origin: "observer",
			},
		]);
		expect(b!.wakeId).toBe(a!.wakeId);
		expect(texts(r)).toHaveLength(1);
		await waitUntil(() => wake(r, a!.wakeId).state === "settled", "wake settled");
		const entries = r.store.historyEntries(r.conv.id);
		const trigger = entries.find((e) => e.message.id === wake(r, a!.wakeId).messageId)!;
		expect(trigger.message.parts).toEqual([{ type: "text", text: "line one\nline two" }]);
		r.store.close();
	});

	test("a development recorded against an already-claimed wake gets its own wake", async () => {
		// Coalescing is the pending window only — once the trigger is
		// committed history it can't change, so a later development is a
		// new wake that steers into the running turn.
		const r = rig();
		const a = dev(r, "poll:1", "line one");
		const b = dev(r, "poll:2", "line two");
		expect(b.wakeId).not.toBe(a.wakeId);
		await waitUntil(
			() => wake(r, a.wakeId).state === "settled" && wake(r, b.wakeId).state === "settled",
			"both wakes settled",
		);
		expect(wake(r, a.wakeId).runId).toBe(wake(r, b.wakeId).runId);
		r.store.close();
	});

	test("a claimed-but-never-submitted wake resubmits without a second append", async () => {
		const r = rig();
		const claimed = claimedOnly(r, "poll:1");
		expect(r.store.historyEntries(r.conv.id)).toHaveLength(1);
		// Boot's pump: resubmit only — the append must not repeat.
		r.dispatcher.pump();
		await waitUntil(() => wake(r, claimed.wakeId).state === "settled", "wake settled");
		const users = texts(r);
		expect(users.filter((m) => m.id === claimed.messageId)).toHaveLength(1);
		expect(r.store.historyEntries(r.conv.id)).toHaveLength(2); // trigger + reply
		r.store.close();
	});

	test("a run's terminal failure fails the wake — never a blind resend", async () => {
		const edge = scriptedModel([new Error("provider down")]);
		const r = rig({ model: edge.model });
		const rec = dev(r, "poll:1");
		await waitUntil(() => wake(r, rec.wakeId).state === "failed", "wake failed");
		expect(wake(r, rec.wakeId).lastError).toContain("error");
		r.store.close();
	});

	test("a fenced run fails the wake's delivery", async () => {
		const r = rig({ model: fakeModel(["slow"], 40) });
		const rec = dev(r, "poll:1");
		await waitUntil(() => wake(r, rec.wakeId).runId !== null, "wake linked");
		r.runtime.stop(r.conv.id);
		await waitUntil(() => wake(r, rec.wakeId).state === "failed", "wake failed");
		r.store.close();
	});

	test("a wake submitted mid-turn steers into the live run — real ownership", async () => {
		const gate = deferred<void>();
		const edge = scriptedModel(
			[
				[
					{ type: "stream-start", warnings: [] },
					toolCallPart("c1", "probe"),
					finishPart("tool-calls"),
				],
				textParts("adjusted"),
			],
			{ extra: textParts("adjusted") },
		);
		const r = rig({
			model: edge.model,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						await gate.promise;
						return { ok: true };
					},
				}),
			},
		});
		const s1 = new RecordingSink();
		r.runtime.submit(r.conv, userMessage([{ type: "text", text: "start" }]), s1);
		await s1.firstToolCall; // turn is running, parked in the gated tool
		const rec = dev(r, "poll:1", "mid-turn development");
		gate.resolve();
		expect(await s1.done).toEqual({ kind: "completed" });
		await waitUntil(() => wake(r, rec.wakeId).state === "settled", "wake settled");
		const done = wake(r, rec.wakeId);
		// The wake's trigger was processed by the RUNNING turn — the run
		// that carried it is the same one that answered "start".
		const runs = r.journal.interrupted().length;
		expect(runs).toBe(0);
		expect(done.runId).not.toBeNull();
		expect(r.journal.get(done.runId!)?.status).toBe("completed");
		// One trigger in history, folded into the second model call.
		const prompts = edge.streamCalls.map((c) => JSON.stringify(c.prompt));
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("mid-turn development");
		r.store.close();
	});

	test("pump resubmits of a queued wake deduplicate — the trigger is processed once", async () => {
		const gate = deferred<void>();
		const edge = scriptedModel(
			[
				[
					{ type: "stream-start", warnings: [] },
					toolCallPart("c1", "probe"),
					finishPart("tool-calls"),
				],
				textParts("adjusted"),
			],
			{ extra: textParts("adjusted") },
		);
		const r = rig({
			model: edge.model,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => {
						await gate.promise;
						return { ok: true };
					},
				}),
			},
		});
		const s1 = new RecordingSink();
		r.runtime.submit(r.conv, userMessage([{ type: "text", text: "start" }]), s1);
		await s1.firstToolCall;
		const rec = dev(r, "poll:1", "dedupe marker");
		r.dispatcher.pump();
		r.dispatcher.pump();
		gate.resolve();
		expect(await s1.done).toEqual({ kind: "completed" });
		await waitUntil(() => wake(r, rec.wakeId).state === "settled", "wake settled");
		const done = wake(r, rec.wakeId);
		expect(done.runId).not.toBeNull();
		expect(r.journal.get(done.runId!)?.status).toBe("completed");
		const prompts = edge.streamCalls.map((c) => JSON.stringify(c.prompt));
		expect(prompts).toHaveLength(2);
		expect(prompts[1]!.split("dedupe marker").length - 1).toBe(1);
		expect(texts(r).filter((m) => m.id === done.messageId)).toHaveLength(1);
		r.store.close();
	});

	test("a resubmit during async admission startup deduplicates before the run row exists", async () => {
		const edge = scriptedModel([textParts("ok")]);
		const r = rig({ model: edge.model });
		const rec = dev(r, "poll:1", "startup marker");
		expect(wake(r, rec.wakeId).runId).toBeNull();
		r.dispatcher.pump();
		r.dispatcher.pump();
		expect(wake(r, rec.wakeId).runId).toBeNull();
		await waitUntil(() => wake(r, rec.wakeId).state === "settled", "wake settled");
		const done = wake(r, rec.wakeId);
		expect(done.runId).not.toBeNull();
		expect(r.journal.get(done.runId!)?.status).toBe("completed");
		expect(edge.streamCalls).toHaveLength(1);
		const prompt = JSON.stringify(edge.streamCalls[0]!.prompt);
		expect(prompt.split("startup marker").length - 1).toBe(1);
		expect(texts(r).filter((m) => m.id === done.messageId)).toHaveLength(1);
		r.store.close();
	});

	test("a fresh runtime admits a claimed-but-unlinked wake — the registry is process-local", async () => {
		const dbPath = tmpDb("goblin-wd-");
		const r1 = rig({ store: openStore(dbPath) });
		const claimed = claimedOnly(r1, "poll:1");
		r1.store.close();
		const r2 = rig({ store: openStore(dbPath) });
		r2.dispatcher.pump();
		await waitUntil(() => r2.wakes.get(claimed.wakeId)?.state === "settled", "wake settled");
		const rec = r2.wakes.get(claimed.wakeId)!;
		expect(rec.runId).not.toBeNull();
		expect(r2.journal.get(rec.runId!)?.status).toBe("completed");
		expect(r2.store.historyEntries(r2.conv.id)).toHaveLength(2);
		r2.store.close();
	});

	test("a resume retargets the wake to the successor run; settle follows the chain", async () => {
		const r = rig();
		const claimed = claimedOnly(r, "poll:1");
		// r1 dies mid-turn: begin a run row, link the wake, then reopen
		// the journal so 'running' reclassifies 'interrupted' — the real
		// crash boundary.
		r.journal.beginRun({
			runId: "r1",
			conversationId: r.conv.id,
			epoch: r.conv.epoch,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: { model: null, thinking: null },
			toolNames: [],
			startedAt: new Date().toISOString(),
		});
		r.wakes.linkRun(claimed.wakeId, "r1");
		const journal2 = openTurnJournal(r.store.db);
		expect(journal2.get("r1")?.status).toBe("interrupted");
		// The resume admission: successor row + source consumption in one
		// transaction, then the runtime's begin hook retargets the wake.
		journal2.beginRun({
			runId: "r2",
			conversationId: r.conv.id,
			epoch: r.conv.epoch,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: { model: null, thinking: null },
			toolNames: [],
			startedAt: new Date().toISOString(),
			resumedFrom: "r1",
		});
		r.dispatcher.hooks.begin({
			runId: "r2",
			conversationId: r.conv.id,
			memberMessageIds: [claimed.messageId],
			resumedFrom: "r1",
		});
		expect(wake(r, claimed.wakeId).runId).toBe("r2");
		// The successor completes — the wake still linked through r1's
		// consumption settles on the chain's end.
		journal2.finishRun("r2", "completed", "delivered");
		r.dispatcher.pump();
		expect(wake(r, claimed.wakeId).state).toBe("settled");
		r.store.close();
	});

	test("a wake stranded on a consumed source settles through the successor", async () => {
		const r = rig();
		const claimed = claimedOnly(r, "poll:1");
		for (const runId of ["r1", "r2", "r3"]) {
			r.journal.beginRun({
				runId,
				conversationId: r.conv.id,
				epoch: r.conv.epoch,
				anchorSeq: null,
				steerMark: null,
				convSnapshot: { model: null, thinking: null },
				toolNames: [],
				startedAt: new Date().toISOString(),
			});
		}
		r.wakes.linkRun(claimed.wakeId, "r1");
		// Chain: r1 consumed by r2, r2 consumed by r3 — all by direct
		// stamps, the crash-window state the retarget sweep repairs.
		r.store.db.run("UPDATE turn_runs SET status = 'resumed' WHERE run_id IN ('r1','r2')");
		r.store.db.run("UPDATE turn_runs SET resumed_from = 'r1' WHERE run_id = 'r2'");
		r.store.db.run("UPDATE turn_runs SET resumed_from = 'r2' WHERE run_id = 'r3'");
		r.journal.finishRun("r3", "completed", "delivered");
		r.dispatcher.pump();
		expect(wake(r, claimed.wakeId).state).toBe("settled");
		r.store.close();
	});

	test("a failed ownership link fails the wake closed — the trigger never runs twice", async () => {
		const edge = scriptedModel([textParts("ran once")]);
		let failLink = true;
		const r = rig({
			model: edge.model,
			wrapWakes: (base) => ({
				...base,
				linkRun: (wakeId, runId) => {
					if (failLink) throw new Error("ownership write wedged");
					base.linkRun(wakeId, runId);
				},
			}),
		});
		const rec = dev(r, "poll:1");
		// The begin hook could not persist ownership, so the wake takes
		// its terminal fail-closed transition instead of staying an
		// unlinked claim reconcile would resubmit.
		await waitUntil(() => wake(r, rec.wakeId).state === "failed", "wake failed closed");
		expect(wake(r, rec.wakeId).lastError).toContain("ownership link");
		expect(wake(r, rec.wakeId).runId).toBeNull();
		// The turn itself was never gated: the trigger ran exactly once.
		await waitUntil(
			() => !r.runtime.isAdmitted(r.conv.id, wake(r, rec.wakeId).messageId),
			"run drained",
		);
		// No later pump resubmits it — healed store included.
		failLink = false;
		r.dispatcher.pump();
		r.dispatcher.pump();
		expect(edge.streamCalls).toHaveLength(1);
		await r.runtime.shutdown();
		expect(
			texts(r).filter((m) => m.id === wake(r, rec.wakeId).messageId),
		).toHaveLength(1);
		r.store.close();
	});

	test("a persistently failing ownership write fences resubmission until the store heals", async () => {
		const edge = scriptedModel([textParts("ran once")]);
		let healed = false;
		const r = rig({
			model: edge.model,
			wrapWakes: (base) => ({
				...base,
				linkRun: () => {
					throw new Error("ownership write wedged");
				},
				failUnlinked: (wakeId, error) => {
					if (healed) return base.failUnlinked(wakeId, error);
					throw new Error("ownership write wedged");
				},
			}),
		});
		const rec = dev(r, "poll:1");
		// The turn is never gated; the run completes with the trigger.
		await waitUntil(() => edge.streamCalls.length === 1, "trigger ran once");
		await r.runtime.shutdown();
		// Every pump while the write path refuses: the submit stays
		// fenced — no second admission of the same trigger.
		r.dispatcher.pump();
		r.dispatcher.pump();
		expect(edge.streamCalls).toHaveLength(1);
		expect(wake(r, rec.wakeId).state).toBe("claimed");
		// The store heals: the next pump lands the durable closure.
		healed = true;
		r.dispatcher.pump();
		expect(wake(r, rec.wakeId).state).toBe("failed");
		expect(wake(r, rec.wakeId).lastError).toContain("ownership link");
		r.dispatcher.pump();
		expect(edge.streamCalls).toHaveLength(1);
		r.store.close();
	});

	test("a transient submit failure backs off, then delivers when the gate opens", async () => {
		const store = openStore(tmpDb("goblin-wd-"));
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const journal = openTurnJournal(store.db);
		const wakes = openWakeStore(store.db);
		let now = 1_000_000;
		let calls = 0;
		const failThenOk = {
			accepting: () => true,
			isAdmitted: () => false,
			submitPersisted: () => {
				calls += 1;
				if (calls === 1) throw new Error("submit boom");
				return true;
			},
		} as unknown as Runtime;
		const d = makeWakeDispatcher({
			store,
			wakes,
			journal,
			runtime: failThenOk,
			sinkFor: () => new HeadlessSink(),
			backoff: { baseMs: 100, capMs: 10_000 },
			now: () => now,
		});
		const rec = d.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		expect(calls).toBe(1);
		const w = wakes.get(rec.wakeId)!;
		expect(w.attempts).toBe(1);
		expect(w.nextAttemptAt).not.toBeNull();
		// Backoff gate holds while the clock sits inside it.
		d.pump();
		expect(calls).toBe(1);
		now += 200;
		d.pump();
		expect(calls).toBe(2);
		store.close();
	});

	test("claimedForMessages finds only claimed wakes by trigger id", () => {
		const r = rig();
		const claimed = claimedOnly(r, "poll:1");
		const pending = r.wakes.record({
			sourceKey: "poll:2",
			conversationId: r.conv.id,
			kind: "done-candidate",
			text: "other",
			facts: {},
			origin: "observer",
		});
		const hits = r.wakes.claimedForMessages([claimed.messageId, "nope"]);
		expect(hits.map((w) => w.wakeId)).toEqual([claimed.wakeId]);
		expect(r.wakes.claimedForMessages([])).toEqual([]);
		const all = r.wakes.claimedForMessages([claimed.messageId]);
		expect(all).toHaveLength(1);
		expect(pending.wakeId).not.toBe(claimed.wakeId);
		r.store.close();
	});
});
