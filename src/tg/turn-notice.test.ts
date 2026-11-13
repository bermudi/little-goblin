import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { openStore, type ConversationStore } from "../conversation.ts";
import { appAddress } from "../conversation-address.ts";
import { setLogFile } from "../log.ts";
import { programFireTag } from "../tags.ts";
import { deferred, tmpDb, tmpDir, waitUntil } from "../testkit.ts";
import { openTurnJournal, type TurnJournal } from "../turn-journal.ts";
import {
	redeliverLandedReplies,
	sendInterruptedTurnNotices,
	sendStrandedInputNotices,
} from "./turn-notice.ts";

setLogFile(null);

const OPERATORS = [111, 222];
const STARTED = "2026-10-11T00:00:00.000Z";

type Seed = {
	runId: string;
	convId: string;
	calls?: ("planned" | "dispatched" | "completed")[];
	owned?: number[];
	// Present (even null) = noteReplyLanded ran before the crash — the
	// reply seq, or null to hand-craft a pre-column landed row.
	landed?: number | null;
};

function crashBed(setup: (store: ConversationStore) => { seeds: Seed[] }): {
	store: ConversationStore;
	journal: TurnJournal;
	dbPath: string;
} {
	const dbPath = tmpDb("goblin-tn-");
	const first = openStore(dbPath);
	const { seeds } = setup(first);
	const journal = openTurnJournal(first.db);
	for (const s of seeds) {
		journal.beginRun({
			runId: s.runId,
			conversationId: s.convId,
			epoch: 1,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: {},
			toolNames: ["probe"],
			startedAt: STARTED,
			...(s.owned === undefined ? {} : { ownedInputSeqs: s.owned }),
		});
		(s.calls ?? []).forEach((state, i) => {
			const callId = `call-${i}`;
			journal.noteToolInput(s.runId, callId, "probe", { i });
			if (state === "planned") return;
			journal.noteToolDispatch(s.runId, callId, "probe", { i });
			if (state === "completed") journal.noteToolResult(s.runId, callId, { ok: true });
		});
		if (s.landed !== undefined) journal.noteReplyLanded(s.runId, s.landed);
	}
	first.close();
	const store = openStore(dbPath);
	return { store, journal: openTurnJournal(store.db), dbPath };
}

type Send = { chat: number; text: string; settle: ReturnType<typeof deferred<unknown>> };

function fakeApi(opts?: { throwOnChat?: number; autoResolve?: boolean }) {
	const sends: Send[] = [];
	const api = {
		sendMessage: (chat: number, text: string) => {
			const settle = deferred<unknown>();
			sends.push({ chat, text, settle });
			if (opts?.throwOnChat === chat) throw new Error("sync send failure");
			if (opts?.autoResolve === true) settle.resolve({ ok: true });
			return settle.promise;
		},
	} as unknown as Api;
	return { api, sends };
}

type Line = {
	msg: string;
	run: string;
	conversation: string;
	chat: number;
	started: string;
	error: unknown;
};

function logLines(path: string): Line[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Line);
}

const sent = (lines: Line[]) => lines.filter((l) => l.msg === "interrupted turn notice sent");
const failed = (lines: Line[]) =>
	lines.filter((l) => l.msg === "interrupted turn notice send failed");

describe("interrupted turn notices", () => {
	test("each at-open run notifies every operator once; text carries title, counts, resume directions", async () => {
		const dir = tmpDir("goblin-tn-log-");
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const { store, journal } = crashBed((store) => {
				const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
				store.setMeta(dm.id, { title: "ops room" });
				const app = store.resolve(appAddress("ops-app"), "/w");
				return {
					seeds: [
						{ runId: "aaaabbbb-dm", convId: dm.id, calls: ["dispatched", "completed", "planned"] },
						{ runId: "ccccdddd-app", convId: app.id },
					],
				};
			});
			expect(journal.interruptedAtOpen.map((r) => r.runId).sort()).toEqual([
				"aaaabbbb-dm",
				"ccccdddd-app",
			]);

			const { api, sends } = fakeApi();
			let bootContinued = false;
			const ret = sendInterruptedTurnNotices(
				api,
				journal.interruptedAtOpen,
				OPERATORS,
				(id) => store.get(id)?.title ?? undefined,
			);
			bootContinued = true;

			expect(ret).toBeUndefined();
			expect(bootContinued).toBe(true);
			expect(sends).toHaveLength(4);
			for (const chat of OPERATORS) {
				expect(sends.filter((s) => s.chat === chat)).toHaveLength(2);
			}

			const dmSend = sends.find((s) => s.text.includes("interrupted turn aaaabbbb"))!;
			expect(dmSend.text).toContain("ops room, started 2026-10-11T00:00:00.000Z");
			expect(dmSend.text).toContain(
				"1 completed, 1 dispatched (ambiguous), 0 decided, 1 planned tool call(s).",
			);
			expect(dmSend.text).toContain(
				"The turn was not replayed — resume explicitly with /resume aaaabbbb sent in that conversation, not in this DM.",
			);

			const appSend = sends.find((s) => s.text.includes("interrupted turn ccccdddd"))!;
			expect(appSend.text).toContain("app/ops-app, started 2026-10-11T00:00:00.000Z");
			expect(appSend.text).toContain(
				"0 completed, 0 dispatched (ambiguous), 0 decided, 0 planned tool call(s).",
			);
			expect(appSend.text).toContain(
				"The turn was not replayed — open that conversation in the app to resume it — Telegram /resume can't reach app lanes.",
			);

			expect(sent(logLines(logPath))).toHaveLength(0);
			expect(failed(logLines(logPath))).toHaveLength(0);

			sends[0]!.settle.resolve({ ok: true });
			await waitUntil(
				() => sent(logLines(logPath)).length === 1,
				"first settled send logged while the rest pend",
			);
			const first = sent(logLines(logPath))[0]!;
			expect(first.chat).toBe(sends[0]!.chat);
			expect(sends[0]!.text).toContain(`interrupted turn ${first.run.slice(0, 8)}`);
			expect(failed(logLines(logPath))).toHaveLength(0);

			sends[1]!.settle.reject(new Error("api down"));
			sends[2]!.settle.resolve({ ok: true });
			sends[3]!.settle.resolve({ ok: true });
			await waitUntil(
				() => sent(logLines(logPath)).length + failed(logLines(logPath)).length === 4,
				"all four notice sends logged",
			);

			const lines = logLines(logPath);
			expect(sent(lines)).toHaveLength(3);
			expect(failed(lines)).toHaveLength(1);
			const ok = sent(lines);
			for (const line of ok) {
				expect(OPERATORS).toContain(line.chat);
				expect(["aaaabbbb-dm", "ccccdddd-app"]).toContain(line.run);
				expect(line.conversation).toBe(line.run === "aaaabbbb-dm" ? "dm:1" : "app/ops-app");
				expect(line.started).toBe(STARTED);
			}
			const bad = failed(lines)[0]!;
			expect(bad.chat).toBe(sends[1]!.chat);
			expect(bad.run).toBe(sends[1]!.text.includes("aaaabbbb") ? "aaaabbbb-dm" : "ccccdddd-app");
			expect(bad.conversation).toBe(sends[1]!.text.includes("aaaabbbb") ? "dm:1" : "app/ops-app");
			expect(String(bad.error)).toContain("api down");
			expect(sent(lines).some((l) => l.run === bad.run && l.chat === bad.chat)).toBe(false);
			store.close();
		} finally {
			setLogFile(null);
		}
	});

	test("a later open's empty snapshot resends nothing; only its own crashes notify", async () => {
		const { store, journal, dbPath } = crashBed((store) => {
			const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			return { seeds: [{ runId: "eeeeffff-old", convId: dm.id }] };
		});
		const { api, sends } = fakeApi();
		sendInterruptedTurnNotices(api, journal.interruptedAtOpen, OPERATORS, () => undefined);
		expect(sends).toHaveLength(2);
		store.close();

		const second = openStore(dbPath);
		const journal2 = openTurnJournal(second.db);
		expect(journal2.interruptedAtOpen).toEqual([]);
		expect(journal2.interrupted().map((r) => r.runId)).toEqual(["eeeeffff-old"]);
		sendInterruptedTurnNotices(api, journal2.interruptedAtOpen, OPERATORS, () => undefined);
		expect(sends).toHaveLength(2);

		journal2.beginRun({
			runId: "99990000-new",
			conversationId: "dm:1",
			epoch: 1,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: {},
			toolNames: ["probe"],
			startedAt: STARTED,
		});
		second.close();

		const third = openStore(dbPath);
		const journal3 = openTurnJournal(third.db);
		sendInterruptedTurnNotices(api, journal3.interruptedAtOpen, OPERATORS, () => undefined);
		expect(sends).toHaveLength(4);
		const fresh = sends.slice(2);
		expect(fresh.every((s) => s.text.includes("interrupted turn 99990000"))).toBe(true);
		expect(fresh.map((s) => s.chat).sort()).toEqual([...OPERATORS].sort());
		expect(
			journal3
				.interrupted()
				.map((r) => r.runId)
				.sort(),
		).toEqual(["99990000-new", "eeeeffff-old"]);
		for (const s of sends) s.settle.resolve({ ok: true });
		await Promise.all(sends.map((s) => s.settle.promise));
		third.close();
	});

	test("all sends failing logs one failure per recipient and no success", async () => {
		const dir = tmpDir("goblin-tn-log-");
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const { store, journal } = crashBed((store) => {
				const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
				return { seeds: [{ runId: "deadbeef-run", convId: dm.id }] };
			});
			const { api, sends } = fakeApi();
			sendInterruptedTurnNotices(api, journal.interruptedAtOpen, OPERATORS, () => undefined);
			expect(sends).toHaveLength(2);
			for (const s of sends) s.settle.reject(new Error("all down"));
			await waitUntil(() => failed(logLines(logPath)).length === 2, "both failed sends logged");

			const lines = logLines(logPath);
			expect(sent(lines)).toHaveLength(0);
			expect(
				failed(lines)
					.map((l) => l.chat)
					.sort(),
			).toEqual([...OPERATORS].sort());
			for (const l of failed(lines)) {
				expect(l.run).toBe("deadbeef-run");
				expect(l.conversation).toBe("dm:1");
				expect(String(l.error)).toContain("all down");
			}
			store.close();
		} finally {
			setLogFile(null);
		}
	});

	test("a synchronous sendMessage throw is isolated — other recipients are still attempted", async () => {
		const dir = tmpDir("goblin-tn-log-");
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const { store, journal } = crashBed((store) => {
				const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
				return { seeds: [{ runId: "cafef00d-run", convId: dm.id }] };
			});
			const { api, sends } = fakeApi({ throwOnChat: 222 });
			sendInterruptedTurnNotices(api, journal.interruptedAtOpen, OPERATORS, () => undefined);
			expect(sends).toHaveLength(2);
			for (const s of sends) {
				if (s.chat === 222) continue;
				s.settle.resolve({ ok: true });
			}
			await waitUntil(
				() => sent(logLines(logPath)).length + failed(logLines(logPath)).length === 2,
				"both send outcomes logged",
			);

			const lines = logLines(logPath);
			expect(sent(lines)).toHaveLength(1);
			expect(sent(lines)[0]!.chat).toBe(111);
			expect(failed(lines)).toHaveLength(1);
			expect(failed(lines)[0]!.chat).toBe(222);
			expect(failed(lines)[0]!.run).toBe("cafef00d-run");
			expect(String(failed(lines)[0]!.error)).toContain("sync send failure");
			store.close();
		} finally {
			setLogFile(null);
		}
	});
});

describe("stranded input notices", () => {
	test("counts only user events no run admitted and no reply answered; one line per conversation", async () => {
		const dir = tmpDir("goblin-tn-log-");
		const logPath = join(dir, "goblin.log");
		setLogFile(logPath);
		try {
			const { store, journal } = crashBed((store) => {
				const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
				store.setMeta(dm.id, { title: "ops room" });
				const other = store.resolve({ kind: "dm", chatId: 2 }, "/w");
				const quiet = store.resolve({ kind: "dm", chatId: 3 }, "/w");
				const app = store.resolve(appAddress("ops-app"), "/w");
				const user = (text: string, metadata?: UIMessage["metadata"]): UIMessage => ({
					id: crypto.randomUUID(),
					role: "user",
					parts: [{ type: "text", text }],
					...(metadata === undefined ? {} : { metadata }),
				});
				// Answered input an interrupted run owned — not stranded.
				const [asked] = store.append(dm.id, [user("earlier question")]);
				store.append(dm.id, [
					{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] },
				]);
				// Fenced input: landed after the run's owned floor.
				store.append(dm.id, [user("did this land?")]);
				// Machinery speech and a generated resume marker never count.
				store.append(dm.id, [user(`${programFireTag("nightly", "cron")}\ncharter`)]);
				store.append(dm.id, [
					user("resume please", { goblinResume: { sourceRunId: "aaaabbbb-dm" } }),
				]);
				store.append(other.id, [user("one"), user("two")]);
				// A user event an assistant reply already answered.
				store.append(quiet.id, [user("q")]);
				store.append(quiet.id, [
					{ id: "a2", role: "assistant", parts: [{ type: "text", text: "a" }] },
				]);
				store.append(app.id, [user("app input")]);
				return { seeds: [{ runId: "aaaabbbb-dm", convId: dm.id, owned: [asked!] }] };
			});

			expect(journal.strandedAtOpen.get("dm:1")).toBe(1);
			expect(journal.strandedAtOpen.get("dm:2")).toBe(2);
			expect(journal.strandedAtOpen.has("dm:3")).toBe(false);
			expect(journal.strandedAtOpen.get("app/ops-app")).toBe(1);
			// Post-open input belongs to the live runtime — the snapshot
			// never picks it up.
			store.append("dm:1", [
				{ id: "b1", role: "user", parts: [{ type: "text", text: "new input after boot" }] },
			]);
			expect(journal.strandedAtOpen.get("dm:1")).toBe(1);

			const { api, sends } = fakeApi();
			const ret = sendStrandedInputNotices(
				api,
				journal.strandedAtOpen,
				OPERATORS,
				(id) => store.get(id)?.title ?? undefined,
			);
			expect(ret).toBeUndefined();
			expect(sends).toHaveLength(6);
			for (const chat of OPERATORS) {
				expect(sends.filter((s) => s.chat === chat)).toHaveLength(3);
			}
			const dm1 = sends.find((s) => s.text.startsWith("ops room:"))!;
			expect(dm1.text).toBe(
				"ops room: 1 message(s) you sent before the restart " +
					"weren't answered — send /resume or reply to continue",
			);
			const dm2 = sends.find((s) => s.text.startsWith("dm:2:"))!;
			expect(dm2.text).toBe(
				"dm:2: 2 message(s) you sent before the restart " +
					"weren't answered — send /resume or reply to continue",
			);
			const appSend = sends.find((s) => s.text.startsWith("app/ops-app:"))!;
			expect(appSend.text).toContain(
				"1 message(s) you sent before the restart weren't answered",
			);
			expect(appSend.text).toContain("open that conversation in the app to continue");

			for (const s of sends) s.settle.resolve({ ok: true });
			const strandedSent = (lines: Line[]) =>
				lines.filter((l) => l.msg === "stranded input notice sent");
			await waitUntil(
				() => strandedSent(logLines(logPath)).length === 6,
				"all stranded sends logged",
			);
			store.close();
		} finally {
			setLogFile(null);
		}
	});
});

describe("landed reply re-delivery", () => {
	test("re-delivers the landed reply to its own chat, marks it delivered, and skips its notice", async () => {
		const { store, journal } = crashBed((store) => {
			const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			const app = store.resolve(appAddress("ops-app"), "/w");
			const legacy = store.resolve({ kind: "dm", chatId: 9 }, "/w");
			store.append(dm.id, [
				{ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] },
			]);
			const [replySeq] = store.append(dm.id, [
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", text: "the reply that never sent" }],
				},
			]);
			store.append(app.id, [
				{ id: "a2", role: "assistant", parts: [{ type: "text", text: "app reply" }] },
			]);
			return {
				seeds: [
					{ runId: "aaaabbbb-dm", convId: dm.id, landed: replySeq! },
					{ runId: "ccccdddd-app", convId: app.id, landed: 1 },
					{ runId: "eeeeffff-legacy", convId: legacy.id, landed: null },
					{ runId: "99990000-plain", convId: dm.id },
				],
			};
		});

		expect(
			journal
				.landedPendingReplies()
				.map((r) => r.runId)
				.sort(),
		).toEqual(["aaaabbbb-dm", "ccccdddd-app", "eeeeffff-legacy"]);

		const { api, sends } = fakeApi({ autoResolve: true });
		const delivered = await redeliverLandedReplies(
			api,
			journal.landedPendingReplies(),
			store,
			journal,
		);
		expect(delivered).toEqual(new Set(["aaaabbbb-dm", "ccccdddd-app"]));

		// The dm reply went to the conversation's own chat, exactly once —
		// not to operators, not duplicated.
		expect(sends).toHaveLength(1);
		expect(sends[0]!.chat).toBe(1);
		expect(sends[0]!.text).toBe("the reply that never sent");
		sends[0]!.settle.resolve({ ok: true });
		expect(journal.get("aaaabbbb-dm")!.delivery).toBe("delivered");
		expect(journal.get("ccccdddd-app")!.delivery).toBe("delivered");
		expect(journal.get("eeeeffff-legacy")!.delivery).toBe("pending");

		// Notices go only to rows still owed one: the delivered rows are
		// out, the legacy and plain interrupted rows stay in.
		sendInterruptedTurnNotices(
			api,
			journal.interruptedAtOpen.filter((r) => !delivered.has(r.runId)),
			OPERATORS,
			() => undefined,
		);
		const notices = sends.filter((s) => s.text.includes("interrupted turn"));
		expect(notices).toHaveLength(4);
		expect(notices.some((s) => s.text.includes("aaaabbbb"))).toBe(false);
		expect(notices.some((s) => s.text.includes("ccccdddd"))).toBe(false);
		expect(notices.filter((s) => s.text.includes("eeeeffff"))).toHaveLength(2);
		expect(notices.filter((s) => s.text.includes("99990000"))).toHaveLength(2);

		// A second pass sends nothing and marks nothing — delivered rows
		// dropped out of the pending set.
		expect(
			await redeliverLandedReplies(api, journal.landedPendingReplies(), store, journal),
		).toEqual(new Set());
		expect(journal.landedPendingReplies().map((r) => r.runId)).toEqual([
			"eeeeffff-legacy",
		]);
		for (const s of sends) s.settle.resolve({ ok: true });
		await Promise.allSettled(sends.map((s) => s.settle.promise));
		store.close();
	});

	test("a failed re-delivery stays pending and keeps its interrupted notice", async () => {
		const { store, journal } = crashBed((store) => {
			const dm = store.resolve({ kind: "dm", chatId: 1 }, "/w");
			const [replySeq] = store.append(dm.id, [
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", text: "undelivered reply" }],
				},
			]);
			return { seeds: [{ runId: "aaaabbbb-dm", convId: dm.id, landed: replySeq! }] };
		});

		const { api, sends } = fakeApi();
		const pending = redeliverLandedReplies(
			api,
			journal.landedPendingReplies(),
			store,
			journal,
		);
		sends[0]!.settle.reject(new Error("telegram down"));
		expect(await pending).toEqual(new Set());
		expect(journal.get("aaaabbbb-dm")!.delivery).toBe("pending");

		sendInterruptedTurnNotices(api, journal.interruptedAtOpen, OPERATORS, () => undefined);
		expect(
			sends.filter((s) => s.text.includes("interrupted turn aaaabbbb")),
		).toHaveLength(2);
		for (const s of sends) {
			if (s.text.includes("interrupted turn")) s.settle.resolve({ ok: true });
		}
		await Promise.allSettled(sends.map((s) => s.settle.promise));
		store.close();
	});
});
