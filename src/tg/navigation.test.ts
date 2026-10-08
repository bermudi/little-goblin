import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ConversationStore } from "../conversation.ts";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Runtime, userMessage, type TurnDone, type TurnSink } from "../runtime.ts";
import { openTelegramInbox } from "./inbox.ts";
import { navigateDm } from "./navigation.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "goblin-navigation-test-"));
	dirs.push(dir);
	const file = join(dir, "goblin.sqlite");
	const store = openStore(file);
	const stopped: string[] = [];
	const runtime = runtimeEdge(store, stopped);
	return { file, store, runtime, stopped, inbox: openTelegramInbox(store.db) };
}
function runtimeEdge(store: ConversationStore, stopped: string[]): Pick<Runtime, "cancelFenced"> {
	return {
		cancelFenced(id: string, epoch: number) {
			expect(store.get(id)?.epoch).toBe(epoch);
			expect(store.currentDm(42)?.id).not.toBe(id);
			// Both the fence and receipt must already be visible to another
			// connection: checking only this connection would miss an open tx.
			const committed = openStore(store.db.filename);
			try {
				expect(committed.get(id)?.epoch).toBe(epoch);
				expect(committed.currentDm(42)?.id).toBe(store.currentDm(42)?.id);
				expect(committed.db.query("SELECT COUNT(*) AS count FROM tg_dm_navigation").get()).toEqual(
					store.db.query("SELECT COUNT(*) AS count FROM tg_dm_navigation").get(),
				);
			} finally {
				committed.close();
			}
			stopped.push(id);
			return { stopped: true, reviewsCancelled: 2, settled: Promise.resolve() };
		},
	};
}
function command(updateId: number, kind: "new" | "back" = "new") {
	return { chatId: 42, updateId, messageId: updateId, command: kind };
}
function record(deps: ReturnType<typeof fixture>, updateId: number) {
	deps.inbox.record(updateId, {
		conversationId: "dm:42",
		chatId: 42,
		messageId: updateId,
		text: "pending input",
		media: {
			fileId: "file",
			fileUniqueId: "unique",
			fileName: "photo.jpg",
			mimeType: "image/jpeg",
		},
		mediaError: null,
	});
}

test("new durably fences and selects before cancellation, preserving history and assigning only earlier pending input", () => {
	const deps = fixture();
	const first = deps.store.rollDm(42, "/workspace");
	deps.store.append(first.id, [
		{ id: "old", role: "user", parts: [{ type: "text", text: "old history" }] },
	]);
	record(deps, 1);
	record(deps, 11);
	const result = navigateDm(deps, command(10));
	expect(result).toMatchObject({
		fromId: first.id,
		toId: "dm:42:2",
		outcome: "new",
		duplicate: false,
		stopped: true,
		reviewsCancelled: 2,
		archivedInputs: 1,
	});
	expect(deps.store.currentDm(42)?.id ?? null).toBe(result.toId);
	expect(deps.store.get(first.id)?.epoch).toBe(1);
	expect(deps.store.history(first.id)).toHaveLength(1);
	expect(deps.store.history(result.conv!.id)).toEqual([]);
	expect(deps.inbox.archivedTarget(1, "dm:42")).toBe(first.id);
	expect(deps.inbox.archivedTarget(11, "dm:42")).toBeNull();
	expect(deps.inbox.assertRouteable([1], "dm:42")).toBe(false);
	expect(deps.inbox.assertRouteable([11], "dm:42")).toBe(true);
	// Media conversion can finish after navigation, but history still goes
	// to its original assignment; the rows are not automatically replayed.
	expect(deps.inbox.pending()).toHaveLength(2);
	deps.store.close();
});

test("new with no current creates only the first, or an outgoing history followed by a fresh first selection", () => {
	const empty = fixture();
	const first = navigateDm(empty, command(10));
	expect(first).toMatchObject({ fromId: null, toId: "dm:42:1", stopped: false, archivedInputs: 0 });
	expect(empty.stopped).toEqual([]);
	empty.store.close();
	const pending = fixture();
	record(pending, 1);
	const fresh = navigateDm(pending, command(10));
	expect(fresh).toMatchObject({
		fromId: "dm:42:1",
		toId: "dm:42:2",
		archivedInputs: 1,
		stopped: false,
		reviewsCancelled: 0,
	});
	expect(pending.stopped).toEqual([]);
	expect(pending.inbox.archivedTarget(1, "dm:42")).toBe("dm:42:1");
	expect(pending.store.history("dm:42:1")).toEqual([]);
	pending.store.close();
});

test("command receipt deduplicates updates, message identities and aliases across restart without navigating again", () => {
	const deps = fixture();
	const outgoing = deps.store.rollDm(42, "");
	const original = navigateDm(deps, command(10));
	expect(original).toMatchObject({ stopped: true, reviewsCancelled: 2 });
	const epoch = deps.store.get(outgoing.id)?.epoch;
	const replay = { ...original, duplicate: true, stopped: false, reviewsCancelled: 0 };
	expect(navigateDm(deps, command(10))).toMatchObject(replay);
	expect(navigateDm(deps, { ...command(11), messageId: 10 })).toMatchObject(replay);
	expect(deps.store.get(outgoing.id)?.epoch).toBe(epoch);
	expect(deps.stopped).toEqual([outgoing.id]);
	const receipt = deps.store.db
		.query("SELECT result_json FROM tg_dm_navigation WHERE update_id = 10")
		.get();
	expect(receipt).toEqual({
		result_json: JSON.stringify({
			fromId: outgoing.id,
			toId: original.toId,
			outcome: "new",
			archivedInputs: 0,
		}),
	});
	expect(() => navigateDm(deps, command(11))).toThrow("conflicting command identity");
	expect(() => navigateDm(deps, command(10, "back"))).toThrow("conflicting command identity");
	expect(() => navigateDm(deps, { ...command(10), chatId: 43 })).toThrow(
		"conflicting command identity",
	);
	navigateDm(deps, command(20));
	deps.store.close();
	const store = openStore(deps.file);
	const stopped: string[] = [];
	const reopened = {
		store,
		runtime: runtimeEdge(store, stopped),
		inbox: openTelegramInbox(store.db),
	};
	const duplicate = navigateDm(reopened, command(10));
	expect(duplicate.toId).toBe(original.toId);
	expect(duplicate.conv?.id ?? null).toBe(original.toId); // candidate, not today's pin
	expect(store.currentDm(42)?.id).toBe("dm:42:3");
	expect(duplicate).toMatchObject({ stopped: false, reviewsCancelled: 0 });
	expect(stopped).toEqual([]);
	store.close();
});

test("a command receipt failure rolls pin, assignments and fence back without cancellation", () => {
	const deps = fixture();
	navigateDm(deps, command(10)); // initialize receipt tables
	const first = deps.store.currentDm(42)!;
	record(deps, 11);
	deps.store.db.run(`CREATE TRIGGER fail_navigation BEFORE INSERT ON tg_dm_navigation
		BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
	expect(() => navigateDm(deps, command(20))).toThrow("receipt failed");
	expect(deps.store.currentDm(42)?.id).toBe(first.id);
	expect(deps.store.get(first.id)?.epoch).toBe(first.epoch);
	expect(deps.store.get("dm:42:2")).toBeNull();
	expect(deps.inbox.archivedTarget(11, "dm:42")).toBeNull();
	expect(deps.stopped).toEqual([]);
	deps.store.db.run("DROP TRIGGER fail_navigation");
	expect(navigateDm(deps, command(20)).duplicate).toBe(false);
	deps.store.close();
});

test("back walks predecessors, new branches from the selection, and earliest back changes nothing", () => {
	const deps = fixture();
	const first = navigateDm(deps, command(10));
	const second = navigateDm(deps, command(20));
	const third = navigateDm(deps, command(30));
	record(deps, 31);
	const back = navigateDm(deps, command(40, "back"));
	expect(back).toMatchObject({
		fromId: third.toId,
		toId: second.toId,
		outcome: "back",
		archivedInputs: 1,
	});
	const fourth = navigateDm(deps, command(50));
	expect(fourth.toId).toBe("dm:42:4");
	expect(navigateDm(deps, command(60, "back")).toId).toBe(second.toId);
	expect(navigateDm(deps, command(70, "back")).toId).toBe(first.toId);
	record(deps, 71);
	const epoch = deps.store.get(first.toId!)?.epoch;
	const count = deps.stopped.length;
	const noPrevious = navigateDm(deps, command(80, "back"));
	expect(noPrevious).toMatchObject({
		fromId: first.toId,
		toId: null,
		conv: null,
		outcome: "no_previous",
		stopped: false,
		archivedInputs: 0,
	});
	expect(deps.store.get(first.toId!)?.epoch).toBe(epoch);
	expect(deps.stopped).toHaveLength(count);
	expect(deps.inbox.archivedTarget(71, "dm:42")).toBeNull();
	expect(deps.inbox.archivedTarget(31, "dm:42")).toBe(third.toId);
	expect(navigateDm(deps, command(80, "back"))).toMatchObject({
		duplicate: true,
		stopped: false,
		reviewsCancelled: 0,
	});
	expect(deps.store.get(first.toId!)?.epoch).toBe(epoch);
	expect(deps.stopped).toHaveLength(count);
	deps.store.close();
});

test("back before any conversation does not create or archive anything, and its no-op is durable", () => {
	const deps = fixture();
	record(deps, 1);
	const noPrevious = navigateDm(deps, command(10, "back"));
	expect(noPrevious).toMatchObject({
		fromId: null,
		toId: null,
		conv: null,
		outcome: "no_previous",
		stopped: false,
		archivedInputs: 0,
	});
	expect(deps.store.currentDm(42)).toBeNull();
	expect(deps.inbox.archivedTarget(1, "dm:42")).toBeNull();
	navigateDm(deps, command(20));
	expect(navigateDm(deps, command(10, "back"))).toMatchObject({ ...noPrevious, duplicate: true });
	deps.store.close();
});

test("manual navigation rejects non-DM addresses and invalid Telegram identifiers", () => {
	const deps = fixture();
	expect(() => navigateDm(deps, { ...command(1), chatId: -42 })).toThrow();
	expect(() => navigateDm(deps, { ...command(1), updateId: -1 })).toThrow();
	expect(() => navigateDm(deps, { ...command(1), messageId: 0 })).toThrow();
	expect(deps.store.currentDm(42)).toBeNull();
	deps.store.close();
});

test("malformed or cross-chat persisted command outcomes fail loudly rather than navigating", () => {
	const deps = fixture();
	const original = navigateDm(deps, command(10));
	deps.store.db.run("UPDATE tg_dm_navigation SET result_json = ? WHERE update_id = 10", [
		"{broken",
	]);
	expect(() => navigateDm(deps, command(10))).toThrow();
	deps.store.db.run("UPDATE tg_dm_navigation SET result_json = ? WHERE update_id = 10", [
		JSON.stringify({
			fromId: original.fromId,
			toId: "dm:43:1",
			outcome: "new",
			archivedInputs: 0,
		}),
	]);
	expect(() => navigateDm(deps, command(10))).toThrow("mismatched conversation");
	expect(deps.store.currentDm(42)?.id ?? null).toBe(original.toId);
	expect(deps.stopped).toEqual([]);
	deps.store.close();
});

// Hold the external model call, not the runtime: a rolled-back command must
// leave the actual provider signal and the running turn entirely untouched.
function heldTurn(deps: ReturnType<typeof fixture>) {
	const started = Promise.withResolvers<AbortSignal>();
	const held = Promise.withResolvers<void>();
	let calls = 0;
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "navigation-test",
		supportedUrls: {},
		doGenerate() {
			throw new Error("unused");
		},
		async doStream(options) {
			calls++;
			if (!options.abortSignal) throw new Error("runtime did not supply an abort signal");
			started.resolve(options.abortSignal);
			await held.promise;
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "answer" });
						controller.enqueue({ type: "text-delta", id: "answer", delta: "Completed normally" });
						controller.enqueue({ type: "text-end", id: "answer" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: 1, text: undefined, reasoning: undefined },
							},
						});
						controller.close();
					},
				}),
			};
		},
	};
	const runtime = new Runtime({
		store: deps.store,
		buildStep: () => ({ model, system: "test" }),
		makeTools: () => ({}),
	});
	const completed = Promise.withResolvers<TurnDone>();
	let text = "";
	const sink: TurnSink = {
		onTextDelta(delta) {
			text += delta;
		},
		onReasoningDelta() {},
		onToolCall() {},
		onDone(done) {
			completed.resolve(done);
		},
	};
	const conv = deps.store.currentDm(42)!;
	runtime.submit(conv, userMessage([{ type: "text", text: "original question" }]), sink);
	return {
		runtime,
		started: started.promise,
		release: () => held.resolve(),
		done: completed.promise,
		text: () => text,
		calls: () => calls,
		conv,
	};
}

test("receipt failure leaves a real held Runtime provider un-aborted and able to complete", async () => {
	const deps = fixture();
	navigateDm(deps, command(10)); // initialize tables without an outgoing turn
	record(deps, 11);
	const turn = heldTurn(deps);
	try {
		const signal = await turn.started;
		deps.store.db.run(`CREATE TRIGGER fail_navigation BEFORE INSERT ON tg_dm_navigation
			BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
		expect(() => navigateDm({ ...deps, runtime: turn.runtime }, command(20))).toThrow(
			"receipt failed",
		);
		expect(signal.aborted).toBe(false);
		expect(deps.store.get(turn.conv.id)?.epoch).toBe(turn.conv.epoch);
		expect(deps.store.currentDm(42)?.id).toBe(turn.conv.id);
		expect(deps.store.get("dm:42:2")).toBeNull();
		expect(deps.inbox.archivedTarget(11, "dm:42")).toBeNull();
		turn.release();
		expect(await turn.done).toEqual({ kind: "completed" });
		expect(turn.text()).toBe("Completed normally");
		expect(turn.calls()).toBe(1);
		expect(deps.store.history(turn.conv.id).map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		while (turn.runtime.busy(turn.conv.id)) await Bun.sleep(1);
	} finally {
		turn.release();
		await turn.runtime.shutdown();
		deps.store.close();
	}
});

test("successful navigation cancels a real Runtime at the committed fence without cancellation replay", async () => {
	const deps = fixture();
	navigateDm(deps, command(10));
	const turn = heldTurn(deps);
	try {
		const signal = await turn.started;
		const result = navigateDm({ ...deps, runtime: turn.runtime }, command(20));
		expect(result).toMatchObject({
			fromId: turn.conv.id,
			toId: "dm:42:2",
			stopped: true,
			reviewsCancelled: 0,
		});
		expect(signal.aborted).toBe(true);
		expect(deps.store.get(turn.conv.id)?.epoch).toBe(turn.conv.epoch + 1);
		expect(navigateDm({ ...deps, runtime: turn.runtime }, command(20))).toMatchObject({
			toId: result.toId,
			duplicate: true,
			stopped: false,
			reviewsCancelled: 0,
		});
		expect(deps.store.get(turn.conv.id)?.epoch).toBe(turn.conv.epoch + 1);
		turn.release();
		expect(await turn.done).toEqual({ kind: "fenced" });
		expect(turn.text()).toBe("");
		expect(turn.calls()).toBe(1);
		expect(deps.store.history(turn.conv.id).map((message) => message.role)).toEqual(["user"]);
		expect(deps.store.history(result.toId!)).toEqual([]);
		while (turn.runtime.busy(turn.conv.id)) await Bun.sleep(1);
	} finally {
		turn.release();
		await turn.runtime.shutdown();
		deps.store.close();
	}
});
