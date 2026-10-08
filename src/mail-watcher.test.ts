// The mail watcher's contract: new filters baseline without firing,
// one tick's matches become one turn, the checkpoint follows fired
// records (held on a fire that does not land), and outages notice
// once per episode. The boundary is real on both sides: a fake gws
// poller at one edge, the real fireMail entry point over a fake
// runtime.submit at the other — everything between is production
// code. (Draft expiry is the approval gate's — its tests cover the
// sweep.)

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryApi } from "./tg/delivery.ts";
import type { UIMessage } from "ai";
import { HistoryExpiredError, type MailHit, type MailPoller } from "./mail.ts";
import { JevError } from "./jev.ts";
import { setLogFile, setLogWriter } from "./log.ts";
import { startMailWatcher, type MailWatcher } from "./mail-watcher.ts";
import { fireMail, type SchedulerDeps } from "./scheduler.ts";
import { openPrograms, type Program, type ProgramsStore } from "./programs.ts";
import { openStore } from "./conversation.ts";
import type { Runtime, TurnSink } from "./runtime.ts";
import type { Config } from "./config.ts";

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

const config: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
	},
	model: "zai/m",
	tts: false,
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: { dmGapMinutes: 45 },
	http: { port: 8787 },
	logLevel: "info",
};

function hit(id: string): MailHit {
	return {
		id,
		threadId: "t",
		from: "a@x.com",
		subject: `sub-${id}`,
		date: "today",
		snippet: `snip-${id}`,
	};
}

interface Harness {
	path: string;
	programs: ProgramsStore;
	/** The shared gate the firing entry point scores events through —
	 *  assigned per test the way index.ts wires jevGate into checkMail. */
	checkMail?: Pick<{ decide: (...args: unknown[]) => Promise<unknown> }, "decide">;
	/** The handoff record: every fireMail call, before it runs. */
	fired: Array<{ program: number; matches: string[] }>;
	submitted: Array<{ conv: string; text: string; sink: TurnSink }>;
	notices: Array<{ chat: number; text: string }>;
	polls: Array<{ filter: string; cursor: string }>;
	profiles: number;
	/** What the fake runtime does: true → submit throws, no turn lands. */
	failSubmit: boolean;
	pollImpl: (filter: string, cursor: string) => Promise<{ hits: MailHit[]; historyId: string }>;
	reader: MailPoller | null;
	/** The real entry point over the fake runtime — the seam index.ts binds. */
	fireMail(program: Program, hits: MailHit[], checkpoint: string, now: Date): Promise<void>;
}

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "goblin-mailwatch-"));
	dirs.push(dir);
	const path = join(dir, "goblin.sqlite");
	const h: Harness = {
		path,
		programs: openPrograms(path),
		fired: [],
		submitted: [],
		notices: [],
		polls: [],
		profiles: 0,
		failSubmit: false,
		pollImpl: async () => ({ hits: [], historyId: "1" }),
		reader: null,
		// Replaced at the end of harness() once firingDeps exists.
		fireMail: () => {
			throw new Error("harness incomplete");
		},
	};
	h.reader = {
		poll: async (filter: string, cursor: string) => {
			h.polls.push({ filter, cursor });
			return h.pollImpl(filter, cursor);
		},
		profileHistoryId: async () => {
			h.profiles++;
			return "100";
		},
		threadFor: async () => null,
	};
	const store = openStore(join(dir, "conv.sqlite"));
	const api = {
		sendMessage: () => Promise.resolve({ message_id: 1 }),
		editMessageText: () => Promise.resolve(true),
		setMessageReaction: () => Promise.resolve(true),
		sendChatAction: () => Promise.resolve(true),
		sendVoice: () => Promise.resolve({ message_id: 1 }),
	} as unknown as DeliveryApi;
	const runtime = {
		submit: (conv: { id: string }, message: UIMessage, sink: TurnSink) => {
			if (h.failSubmit) throw new Error("queue closed");
			const part = message.parts[0] as { text?: string } | undefined;
			h.submitted.push({ conv: conv.id, text: part?.text ?? "", sink });
			return true;
		},
		busy: () => false,
	} as unknown as Runtime;
	const firingDeps: SchedulerDeps & { checkMail?: Harness["checkMail"] } = {
		programs: h.programs,
		store,
		runtime,
		api,
		configRef: { current: config, ttsDown: false },
		synthesize: () => Promise.resolve([]),
		// Rolling DM wiring — a private-chat fire rolls like intake does.
		roll: { store, runtime, gapMinutes: () => config.telegram.dmGapMinutes },
		// Fires never take the app path — wired because WakeDeps requires it.
		bell: () => ({
			onTextDelta: () => {},
			onReasoningDelta: () => {},
			onToolCall: () => {},
			onDone: () => {},
		}),
	};
	h.fireMail = (program, hits, checkpoint, now) =>
		fireMail(firingDeps, program, hits, checkpoint, now);
	// The test's gate handle rides the same object the entry point
	// reads — assigning h.checkMail lands in firingDeps.checkMail.
	Object.defineProperty(h, "checkMail", {
		get: () => firingDeps.checkMail,
		set: (v) => {
			firingDeps.checkMail = v;
		},
		configurable: true,
	});
	return h as Harness;
}

function start(h: Harness): MailWatcher {
	const w = startMailWatcher(
		{
			programs: h.programs,
			reader: () => h.reader,
			fire: async (program, hits, checkpoint, now) => {
				h.fired.push({ program: program.id, matches: hits.map((x) => x.id) });
				await h.fireMail(program, hits, checkpoint, now);
			},
			notify: async (address, text) => {
				h.notices.push({ chat: address.chatId, text });
			},
			now: () => NOW,
		},
		60_000,
	);
	watchers.push(w);
	return w;
}

// Close every sink the fake runtime captured — they run typing
// intervals until onDone.
function closeSinks(h: Harness): Promise<unknown> {
	return Promise.all(h.submitted.map((s) => s.sink.onDone({ kind: "completed" })));
}

function mailProgram(h: Harness, name = "bank watch", filter = "from:bank"): Program {
	return h.programs.create(
		{ name, charter: "flag bank mail", mailFilter: filter, address: ADDRESS },
		NOW,
	);
}

describe("mail watcher", () => {
	test("a new filter baselines at the head — the backlog never fires", async () => {
		const h = harness();
		const p = mailProgram(h);
		const w = start(h);
		await w.tick();
		expect(h.profiles).toBe(1);
		expect(h.polls).toHaveLength(0);
		expect(h.fired).toHaveLength(0);
		expect(h.submitted).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("100");
	});

	test("an edit while a new filter baselines cannot inherit its stale head", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.reader!.profileHistoryId = async () => {
			h.programs.update(p.id, { mailFilter: "from:new" });
			return "120";
		};
		const w = start(h);
		await w.tick();
		expect(h.programs.get(p.id)?.mailFilter).toBe("from:new");
		expect(h.programs.get(p.id)?.mailHistoryId).toBeNull();
	});

	for (const expired of [false, true]) {
		test(`${expired ? "expired cursor" : "new filter"} baseline rejects disable/re-enable ABA across connections`, async () => {
			const h = harness();
			const p = mailProgram(h);
			if (expired) {
				h.programs.setMailHistory(p.id, "old", 0);
				h.pollImpl = async () => {
					throw new HistoryExpiredError();
				};
			}
			h.reader!.profileHistoryId = async () => {
				// The same filter and null cursor return before the Gmail await
				// resolves. A snapshot re-read cannot distinguish this row.
				const other = openPrograms(h.path);
				try {
					other.update(p.id, { enabled: false });
					other.update(p.id, { enabled: true });
				} finally {
					other.close();
				}
				return "stale-head";
			};
			const w = start(h);
			await w.tick();
			const after = h.programs.get(p.id)!;
			expect(after.enabled).toBe(true);
			expect(after.mailFilter).toBe(p.mailFilter);
			expect(after.mailHistoryId).toBeNull();
			expect(after.mailRevision).toBe(p.mailRevision + 1);
		});
	}

	test("an edit while an expired cursor re-baselines cannot inherit its stale head", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "old", 0);
		h.pollImpl = async () => {
			throw new HistoryExpiredError();
		};
		h.reader!.profileHistoryId = async () => {
			h.programs.update(p.id, { mailFilter: "from:new" });
			return "120";
		};
		const w = start(h);
		await w.tick();
		expect(h.programs.get(p.id)?.mailHistoryId).toBeNull();
	});

	test("matches fire once, batched, and the cursor advances", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => ({ hits: [hit("m1"), hit("m2")], historyId: "120" });
		const w = start(h);
		await w.tick();
		expect(h.polls).toEqual([{ filter: "from:bank", cursor: "100" }]);
		expect(h.fired).toHaveLength(1);
		expect(h.fired[0]!.program).toBe(p.id);
		expect(h.fired[0]!.matches).toEqual(["m1", "m2"]);
		expect(h.submitted).toHaveLength(1);
		expect(h.submitted[0]!.text).toContain("[program: bank watch · trigger: mail]");
		expect(h.submitted[0]!.text).toContain("id: m1");
		expect(h.submitted[0]!.text).toContain("id: m2");
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("120");
		expect(h.programs.get(p.id)!.lastRun).toBe(NOW.toISOString());
		await closeSinks(h);
	});

	test("a fired event carries the injection verdict line — outage still fires, marked unavailable", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => ({ hits: [hit("m1")], historyId: "120" });
		// The shared gate, wired the way index.ts wires jevGate into
		// firingDeps.checkMail: a scripted clean verdict first.
		h.checkMail = {
			decide: async () => ({
				answers: { injection: 0.02, severity: 0.01 },
				inputTokens: null,
				cost: null,
			}),
		};
		const w = start(h);
		await w.tick();
		expect(h.submitted).toHaveLength(1);
		expect(h.submitted[0]!.text).toContain("[injection check: clean p=0.02 sev=0.01]");
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("120");
		await closeSinks(h);

		// A checker outage fails open: the fire still lands, annotated.
		h.submitted.length = 0;
		h.checkMail = {
			decide: async () => {
				throw new JevError("timeout");
			},
		};
		h.pollImpl = async () => ({ hits: [hit("m2")], historyId: "130" });
		await w.tick();
		expect(h.submitted).toHaveLength(1);
		expect(h.submitted[0]!.text).toContain("id: m2");
		expect(h.submitted[0]!.text).toContain("[injection check unavailable]");
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("130");
		await closeSinks(h);
	});

	test("an empty poll advances the cursor without a turn", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => ({ hits: [], historyId: "110" });
		const w = start(h);
		await w.tick();
		expect(h.submitted).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("110");
		expect(h.programs.get(p.id)!.lastRun).toBeNull();
	});

	test("an expired cursor re-baselines instead of failing", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "1", 0);
		h.pollImpl = async () => {
			throw new HistoryExpiredError();
		};
		const w = start(h);
		await w.tick();
		expect(h.submitted).toHaveLength(0);
		expect(h.notices).toHaveLength(0);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("100");
	});

	test("a failing check notices once per episode, then recovers silently", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => {
			throw new Error("gmail: HTTP 500");
		};
		const w = start(h);
		await w.tick();
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]!.text).toContain('"bank watch" is failing');
		// Second tick, same error — silent.
		await w.tick();
		expect(h.notices).toHaveLength(1);
		// A changed error re-warns.
		h.pollImpl = async () => {
			throw new Error("gmail: HTTP 403");
		};
		await w.tick();
		expect(h.notices).toHaveLength(2);
		// Success clears the episode — the next failure warns again.
		h.pollImpl = async () => ({ hits: [], historyId: "130" });
		await w.tick();
		expect(h.notices).toHaveLength(2);
		h.pollImpl = async () => {
			throw new Error("gmail: HTTP 500");
		};
		await w.tick();
		expect(h.notices).toHaveLength(3);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("130");
	});

	test("one failing program doesn't stop the others", async () => {
		const h = harness();
		const bad = mailProgram(h, "bad", "from:bad");
		const good = mailProgram(h, "good", "from:good");
		h.programs.setMailHistory(bad.id, "100", 0);
		h.programs.setMailHistory(good.id, "100", 0);
		h.pollImpl = async (filter) => {
			if (filter === "from:bad") throw new Error("gmail: HTTP 500");
			return { hits: [hit("m1")], historyId: "120" };
		};
		const w = start(h);
		await w.tick();
		expect(h.fired.map((f) => f.program)).toEqual([good.id]);
		expect(h.submitted).toHaveLength(1);
		expect(h.notices).toHaveLength(1);
		await closeSinks(h);
	});

	test("unconfigured mail idles — no polls, no turns", async () => {
		const h = harness();
		h.reader = null;
		mailProgram(h);
		const w = start(h);
		await w.tick();
		expect(h.polls).toHaveLength(0);
		expect(h.submitted).toHaveLength(0);
	});

	test("a disable mid-poll consumes the checkpoint without firing a turn", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => {
			// The toggle lands while the poll is in flight.
			h.programs.update(p.id, { enabled: false });
			return { hits: [hit("m1")], historyId: "120" };
		};
		const w = start(h);
		await w.tick();
		expect(h.submitted).toHaveLength(0);
		// The cursor still advances — mail matched while disabled is
		// skipped, not owed (the cron rule).
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("120");
		expect(h.programs.get(p.id)!.lastRun).toBeNull();
	});

	test("a filter edit mid-poll wins — no fire, and the re-baseline cursor survives", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => {
			// update() nulls mailHistoryId on a filter change to force a
			// re-baseline — the stale poll must not write its cursor over it.
			h.programs.update(p.id, { mailFilter: "from:bank is:important" });
			return { hits: [hit("m1")], historyId: "120" };
		};
		const w = start(h);
		await w.tick();
		expect(h.fired).toHaveLength(0);
		expect(h.submitted).toHaveLength(0);
		const after = h.programs.get(p.id)!;
		expect(after.mailFilter).toBe("from:bank is:important");
		expect(after.mailHistoryId).toBeNull();
		expect(after.lastRun).toBeNull();
	});

	test("a delete mid-poll writes nothing and fires nothing", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => {
			h.programs.remove(p.id);
			return { hits: [hit("m1")], historyId: "120" };
		};
		const w = start(h);
		await w.tick();
		expect(h.fired).toHaveLength(0);
		expect(h.submitted).toHaveLength(0);
		expect(h.programs.get(p.id)).toBeNull();
	});

	test("a fire that does not land holds the checkpoint, then retries next tick", async () => {
		const h = harness();
		const p = mailProgram(h);
		h.programs.setMailHistory(p.id, "100", 0);
		h.pollImpl = async () => ({ hits: [hit("m1")], historyId: "120" });
		h.failSubmit = true;
		const captured: string[] = [];
		setLogFile("mail-watch-fire-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		const w = start(h);
		try {
			await w.tick();
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		// The fire path ran, but the turn didn't land: no markFired, and
		// the checkpoint stays at "100" — the matches are still ahead of
		// the cursor, not silently skipped.
		expect(h.fired).toHaveLength(1);
		expect(h.submitted).toHaveLength(0);
		expect(h.programs.get(p.id)!.lastRun).toBeNull();
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("100");
		const lines = captured.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(
			lines.some(
				(l) =>
					l.msg === "mail fire did not land — checkpoint held, matches retry next poll" &&
					l.level === "error",
			),
		).toBe(true);
		expect(lines.some((l) => l.msg === "mail fired")).toBe(false);

		// Recovery: the runtime accepts again — the next poll re-reads
		// from the held cursor and the match fires for real.
		h.failSubmit = false;
		await w.tick();
		expect(h.polls).toEqual([
			{ filter: "from:bank", cursor: "100" },
			{ filter: "from:bank", cursor: "100" },
		]);
		expect(h.submitted).toHaveLength(1);
		expect(h.programs.get(p.id)!.mailHistoryId).toBe("120");
		expect(h.programs.get(p.id)!.lastRun).toBe(NOW.toISOString());
		await closeSinks(h);
	});
});
