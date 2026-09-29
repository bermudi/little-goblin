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
