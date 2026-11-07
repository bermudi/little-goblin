import { describe, expect, test } from "bun:test";
import { openAppPush } from "./app-push.ts";
import { appAddress } from "./conversation.ts";
import { openPrograms } from "./programs.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { REMINDER_EVERY_MS, REMINDER_FIRST_MS } from "./responsibility-reminder.ts";
import { type SchedulerDeps, startScheduler, sweepOperatorReminders } from "./scheduler.ts";
import { openTestStore, tmpDb } from "./testkit.ts";

function rig() {
	const { store } = openTestStore("goblin-reminder-");
	const conv = store.resolve(appAddress("reminder-room"), "/w");
	const resps = openResponsibilities(store.db);
	const { responsibility } = resps.create({
		projectId: openProjects(store).create({ name: "reminder" }).id,
		coordinationConversationId: conv.id,
		handoverKey: "k",
		understanding: {
			outcome: "Ship it",
			situation: "s",
			nextAction: "n",
			checkpoints: [],
			completionEvidence: ["e"],
		},
	});
	const id = responsibility.responsibilityId;
	const sent: { body: string; url: string; tag: string }[] = [];
	const failures = { next: 0 };
	const vapid = JSON.stringify({ publicKey: "pub", privateKey: "priv" });
	const push = openAppPush(store.db, {
		auth: { has: () => true, resolve: () => Promise.resolve(vapid) },
		store,
		subject: () => "mailto:goblin@example.test",
		send: (_sub, payload) => {
			if (failures.next > 0) {
				failures.next--;
				return Promise.reject(Object.assign(new Error("down"), { statusCode: 503 }));
			}
			sent.push(JSON.parse(payload));
			return Promise.resolve({ statusCode: 201, body: "", headers: {} });
		},
	});
	const attempts = new Map<string, number>();
	const pending: Promise<void>[] = [];
	const deps = {
		responsibilities: resps,
		remindOperator: (r: Parameters<typeof push.notifyReminder>[0]) => {
			const p = push.notifyReminder(r);
			pending.push(p);
			return p;
		},
	} as unknown as SchedulerDeps;
	const sweep = async (at: number) => {
		sweepOperatorReminders(deps, new Date(at), attempts);
		await Promise.all(pending);
	};
	const subscribe = () =>
		push.register(
			{
				endpoint: "https://push.example.test/e1",
				expirationTime: null,
				keys: { p256dh: "k", auth: "a" },
			},
			null,
		);
	const ask = () => {
		const out = resps.report(
			id,
			{ state: "blocked", reason: "r", question: "Which one?" },
			"goblin",
		);
		if ("refused" in out) throw new Error("refused");
		return Date.parse(out.report.createdAt);
	};
	return { resps, id, sent, failures, sweep, subscribe, ask, deps, pending };
}

describe("operator reminders", () => {
	test("ring after 4 hours, then daily, once per step", async () => {
		const r = rig();
		await r.subscribe();
		const t = r.ask();
		await r.sweep(t + REMINDER_FIRST_MS - 1);
		expect(r.sent).toHaveLength(0);
		await r.sweep(t + REMINDER_FIRST_MS);
		await r.sweep(t + REMINDER_FIRST_MS + 60_000);
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]!.body).toBe("A question is still waiting for you");
		expect(r.sent[0]!.url).toStartWith("/app/c/");
		expect(JSON.stringify(r.sent)).not.toContain("Which one?");
		await r.sweep(t + REMINDER_FIRST_MS + REMINDER_EVERY_MS);
		expect(r.sent).toHaveLength(2);
	});

	test("downtime rings only the newest step", async () => {
		const r = rig();
		await r.subscribe();
		const t = r.ask();
		await r.sweep(t + REMINDER_FIRST_MS + 5 * REMINDER_EVERY_MS);
		expect(r.sent).toHaveLength(1);
	});

	test("stop when the work leaves the operator's stage or is paused", async () => {
		const r = rig();
		await r.subscribe();
		const t = r.ask();
		r.resps.setStatus(r.id, "paused");
		await r.sweep(t + REMINDER_FIRST_MS);
		expect(r.sent).toHaveLength(0);
		r.resps.setStatus(r.id, "active");
		r.resps.report(r.id, { state: "progress", reason: "carrying on" }, "goblin");
		await r.sweep(t + REMINDER_FIRST_MS);
		expect(r.sent).toHaveLength(0);
	});

	test("a failed send retries after the back-off, not every tick", async () => {
		const r = rig();
		await r.subscribe();
		const t = r.ask();
		r.failures.next = 1;
		const first = t + REMINDER_FIRST_MS;
		await r.sweep(first);
		await r.sweep(first + 30_000);
		expect(r.sent).toHaveLength(0);
		expect(r.failures.next).toBe(0);
		await r.sweep(first + 15 * 60_000);
		expect(r.sent).toHaveLength(1);
	});

	test("the running scheduler's boot scan rings an overdue reminder", async () => {
		const r = rig();
		await r.subscribe();
		r.ask();
		const programs = openPrograms(tmpDb("goblin-reminder-programs-"));
		const realNow = Date.now;
		Date.now = () => realNow() + REMINDER_FIRST_MS;
		const RealDate = Date;
		globalThis.Date = class extends RealDate {
			constructor(...args: []) {
				super(...(args.length === 0 ? ([realNow() + REMINDER_FIRST_MS] as unknown as []) : args));
			}
		} as DateConstructor;
		try {
			const scheduler = startScheduler({ ...r.deps, programs } as unknown as SchedulerDeps);
			scheduler.stop();
		} finally {
			globalThis.Date = RealDate;
			Date.now = realNow;
			programs.close();
		}
		await Promise.all(r.pending);
		expect(r.sent).toHaveLength(1);
	});

	test("no subscribed device is not an error", async () => {
		const r = rig();
		const t = r.ask();
		await r.sweep(t + REMINDER_FIRST_MS);
		expect(r.sent).toHaveLength(0);
	});
});
