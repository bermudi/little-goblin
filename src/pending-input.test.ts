import { expect, test } from "bun:test";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { PendingInputs, recoverPendingInputs } from "./pending-input.ts";
import { useHome } from "./testkit.ts";

test("pending inputs list in admission order and take removes one row", () => {
	const store = openStore(join(useHome("goblin-pending-input-"), "state.sqlite"));
	try {
		store.resolve({ kind: "app", appId: "pending-test", chatId: 0, threadId: 0 }, "/unused");
		const pending = new PendingInputs(store.db);
		const first = pending.add("app/pending-test", {
			id: "first",
			role: "user",
			parts: [{ type: "text", text: "first" }],
		}, "steer");
		const second = pending.add("app/pending-test", {
			id: "second",
			role: "user",
			parts: [{ type: "text", text: "second" }],
		}, "followUp");
		expect(pending.list("app/pending-test").map((row) => row.id)).toEqual([first.id, second.id]);
		expect(pending.all().map((row) => row.id)).toEqual([first.id, second.id]);
		expect(pending.take(first.id)).toEqual(first);
		expect(pending.take(first.id)).toBeNull();
		expect(pending.list("app/pending-test")).toEqual([second]);
	} finally {
		store.close();
	}
});

test("boot recovery appends stranded inputs to history and clears the inbox", () => {
	const store = openStore(join(useHome("goblin-pending-recovery-"), "state.sqlite"));
	try {
		store.resolve({ kind: "app", appId: "recovery-test", chatId: 0, threadId: 0 }, "/unused");
		const pending = new PendingInputs(store.db);
		const row = pending.add(
			"app/recovery-test",
			{ id: "stranded", role: "user", parts: [{ type: "text", text: "resume me" }] },
			"followUp",
		);
		recoverPendingInputs(store);
		expect(pending.list("app/recovery-test")).toEqual([]);
		expect(store.history("app/recovery-test")).toEqual([
			expect.objectContaining({ id: "stranded", role: "user" }),
		]);
		expect(pending.all()).toEqual([]);
		expect(row.id).toBeTruthy();
	} finally {
		store.close();
	}
});

test("a failed history append rolls the pending-row delete back with it", () => {
	const store = openStore(join(useHome("goblin-pending-rollback-"), "state.sqlite"));
	try {
		store.resolve({ kind: "app", appId: "rollback-test", chatId: 0, threadId: 0 }, "/unused");
		const pending = new PendingInputs(store.db);
		const row = pending.add(
			"app/rollback-test",
			{ id: "pending", role: "user", parts: [{ type: "text", text: "atomic" }] },
			"steer",
		);
		store.db.run(`
			CREATE TRIGGER reject_pending_history
			BEFORE INSERT ON events
			WHEN NEW.conversation_id = 'app/rollback-test' AND NEW.role = 'user'
			BEGIN
				SELECT RAISE(ABORT, 'fixture history failure');
			END
		`);

		expect(() =>
			store.db.transaction(() => {
				expect(pending.take(row.id)).not.toBeNull();
				store.append("app/rollback-test", [row.message]);
			})(),
		).toThrow("fixture history failure");
		expect(pending.list("app/rollback-test").map(({ id, mode }) => ({ id, mode }))).toEqual([
			{ id: row.id, mode: "steer" },
		]);
		expect(store.history("app/rollback-test")).toEqual([]);
	} finally {
		store.close();
	}
});
