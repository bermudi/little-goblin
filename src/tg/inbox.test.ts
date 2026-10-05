import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { openTelegramInbox, type InboxPayload } from "./inbox.ts";

const dirs: string[] = [];
function path(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-inbox-test-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

const payload = (messageId: number, conversationId = "dm:42"): InboxPayload => ({
	conversationId, chatId: 42, messageId, text: `message ${messageId}`,
	media: null, mediaError: null,
});

test("record survives reopen; duplicates before and after commit keep compact tombstones", () => {
	const file = path();
	const first = openStore(file);
	const inbox = openTelegramInbox(first.db);
	const media = { fileId: "file", fileUniqueId: "unique", fileName: "note.ogg", mimeType: "audio/ogg", transcribable: true };
	const input = { ...payload(11), media, mediaError: "transcription failed" };
	expect(inbox.record(100, input)).toBe(true);
	expect(inbox.record(100, input)).toBe(false);
	expect(inbox.record(101, input)).toBe(false); // same chat/message, new update
	expect(() => inbox.record(102, payload(11))).toThrow("conflicting identity");
	expect(() => inbox.record(100, payload(12))).toThrow("conflicting identity");
	first.close();

	const reopened = openStore(file);
	const again = openTelegramInbox(reopened.db);
	expect(again.pending()).toEqual([{ updateId: 100, payload: input }]);
	again.commitBatch([100], input.conversationId, () => {});
	expect(again.pending()).toEqual([]);
	expect(again.record(100, input)).toBe(false);
	expect(again.record(101, input)).toBe(false);
	const row = reopened.db.query<{ payload_json: string | null; committed_at: string | null }, []>(
		"SELECT payload_json, committed_at FROM tg_inbox WHERE update_id = 100",
	).get();
	expect(row?.payload_json).toBeNull();
	expect(row?.committed_at).toBeTruthy();
	reopened.close();
	const third = openStore(file);
	const tombstones = openTelegramInbox(third.db);
	expect(tombstones.pending()).toEqual([]);
	expect(tombstones.record(100, input)).toBe(false);
	expect(tombstones.record(101, input)).toBe(false);
	third.close();
});

test("coalesced append and all acknowledgements commit atomically; failure rolls both back", () => {
	const store = openStore(path());
	const conv = store.resolve({ kind: "dm", chatId: 42 }, "/workspace");
	const other = store.resolve({ kind: "dm", chatId: 43 }, "/workspace");
	const inbox = openTelegramInbox(store.db);
	inbox.record(3, payload(3));
	inbox.record(1, payload(1));
	inbox.record(2, payload(2));
	inbox.record(4, { ...payload(4, other.id), chatId: 43 });
	expect(inbox.pending().map((e) => e.updateId)).toEqual([1, 2, 3, 4]);
	let called = false;
	expect(() => inbox.commitBatch([1, 4], conv.id, () => { called = true; })).toThrow();
	expect(called).toBe(false);
	expect(() => inbox.commitBatch([1, 1], conv.id, () => { called = true; })).toThrow();
	expect(() => inbox.commitBatch([1, 99], conv.id, () => { called = true; })).toThrow();
	expect(called).toBe(false);

	const append = () => store.append(conv.id, [{ id: "m", role: "user", parts: [{ type: "text", text: "coalesced" }] }]);
	expect(() => inbox.commitBatch([3, 1, 2], conv.id, () => {
		append();
		throw new Error("append failed after savepoint");
	})).toThrow("append failed");
	expect(store.history(conv.id)).toEqual([]);
	expect(inbox.pending().map((e) => e.updateId)).toEqual([1, 2, 3, 4]);
	inbox.commitBatch([3, 1, 2], conv.id, append);
	expect(store.history(conv.id)).toHaveLength(1);
	expect(inbox.pending().map((e) => e.updateId)).toEqual([4]);
	expect(() => inbox.commitBatch([1], conv.id, append)).toThrow();
	expect(store.history(conv.id)).toHaveLength(1);
	store.close();
});

test("malformed persisted payload fails loudly, including a mismatched address", () => {
	const db = new Database(":memory:");
	const inbox = openTelegramInbox(db);
	inbox.record(1, payload(1));
	db.run("UPDATE tg_inbox SET payload_json = ? WHERE update_id = 1", ['{"text":5}']);
	expect(() => inbox.pending()).toThrow(/update 1/);
	expect(() => inbox.commitBatch([1], "dm:42", () => {})).toThrow(/update 1/);
	db.run("UPDATE tg_inbox SET payload_json = ? WHERE update_id = 1", [JSON.stringify({ ...payload(1), chatId: 999 })]);
	expect(() => inbox.pending()).toThrow(/update 1/);
	db.run("UPDATE tg_inbox SET payload_json = ? WHERE update_id = 1", ["{broken"]);
	expect(() => inbox.pending()).toThrow(/JSON for update 1/);
	db.close();
});

test("database errors propagate rather than becoming duplicate results", () => {
	const db = new Database(":memory:");
	const inbox = openTelegramInbox(db);
	db.run("DROP TABLE tg_inbox");
	expect(() => inbox.record(1, payload(1))).toThrow();
	db.close();
});

test("a database failure after append rolls the history savepoint back", () => {
	const store = openStore(path());
	const conv = store.resolve({ kind: "dm", chatId: 42 }, "/workspace");
	const inbox = openTelegramInbox(store.db);
	inbox.record(1, payload(1));
	store.db.run(`CREATE TRIGGER fail_ack BEFORE UPDATE ON tg_inbox
		BEGIN SELECT RAISE(ABORT, 'ack failed'); END`);
	expect(() => inbox.commitBatch([1], conv.id, () => {
		store.append(conv.id, [{ id: "m", role: "user", parts: [{ type: "text", text: "hello" }] }]);
	})).toThrow("ack failed");
	expect(store.history(conv.id)).toEqual([]);
	expect(inbox.pending()).toHaveLength(1);
	store.close();
});

test("navigation assignments survive restart, preserve intake identity, and never change across later navigation", () => {
	const file = path();
	const store = openStore(file);
	const outgoing = store.rollDm(42, "/workspace");
	const next = store.rollDm(42, "/workspace");
	const inbox = openTelegramInbox(store.db);
	inbox.record(1, payload(1));
	inbox.record(9, payload(9));
	inbox.record(10, payload(10));
	inbox.record(11, payload(11));
	expect(inbox.hasPendingBefore("dm:42", 1)).toBe(false);
	expect(inbox.hasPendingBefore("dm:42", 10)).toBe(true);
	expect(inbox.assertRouteable([1, 9], "dm:42")).toBe(true);
	expect(inbox.archivePendingBefore("dm:42", 10, outgoing.id)).toBe(2);
	expect(inbox.assertRouteable([1, 9], "dm:42")).toBe(false);
	expect(inbox.assertRouteable([10, 11], "dm:42")).toBe(true);
	expect(inbox.archivePendingBefore("dm:42", 11, next.id)).toBe(1);
	expect(inbox.archivedTarget(1, "dm:42")).toBe(outgoing.id);
	expect(inbox.archivedTarget(10, "dm:42")).toBe(next.id);
	expect(inbox.archivedTarget(11, "dm:42")).toBeNull();
	expect(inbox.record(1, payload(1))).toBe(false);
	expect(inbox.pending()[0]?.payload.conversationId).toBe("dm:42");
	store.close();
	const reopened = openStore(file);
	const again = openTelegramInbox(reopened.db);
	expect(again.archivedTarget(1, "dm:42")).toBe(outgoing.id);
	expect(again.archivePendingBefore("dm:42", 11, next.id)).toBe(0);
	const append = () => reopened.append(outgoing.id, [{ id: "archived", role: "user", parts: [{ type: "text", text: "history only" }] }]);
	again.commitBatch([1, 9], outgoing.id, append);
	expect(reopened.history(outgoing.id)).toHaveLength(1);
	expect(reopened.history(next.id)).toEqual([]);
	expect(again.archivedTarget(1, "dm:42")).toBe(outgoing.id);
	expect(again.record(1, payload(1))).toBe(false);
	expect(() => again.commitBatch([1, 9], outgoing.id, append)).toThrow();
	expect(reopened.history(outgoing.id)).toHaveLength(1);
	expect(again.assertRouteable([1], "dm:42")).toBe(false);
	reopened.close();
});

test("archive scope is validated and a failed assignment transaction assigns no rows", () => {
	const store = openStore(path());
	const outgoing = store.rollDm(42, "/workspace");
	const other = store.rollDm(43, "/workspace");
	const inbox = openTelegramInbox(store.db);
	inbox.record(1, payload(1));
	inbox.record(2, payload(2));
	expect(() => inbox.archivePendingBefore("dm:42", 3, other.id)).toThrow();
	expect(() => inbox.archivePendingBefore("dm:42", 3, "dm:42")).toThrow();
	expect(() => inbox.archivePendingBefore("dm:42", 3, "dm:42:99")).toThrow();
	expect(() => inbox.archivePendingBefore("dm:-42", 3, outgoing.id)).toThrow();
	expect(() => inbox.archivePendingBefore("dm:42", -1, outgoing.id)).toThrow();
	store.db.run(`CREATE TRIGGER fail_archive BEFORE INSERT ON tg_inbox_archives
		WHEN NEW.update_id = 2 BEGIN SELECT RAISE(ABORT, 'archive failed'); END`);
	expect(() => inbox.archivePendingBefore("dm:42", 3, outgoing.id)).toThrow("archive failed");
	expect(inbox.archivedTarget(1, "dm:42")).toBeNull();
	expect(inbox.assertRouteable([1, 2], "dm:42")).toBe(true);
	store.db.run("DROP TRIGGER fail_archive");
	inbox.archivePendingBefore("dm:42", 3, outgoing.id);
	expect(() => inbox.archivedTarget(1, "dm:43")).toThrow();
	expect(inbox.assertRouteable([3], "dm:42")).toBe(false);
	expect(inbox.assertRouteable([1, 1], "dm:42")).toBe(false);
	store.close();
});

test("archived history append and acknowledgement still share the failure rollback", () => {
	const store = openStore(path());
	const outgoing = store.rollDm(42, "/workspace");
	const inbox = openTelegramInbox(store.db);
	inbox.record(1, payload(1));
	inbox.archivePendingBefore("dm:42", 2, outgoing.id);
	store.db.run(`CREATE TRIGGER fail_archived_ack BEFORE UPDATE ON tg_inbox
		BEGIN SELECT RAISE(ABORT, 'ack failed'); END`);
	expect(() => inbox.commitBatch([1], outgoing.id, () => {
		store.append(outgoing.id, [{ id: "m", role: "user", parts: [{ type: "text", text: "history only" }] }]);
	})).toThrow("ack failed");
	expect(store.history(outgoing.id)).toEqual([]);
	expect(inbox.pending()).toHaveLength(1);
	expect(inbox.archivedTarget(1, "dm:42")).toBe(outgoing.id);
	store.close();
});
