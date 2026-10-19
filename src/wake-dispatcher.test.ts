// Wake dispatcher — the delivery half of durable wakes: commit once,
// submitPersisted, link the claimed wake to the journal run that
// actually owns its trigger (initial claim, resume queue claim,
// steer join, resume/overflow retarget), settle on the run's terminal
// stamp. Fakes live at the edges: the model is scripted, the runtime
// is real, the store/journal/wake store are real SQLite.

import { describe, expect, test } from "bun:test";
import { type LanguageModel, tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { Runtime, userMessage } from "./runtime.ts";
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
	opts: { model?: LanguageModel; tools?: ToolSet; store?: Store } = {},
): Rig {
	const store = opts.store ?? openStore(tmpDb("goblin-wd-"));
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const journal = openTurnJournal(store.db);
	const wakes = openWakeStore(store.db);
	let dispatcher!: WakeDispatcher;
	const runtime = new Runtime({
		store,
		turnJournal: journal,
		buildStep: () => ({ model: opts.model ?? fakeModel(["ok"]), system: "test" }),
		makeTools: () => opts.tools ?? {},
		runOwnership: {
			begin: (e) => dispatcher.hooks.begin(e),
			members: (r, ids) => dispatcher.hooks.members(r, ids),
			end: (r, s, d) => dispatcher.hooks.end(r, s, d),
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
				[{ type: "stream-start", warnings: [] }, toolCallPart("c1", "probe"), finishPart("tool-calls")],
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
				[{ type: "stream-start", warnings: [] }, toolCallPart("c1", "probe"), finishPart("tool-calls")],
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
