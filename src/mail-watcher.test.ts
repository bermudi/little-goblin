// The mail watcher's contract: new filters baseline without firing,
// matches fire once per tick batched through the one firing path, the
// cursor always advances, outages notice once per episode, and the
// same tick sweeps expired drafts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryExpiredError, type MailHit, type MailReader } from "./mail.ts";
import { openOutbox, OUTBOX_TTL_MS, type OutboxStore } from "./mail-outbox.ts";
import { formatMailEvent, startMailWatcher, type MailWatcher } from "./mail-watcher.ts";
import { openPrograms, type Program, type ProgramsStore } from "./programs.ts";

let dirs: string[] = [];
let watchers: MailWatcher[] = [];
afterEach(() => {
	for (const w of watchers) w.stop();
	watchers = [];
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const NOW = new Date("2026-09-26T10:00:00.000Z");
const ADDRESS = { chatId: -100, threadId: 7 };

function hit(id: string): MailHit {
	return { id, threadId: "t", from: "a@x.com", subject: `sub-${id}`, date: "today", snippet: `snip-${id}` };
}

interface Harness {
	programs: ProgramsStore;
	outbox: OutboxStore;
	fired: Array<{ program: number; event: string }>;
	notices: Array<{ chat: number; text: string }>;
	stamps: Array<{ message: number; text: string }>;
	polls: Array<{ filter: string; cursor: string }>;
	profiles: number;
	pollImpl: (filter: string, cursor: string) => Promise<{ hits: MailHit[]; historyId: string }>;
	reader: MailReader | null;
}

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "goblin-mailwatch-"));
	dirs.push(dir);
	const db = join(dir, "goblin.sqlite");
	const h: Harness = {
		programs: openPrograms(db),
		outbox: openOutbox(db),
		fired: [],
		notices: [],
		stamps: [],
		polls: [],
		profiles: 0,
		pollImpl: async () => ({ hits: [], historyId: "1" }),
		reader: null,
	};
	h.reader = {
		search: async () => [],
		read: async () => { throw new Error("unreachable"); },
		attachment: async () => new Uint8Array(),
		poll: async (filter, cursor) => {
			h.polls.push({ filter, cursor });
			return h.pollImpl(filter, cursor);
		},
		profileHistoryId: async () => {
			h.profiles++;
			return "100";
		},
	};
	return h;
}

function start(h: Harness): MailWatcher {
	const w = startMailWatcher(
		{
			programs: h.programs,
			outbox: h.outbox,
			reader: () => h.reader,
			fire: (program: Program, event: string) => {
				h.fired.push({ program: program.id, event });
				return true;
			},
			notify: async (address, text) => {
				h.notices.push({ chat: address.chatId, text });
			},
			stampDraft: async (_address, messageId, text) => {
				h.stamps.push({ message: messageId, text });
			},
			now: () => NOW,
		},
		60_000,
	);
	watchers.push(w);
	return w;
}

function mailProgram(h: Harness, name = "bank watch", filter = "from:bank"): Program {
	return h.programs.create(
		{ name, charter: "flag bank mail", mailFilter: filter, address: ADDRESS },
		NOW,
	);
}

describe("formatMailEvent", () => {
	test("one block per match — body stays one read away", () => {
		const event = formatMailEvent([hit("m1"), hit("m2")]);
		expect(event).toContain("subject: sub-m1");
		expect(event).toContain("id: m1");
		expect(event).toContain("id: m2");
		expect(event).toContain("---");
		expect(event).not.toContain("hello body");
	});
});

describe("mail watcher", () => {
	test("a new filter baselines at the head — the backlog never fires", async () => {
		const h = harness();
		const p = mailProgram(h);
		const w = start(h);
		await w.tick();
		expect(h.profiles).toBe(1);
		expect(h.polls).toHaveLength(0);
		expect(h.fired).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("100");
	});

	test("matches fire once, batched, and the cursor advances", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100");
		h.pollImpl = async () => ({ hits: [hit("m1"), hit("m2")], historyId: "120" });
		const w = start(h);
		await w.tick();
		expect(h.polls).toEqual([{ filter: "from:bank", cursor: "100" }]);
		expect(h.fired).toHaveLength(1);
		expect(h.fired[0]!.program).toBe(p.id);
		expect(h.fired[0]!.event).toContain("id: m1");
		expect(h.fired[0]!.event).toContain("id: m2");
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("120");
		expect(h.programs.get(p.id)!.lastRun).toBe(NOW.toISOString());
	});

	test("an empty poll advances the cursor without firing", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100");
		h.pollImpl = async () => ({ hits: [], historyId: "110" });
		const w = start(h);
		await w.tick();
		expect(h.fired).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("110");
	});

	test("an expired cursor re-baselines instead of failing", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "1");
		h.pollImpl = async () => { throw new HistoryExpiredError(); };
		const w = start(h);
		await w.tick();
		expect(h.fired).toHaveLength(0);
		expect(h.notices).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("100");
	});

	test("a failing check notices once per episode, then recovers silently", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100");
		h.pollImpl = async () => { throw new Error("gmail: HTTP 500"); };
		const w = start(h);
		await w.tick();
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]!.text).toContain('"bank watch" is failing');
		// Second tick, same error — silent.
		await w.tick();
		expect(h.notices).toHaveLength(1);
		// A changed error re-warns.
		h.pollImpl = async () => { throw new Error("gmail: HTTP 403"); };
		await w.tick();
		expect(h.notices).toHaveLength(2);
		// Success clears the episode — the next failure warns again.
		h.pollImpl = async () => ({ hits: [], historyId: "130" });
		await w.tick();
		expect(h.notices).toHaveLength(2);
		h.pollImpl = async () => { throw new Error("gmail: HTTP 500"); };
		await w.tick();
		expect(h.notices).toHaveLength(3);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("130");
	});

	test("one failing program doesn't stop the others", async () => {
		const h = harness();
		const bad = mailProgram(h, "bad", "from:bad");
		const good = mailProgram(h, "good", "from:good");
		h.programs.setMailHistory(bad.id, "100");
		h.programs.setMailHistory(good.id, "100");
		h.pollImpl = async (filter) => {
			if (filter === "from:bad") throw new Error("gmail: HTTP 500");
			return { hits: [hit("m1")], historyId: "120" };
		};
		const w = start(h);
		await w.tick();
		expect(h.fired.map((f) => f.program)).toEqual([good.id]);
		expect(h.notices).toHaveLength(1);
	});

	test("unconfigured mail idles — no polls, no fires, sweep still runs", async () => {
		const h = harness();
		h.reader = null;
		mailProgram(h);
		const row = h.outbox.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		h.outbox.bindDraft(row.id, 555);
		const w = start(h);
		await w.tick();
		expect(h.polls).toHaveLength(0);
		expect(h.fired).toHaveLength(0);
		expect(h.outbox.get(row.id)!.status).toBe("expired");
		expect(h.stamps).toEqual([{ message: 555, text: expect.stringContaining("expired") }]);
	});

	test("the sweep stamps expired drafts and leaves the rest", async () => {
		const h = harness();
		const old = h.outbox.queue(
			{ to: ["a@x.com"], subject: "h", body: "b", address: ADDRESS },
			new Date(NOW.getTime() - OUTBOX_TTL_MS - 1000),
		);
		h.outbox.bindDraft(old.id, 555);
		const fresh = h.outbox.queue({ to: ["b@y.com"], subject: "h", body: "b", address: ADDRESS }, NOW);
		const w = start(h);
		await w.tick();
		expect(h.outbox.get(old.id)!.status).toBe("expired");
		expect(h.outbox.get(fresh.id)!.status).toBe("pending");
		expect(h.stamps).toHaveLength(1);
	});
});
