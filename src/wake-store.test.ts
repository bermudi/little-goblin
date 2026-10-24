import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { UIMessage } from "ai";
import { openStore, type ConversationStore } from "./conversation.ts";
import { setLogFile, setLogWriter } from "./log.ts";
import type { JournalStatus } from "./turn-journal.ts";
import { openWakeStore } from "./wake-store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "goblin-wake-store-"));
	dirs.push(dir);
	const store = openStore(join(dir, "goblin.sqlite"));
	const conv = store.resolve({ kind: "dm", chatId: 7 }, dir);
	const other = store.resolve({ kind: "dm", chatId: 8 }, dir);
	const wakes = openWakeStore(store.db);
	return { dir, store, conv, other, wakes };
}

const trigger = (id: string, text: string): UIMessage => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});

// The append the dispatcher will run: the wake's stable message into
// history, inside the wake store's own transaction.
function appendInto(store: ConversationStore, conversationId: string) {
	const calls: { id: string; text: string }[] = [];
	const append = (t: { id: string; text: string }) => {
		calls.push(t);
		store.append(conversationId, [trigger(t.id, t.text)]);
	};
	return { calls, append };
}

describe("wake store", () => {
	test("opening a pre-epoch wake table migrates without restoring unknown authority", () => {
		const store = openStore(":memory:");
		const conv = store.resolve({ kind: "dm", chatId: 9 }, "/w");
		// openStore now ensures the wake schema itself — drop back to the
		// pre-epoch shape to model the legacy database.
		store.db.run("DROP TABLE wake_events");
		store.db.run("DROP TABLE wake_deliveries");
		store.db.run(`CREATE TABLE wake_deliveries (
			wake_id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL,
			message_id TEXT NOT NULL, state TEXT NOT NULL, history_seq INTEGER,
			run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
			next_attempt_at TEXT, created_at TEXT NOT NULL, claimed_at TEXT,
			settled_at TEXT
		)`);
		store.db.run(
			`INSERT INTO wake_deliveries
			(conversation_id, message_id, state, history_seq, created_at, claimed_at)
			VALUES (?, 'legacy-message', 'claimed', 1, '2026-10-19', '2026-10-19')`,
			[conv.id],
		);
		const wakes = openWakeStore(store.db);
		expect(wakes.get(1)?.claimEpoch).toBeNull();
		const plan = wakes.reconcile(new Date().toISOString(), () => null);
		expect(plan.toFail.map((w) => w.wakeId)).toEqual([1]);
		expect(plan.toResubmit).toHaveLength(0);
		store.close();
	});

	test("unlinked claims survive a crash, but not a durable authority fence", () => {
		const { dir, store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "claim-before-stop",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "a development",
			facts: {},
			origin: "observer",
		});
		wakes.commit(rec.wakeId, appendInto(store, conv.id).append);
		expect(wakes.get(rec.wakeId)?.claimEpoch).toBe(conv.epoch);
		const now = new Date().toISOString();
		expect(wakes.reconcile(now, () => null).toResubmit).toHaveLength(1);
		store.bumpEpoch(conv.id);
		store.close();
		const reopened = openStore(join(dir, "goblin.sqlite"));
		const recovered = openWakeStore(reopened.db);
		expect(recovered.reconcile(now, () => null).toResubmit).toHaveLength(0);
		expect(recovered.reconcile(now, () => null).toFail.map((w) => w.wakeId)).toEqual([rec.wakeId]);
		// An old claim without a provable epoch must also fail closed.
		reopened.db.run("UPDATE wake_deliveries SET claim_epoch = NULL");
		expect(recovered.reconcile(now, () => null).toFail).toHaveLength(1);
		reopened.close();
	});

	test("a duplicate source key cannot create a second event or wake", () => {
		const { conv, wakes } = setup();
		const first = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "worker went idle",
			facts: { seq: 7 },
			origin: "observer",
		});
		expect(first.created).toBe(true);
		const again = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "worker went idle",
			facts: { seq: 8 },
			origin: "observer",
		});
		expect(again).toEqual({ eventId: first.eventId, wakeId: first.wakeId, created: false });
		expect(() =>
			wakes.record({
				sourceKey: "poll:1",
				conversationId: conv.id,
				kind: "done-candidate",
				text: "a different line",
				facts: null,
				origin: "observer",
			}),
		).toThrow(/different identity/);
		const pending = wakes.pending(conv.id);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.events).toHaveLength(1);
	});

	test("an occurrence replay reuses the recorded event across drifted text, never drifted identity", () => {
		const { conv, other, wakes } = setup();
		const first = wakes.record({
			sourceKey: "program:3:occ:2026-10-20T00:00:00.000Z",
			conversationId: conv.id,
			kind: "scheduled-checkin",
			text: "rev 1 understanding",
			facts: {},
			origin: "scheduler",
		});
		// The scheduler's crash-window replay: same occurrence key, the
		// mutable state in the text moved on. The recorded occurrence is
		// the one that stands.
		const replayed = wakes.record({
			sourceKey: "program:3:occ:2026-10-20T00:00:00.000Z",
			conversationId: conv.id,
			kind: "scheduled-checkin",
			text: "rev 2 understanding",
			facts: {},
			origin: "scheduler",
			replay: true,
		});
		expect(replayed).toEqual({ eventId: first.eventId, wakeId: first.wakeId, created: false });
		const stored = wakes.get(first.wakeId)!;
		expect(stored.text).toBe("rev 1 understanding");
		// Without the replay flag the drift is still the corruption it was.
		expect(() =>
			wakes.record({
				sourceKey: "program:3:occ:2026-10-20T00:00:00.000Z",
				conversationId: conv.id,
				kind: "scheduled-checkin",
				text: "rev 3 understanding",
				facts: {},
				origin: "scheduler",
			}),
		).toThrow(/different identity/);
		// Conversation and kind are identity even for a replay.
		expect(() =>
			wakes.record({
				sourceKey: "program:3:occ:2026-10-20T00:00:00.000Z",
				conversationId: other.id,
				kind: "scheduled-checkin",
				text: "rev 1 understanding",
				facts: {},
				origin: "scheduler",
				replay: true,
			}),
		).toThrow(/different identity/);
		expect(() =>
			wakes.record({
				sourceKey: "program:3:occ:2026-10-20T00:00:00.000Z",
				conversationId: conv.id,
				kind: "program-mail",
				text: "rev 1 understanding",
				facts: {},
				origin: "scheduler",
				replay: true,
			}),
		).toThrow(/different identity/);
	});

	test("developments coalesce into one pending wake per conversation, ids preserved", () => {
		const { conv, other, wakes } = setup();
		const a = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line one",
			facts: {},
			origin: "observer",
		});
		const b = wakes.record({
			sourceKey: "poll:2",
			conversationId: conv.id,
			kind: "blocked-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		const c = wakes.record({
			sourceKey: "poll:3",
			conversationId: other.id,
			kind: "done-candidate",
			text: "elsewhere",
			facts: {},
			origin: "scheduler",
		});
		expect(b.wakeId).toBe(a.wakeId);
		expect(c.wakeId).not.toBe(a.wakeId);
		const pending = wakes.pending(conv.id);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.events.map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
		expect(pending[0]!.text).toBe("line one\nline two");
		expect(wakes.pending(other.id)).toHaveLength(1);
	});

	test("commit appends the trigger exactly once and stamps the history reference", () => {
		const { store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "the one line",
			facts: {},
			origin: "observer",
		});
		const { calls, append } = appendInto(store, conv.id);
		const claimed = wakes.commit(rec.wakeId, append);
		expect(claimed.state).toBe("claimed");
		expect(claimed.historySeq).toBe(1);
		expect(claimed.claimedAt).not.toBeNull();
		expect(calls).toEqual([{ id: claimed.messageId, text: "the one line" }]);
		const entries = store.historyEntries(conv.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.seq).toBe(claimed.historySeq!);
		expect(entries[0]!.message.id).toBe(claimed.messageId);
		// A wake past pending is returned unchanged — never appended again.
		const again = wakes.commit(rec.wakeId, append);
		expect(calls).toHaveLength(1);
		expect(again.historySeq).toBe(claimed.historySeq);
		expect(store.historyEntries(conv.id)).toHaveLength(1);
	});

	test("a commit whose append lands nothing is refused and rolled back", () => {
		const { wakes, conv } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		expect(() => wakes.commit(rec.wakeId, () => {})).toThrow(/left no history event/);
		expect(wakes.get(rec.wakeId)!.state).toBe("pending");
	});

	test("a commit whose append lands a foreign message is refused and rolled back", () => {
		const { store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		expect(() =>
			wakes.commit(rec.wakeId, () => {
				store.append(conv.id, [trigger("foreign-message", "not the wake")]);
			}),
		).toThrow(/did not land/);
		expect(wakes.get(rec.wakeId)!.state).toBe("pending");
		expect(store.historyEntries(conv.id)).toHaveLength(0);
	});

	test("run links: only a claimed wake links, idempotent per run, retargeted by a resume", () => {
		const { store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		expect(() => wakes.linkRun(rec.wakeId, "run-1")).toThrow(/cannot link/);
		const { append } = appendInto(store, conv.id);
		wakes.commit(rec.wakeId, append);
		wakes.linkRun(rec.wakeId, "run-1");
		wakes.linkRun(rec.wakeId, "run-1"); // idempotent for the same run
		expect(wakes.get(rec.wakeId)!.runId).toBe("run-1");
		expect(() => wakes.linkRun(rec.wakeId, "run-2")).toThrow(/already owns/);
		wakes.retargetRun(rec.wakeId, "run-1", "run-2");
		expect(wakes.get(rec.wakeId)!.runId).toBe("run-2");
		expect(() => wakes.retargetRun(rec.wakeId, "run-1", "run-3")).toThrow(/does not own/);
		expect(wakes.forRun("run-2")).toHaveLength(1);
		expect(wakes.forRun("run-1")).toHaveLength(0);
	});

	test("settle is terminal: only a claimed wake settles, and only once", () => {
		const { store, conv, wakes } = setup();
		const a = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line a",
			facts: {},
			origin: "observer",
		});
		expect(() => wakes.settle(a.wakeId, "settled")).toThrow(/cannot settle/);
		const { append } = appendInto(store, conv.id);
		wakes.commit(a.wakeId, append);
		wakes.settle(a.wakeId, "settled");
		expect(wakes.get(a.wakeId)!.state).toBe("settled");
		expect(wakes.get(a.wakeId)!.settledAt).not.toBeNull();
		expect(() => wakes.settle(a.wakeId, "settled")).toThrow(/cannot settle/);
		const b = wakes.record({
			sourceKey: "poll:2",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line b",
			facts: {},
			origin: "observer",
		});
		wakes.commit(b.wakeId, append);
		wakes.settle(b.wakeId, "failed", { error: "turn errored" });
		expect(wakes.get(b.wakeId)!.lastError).toBe("turn errored");
	});

	test("a transient failure counts attempts and gates retry; a run link clears the gate", () => {
		const { store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(rec.wakeId, append);
		const next = new Date(Date.now() + 60_000).toISOString();
		wakes.noteFailure(rec.wakeId, "runtime refused", next);
		let w = wakes.get(rec.wakeId)!;
		expect(w.attempts).toBe(1);
		expect(w.lastError).toBe("runtime refused");
		expect(w.nextAttemptAt).toBe(next);
		wakes.noteFailure(rec.wakeId, "still refused", next);
		expect(wakes.get(rec.wakeId)!.attempts).toBe(2);
		wakes.linkRun(rec.wakeId, "run-1");
		expect(wakes.get(rec.wakeId)!.nextAttemptAt).toBeNull();
	});

	test("reconcile classifies every open wake against run state", () => {
		const { store, conv, wakes } = setup();
		const { append } = appendInto(store, conv.id);
		let seq = 0;
		const open = (opts?: { link?: string; failAt?: string }) => {
			seq += 1;
			const rec = wakes.record({
				sourceKey: `poll:${seq}`,
				conversationId: conv.id,
				kind: "done-candidate",
				text: `dev ${seq}`,
				facts: {},
				origin: "observer",
			});
			wakes.commit(rec.wakeId, append);
			if (opts?.link !== undefined) wakes.linkRun(rec.wakeId, opts.link);
			if (opts?.failAt !== undefined) wakes.noteFailure(rec.wakeId, "refused", opts.failAt);
			return rec.wakeId;
		};
		const past = new Date(Date.now() - 60_000).toISOString();
		const future = new Date(Date.now() + 60_000).toISOString();
		const wResubmit = open();
		const wBackoff = open({ failAt: future });
		const wDue = open({ failAt: past });
		const wDone = open({ link: "run-done" });
		const wErr = open({ link: "run-err" });
		const wInt = open({ link: "run-int" });
		const wRes = open({ link: "run-res" });
		seq += 1;
		const wPending = wakes.record({
			sourceKey: `poll:${seq}`,
			conversationId: conv.id,
			kind: "done-candidate",
			text: `dev ${seq}`,
			facts: {},
			origin: "observer",
		}).wakeId;

		const statuses = new Map<string, JournalStatus>([
			["run-done", "completed"],
			["run-err", "error"],
			["run-int", "interrupted"],
			["run-res", "resumed"],
		]);
		const plan = wakes.reconcile(new Date().toISOString(), (runId) => statuses.get(runId) ?? null);
		expect(plan.toAppend.map((w) => w.wakeId)).toEqual([wPending]);
		expect(plan.toResubmit.map((w) => w.wakeId).sort()).toEqual([wResubmit, wDue].sort());
		expect(plan.waitingBackoff.map((w) => w.wakeId)).toEqual([wBackoff]);
		expect(plan.toSettle.map((w) => w.wakeId)).toEqual([wDone]);
		expect(plan.toFail.map((w) => w.wakeId)).toEqual([wErr]);
		expect(plan.preserved.map((w) => w.wakeId).sort()).toEqual([wInt, wRes].sort());
		expect(plan.toSettle[0]!.runId).toBe("run-done");
	});

	test("a wake linking a run the journal does not know fails itself, not the pass", () => {
		const { store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(rec.wakeId, append);
		wakes.linkRun(rec.wakeId, "run-ghost");
		// The corrupt wake classifies failed; classification continues —
		// the conversation's next pending wake still owes an append.
		const healthy = wakes.record({
			sourceKey: "poll:2",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		const plan = wakes.reconcile(new Date().toISOString(), () => null);
		expect(plan.toFail.map((w) => w.wakeId)).toEqual([rec.wakeId]);
		expect(plan.toAppend.map((w) => w.wakeId)).toEqual([healthy.wakeId]);
	});

	test("a wake whose conversation row is gone fails itself, not the pass", () => {
		const { store, conv, other, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(rec.wakeId, append);
		// Only out-of-band surgery reaches this state — the FK chain and
		// deleteConversation's sweep keep wake rows with their conversation.
		store.db.run("PRAGMA foreign_keys = OFF");
		store.db.run("DELETE FROM conversations WHERE id = ?", [conv.id]);
		store.db.run("PRAGMA foreign_keys = ON");
		const healthy = wakes.record({
			sourceKey: "poll:2",
			conversationId: other.id,
			kind: "done-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		const plan = wakes.reconcile(new Date().toISOString(), () => null);
		expect(plan.toFail.map((w) => w.wakeId)).toEqual([rec.wakeId]);
		expect(plan.toAppend.map((w) => w.wakeId)).toEqual([healthy.wakeId]);
	});

	test("one undecodable wake row is skipped loudly — the pass never wedges", () => {
		const { store, conv, other, wakes } = setup();
		const bad = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const healthy = wakes.record({
			sourceKey: "poll:2",
			conversationId: other.id,
			kind: "done-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		// Out-of-band corruption only — SQLite's dynamic typing lets a
		// TEXT land in the INTEGER column, and a rollback deploy leaves
		// rows the running schema rejects. The poison row must cost its
		// own error line per pump (naming the wake); classification must
		// continue — the healthy wake in the other conversation still
		// owes its append.
		store.db.run("UPDATE wake_deliveries SET attempts = 'x' WHERE wake_id = ?", [bad.wakeId]);
		const lines: Record<string, unknown>[] = [];
		setLogFile("wake-store-op.log");
		setLogWriter((_p, line) => lines.push(JSON.parse(line) as Record<string, unknown>));
		try {
			const plan = wakes.reconcile(new Date().toISOString(), () => null);
			expect(plan.toAppend.map((w) => w.wakeId)).toEqual([healthy.wakeId]);
		} finally {
			setLogWriter(null);
			setLogFile(null);
		}
		const err = lines.find((l) => l.msg === "wake row undecodable — skipped this reconcile");
		expect(err).toMatchObject({ wake: bad.wakeId, conversation: conv.id, state: "pending" });
		expect(String(err?.error)).toContain("attempts");
	});

	test("a pending wake whose conversation row is gone fails terminally, not the pass", () => {
		const { store, conv, other, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		// Never committed — the pending state. Same out-of-band surgery.
		store.db.run("PRAGMA foreign_keys = OFF");
		store.db.run("DELETE FROM conversations WHERE id = ?", [conv.id]);
		store.db.run("PRAGMA foreign_keys = ON");
		const healthy = wakes.record({
			sourceKey: "poll:2",
			conversationId: other.id,
			kind: "done-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		const plan = wakes.reconcile(new Date().toISOString(), () => null);
		expect(plan.toFail.map((w) => w.wakeId)).toEqual([rec.wakeId]);
		expect(plan.toAppend.map((w) => w.wakeId)).toEqual([healthy.wakeId]);
		// The dispatcher's transition for pending orphans: claim without an
		// append, then settle failed — the same tomb settle leaves.
		wakes.failOrphan(rec.wakeId, "wake conversation row is missing");
		const tomb = wakes.get(rec.wakeId)!;
		expect(tomb.state).toBe("failed");
		expect(tomb.settledAt).not.toBeNull();
		expect(tomb.lastError).toBe("wake conversation row is missing");
		expect(tomb.claimEpoch).toBeNull(); // no provable authority
		expect(tomb.historySeq).toBe(-1); // sentinel — nothing was appended
		// Terminal: a later pass no longer classifies it, and the
		// transition refuses to run twice.
		expect(wakes.reconcile(new Date().toISOString(), () => null).toFail).toHaveLength(0);
		expect(() => wakes.failOrphan(rec.wakeId, "again")).toThrow(/cannot fail as orphan/);
	});

	test("deleting a conversation sweeps its wake, event, and join rows", () => {
		const { store, conv, wakes } = setup();
		const done = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(done.wakeId, append);
		wakes.settle(done.wakeId, "settled");
		const open = wakes.record({
			sourceKey: "poll:2",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		store.deleteConversation(conv.id);
		expect(store.get(conv.id)).toBeNull();
		expect(wakes.get(done.wakeId)).toBeNull();
		expect(wakes.pending(conv.id)).toHaveLength(0);
		expect(
			store.db
				.query("SELECT COUNT(*) AS n FROM work_events WHERE conversation_id = ?")
				.get(conv.id),
		).toEqual({ n: 0 });
		expect(store.db.query("SELECT COUNT(*) AS n FROM wake_events").get()).toEqual({ n: 0 });
		expect(open.created).toBe(true);
	});

	test("settled work does not block the next development; a repeated key stays a no-op", () => {
		const { store, conv, wakes } = setup();
		const first = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line one",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(first.wakeId, append);
		wakes.settle(first.wakeId, "settled");
		const replay = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line one",
			facts: {},
			origin: "observer",
		});
		expect(replay.created).toBe(false);
		expect(replay.wakeId).toBe(first.wakeId);
		const next = wakes.record({
			sourceKey: "poll:2",
			conversationId: conv.id,
			kind: "blocked-candidate",
			text: "line two",
			facts: {},
			origin: "observer",
		});
		expect(next.created).toBe(true);
		expect(next.wakeId).not.toBe(first.wakeId);
		expect(wakes.pending(conv.id)).toHaveLength(1);
	});

	test("committed state is on disk for the next process to read", () => {
		const { dir, store, conv, wakes } = setup();
		const rec = wakes.record({
			sourceKey: "poll:1",
			conversationId: conv.id,
			kind: "done-candidate",
			text: "line",
			facts: {},
			origin: "observer",
		});
		const { append } = appendInto(store, conv.id);
		wakes.commit(rec.wakeId, append);
		const messageId = wakes.get(rec.wakeId)!.messageId;
		const second = new Database(join(dir, "goblin.sqlite"));
		const row = second
			.query<{ state: string; history_seq: number; message_id: string }, [number]>(
				"SELECT state, history_seq, message_id FROM wake_deliveries WHERE wake_id = ?",
			)
			.get(rec.wakeId);
		second.close();
		expect(row).toEqual({ state: "claimed", history_seq: 1, message_id: messageId });
	});
});
