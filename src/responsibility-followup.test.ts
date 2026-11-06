import { afterEach, describe, expect, test } from "bun:test";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openPrograms } from "./programs.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { responsibilityTool } from "./agent/tools/responsibility.ts";
import { feedForProject } from "./responsibility-feed.ts";
import { SILENCE_LIMIT_MS } from "./responsibility-followup.ts";
import { makeResponsibilityService } from "./responsibility-service.ts";
import { fireScheduled, type SchedulerDeps } from "./scheduler.ts";
import { tmpDb, useHome } from "./testkit.ts";
import { openWakeStore, type DevelopmentInput } from "./wake-store.ts";

setLogFile(null);
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0).reverse()) close();
});

function rig() {
	useHome("goblin-followup-home-");
	const dbPath = tmpDb("goblin-followup-");
	const store = openStore(dbPath);
	const programs = openPrograms(dbPath);
	closers.push(
		() => store.close(),
		() => programs.close(),
	);
	const project = openProjects(store).create({ name: "followup" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	store.bindProject(conv.id, project.id);
	const resps = openResponsibilities(store.db);
	const wakes = openWakeStore(store.db);
	const svc = makeResponsibilityService({
		db: store.db,
		resps,
		wakes,
		programs,
		conversations: store,
		pump() {},
	});
	const { responsibility: resp } = svc.accept({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "initial",
		understanding: {
			outcome: "Verified kernel upgrade",
			situation: "Tests are running",
			nextAction: "Check boot and driver evidence",
			checkpoints: [],
			completionEvidence: ["Booted new kernel", "Driver smoke tests passed"],
		},
		attachments: [],
	});
	const id = resp.responsibilityId;
	const program = programs.get(Number(resp.followupProgramId))!;
	const inputs: DevelopmentInput[] = [];
	const deps = {
		programs,
		responsibilities: resps,
		recordDevelopment(input: DevelopmentInput) {
			inputs.push(input);
			wakes.record(input);
		},
	} as unknown as SchedulerDeps; // Only the responsibility destination is exercised.
	const feed = () => feedForProject({ db: store.db, resps, programs }, project.id)[0]!;
	const events = () => feed().events.filter((e) => e.kind === "scheduled-checkin");
	const tick = (at: string) => fireScheduled(deps, programs.get(program.id)!, new Date(at));
	const plan = (dueAt = program.nextRun!, reason = "Verify the promised test evidence") =>
		resps.planFollowup(id, { dueAt, reason }).followup;
	return {
		store,
		programs,
		resps,
		wakes,
		svc,
		resp,
		id,
		conv,
		dbPath,
		program,
		deps,
		inputs,
		feed,
		events,
		tick,
		plan,
	};
}

describe("deliberate responsibility follow-up", () => {
	test("quiet clock ticks cost no wake until the persisted silence bound is due", () => {
		const r = rig();
		const dueAt = r.resp.followup.dueAt;
		expect(Date.parse(dueAt) - Date.parse(r.resp.createdAt)).toBe(SILENCE_LIMIT_MS);
		for (const minutes of [15, 30, 45]) {
			r.tick(new Date(Date.parse(r.resp.createdAt) + minutes * 60_000).toISOString());
		}
		expect(r.inputs).toHaveLength(0);
		expect(r.resps.get(r.id)!.followup).toEqual(r.resp.followup);
		r.tick(dueAt);
		expect(r.events()).toHaveLength(1);
		expect(r.inputs[0]!.text).toContain("Silence limit");
		expect(r.resps.get(r.id)!.followup.dueAt).toBe(
			new Date(Date.parse(dueAt) + SILENCE_LIMIT_MS).toISOString(),
		);
		r.tick(r.programs.get(r.program.id)!.nextRun!);
		expect(r.events()).toHaveLength(1);
	});

	test("a due promise exposes purpose/time, enqueues once, and consumes only after durable record", () => {
		const r = rig();
		const plan = r.plan();
		expect(r.feed()).toMatchObject({
			nextCheckinAt: plan.dueAt,
			nextCheckinReason: plan.reason,
		});
		r.tick(plan.dueAt);
		expect(r.inputs).toHaveLength(1);
		expect(r.inputs[0]).toMatchObject({
			sourceKey: `followup:${r.id}:${plan.token}`,
			conversationId: r.conv.id,
			facts: { followup: plan },
		});
		expect(r.events()[0]!.text).toContain(`Review due ${plan.dueAt}: ${plan.reason}`);
		// The same source key is append-once even after the plan advances.
		expect(r.wakes.record(r.inputs[0]!).created).toBe(false);
		r.tick(r.programs.get(r.program.id)!.nextRun!);
		expect(r.events()).toHaveLength(1);
		expect(r.resps.consumeFollowup(r.id, plan.token, new Date(plan.dueAt))).toBe(false);
	});

	test("failed enqueue keeps both obligation and occurrence due for recovery", () => {
		const r = rig();
		const plan = r.plan();
		expect(() =>
			fireScheduled(
				{
					...r.deps,
					recordDevelopment() {
						throw new Error("outbox unavailable");
					},
				},
				r.program,
				new Date(plan.dueAt),
			),
		).toThrow("outbox unavailable");
		expect(r.resps.get(r.id)!.followup).toEqual(plan);
		expect(r.programs.get(r.program.id)!.nextRun).toBe(r.program.nextRun);
		expect(r.events()).toHaveLength(0);
		r.tick(plan.dueAt);
		expect(r.events()).toHaveLength(1);
	});

	test("restart between record and plan consume dedupes even across different clock occurrences", () => {
		const r = rig();
		const plan = r.plan();
		expect(() =>
			fireScheduled(
				{
					...r.deps,
					responsibilities: {
						...r.resps,
						consumeFollowup() {
							throw new Error("plan write failed");
						},
					},
				},
				r.program,
				new Date(plan.dueAt),
			),
		).toThrow("plan write failed");
		expect(r.events()).toHaveLength(1);
		const restarted = openStore(r.dbPath);
		const programs = openPrograms(r.dbPath);
		closers.push(
			() => restarted.close(),
			() => programs.close(),
		);
		const resps = openResponsibilities(restarted.db);
		const wakes = openWakeStore(restarted.db);
		const later = new Date(Date.parse(plan.dueAt) + 5 * 60_000);
		fireScheduled(
			{
				...r.deps,
				programs,
				responsibilities: resps,
				recordDevelopment: (i) => {
					wakes.record(i);
				},
			},
			programs.get(r.program.id)!,
			later,
		);
		expect(r.events()).toHaveLength(1);
		expect(resps.get(r.id)!.followup.token).not.toBe(plan.token);
		expect(programs.get(r.program.id)!.nextRun).not.toBe(r.program.nextRun);
		// The pre-crash pending wake remains recoverable, with one copy
		// of the due promise alongside the initial handover.
		const pending = wakes.pending(r.conv.id);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.events).toHaveLength(2);
		expect(wakes.reconcile(later.toISOString(), () => null).toAppend).toHaveLength(1);
		wakes.commit(pending[0]!.wakeId, ({ id, text }) =>
			restarted.append(r.conv.id, [{ id, role: "user", parts: [{ type: "text", text }] }]),
		);
		expect(restarted.historyEntries(r.conv.id)).toHaveLength(1);
		expect(wakes.reconcile(later.toISOString(), () => null).toResubmit).toHaveLength(1);
	});

	test("advancing the plan but losing the Program cursor still cannot duplicate the review after restart", () => {
		const r = rig();
		const plan = r.plan();
		fireScheduled(
			{
				...r.deps,
				programs: {
					...r.programs,
					markRan() {
						throw new Error("cursor write failed");
					},
				},
			},
			r.program,
			new Date(plan.dueAt),
		);
		expect(r.events()).toHaveLength(1);
		expect(r.programs.get(r.program.id)!.nextRun).toBe(r.program.nextRun);
		const programs = openPrograms(r.dbPath);
		closers.push(() => programs.close());
		fireScheduled({ ...r.deps, programs }, programs.get(r.program.id)!, new Date(plan.dueAt));
		expect(r.events()).toHaveLength(1);
		expect(programs.get(r.program.id)!.nextRun).not.toBe(r.program.nextRun);
	});

	for (const status of ["paused", "completed", "cancelled"] as const) {
		test(`${status} suppresses timed inference and does not retain an obsolete promise`, () => {
			const r = rig();
			const previous = r.plan();
			r.resps.setStatus(r.id, status);
			r.tick(previous.dueAt);
			expect(r.events()).toHaveLength(0);
			expect(r.feed().nextCheckinAt).toBeNull();
			expect(r.feed().nextCheckinReason).toBeNull();
			expect(r.resps.get(r.id)!.followup.token).not.toBe(previous.token);
			r.resps.setStatus(r.id, "active");
			r.tick(r.programs.get(r.program.id)!.nextRun!);
			expect(r.events()).toHaveLength(0);
		});
	}

	test("waiting on the operator holds the silence backstop, not an agreed review", () => {
		const r = rig();
		r.resps.report(
			r.id,
			{ state: "blocked", reason: "needs a key", question: "add DEPLOY_KEY?" },
			"goblin",
		);
		const silence = r.resps.get(r.id)!.followup;
		expect(silence.kind).toBe("silence");
		r.tick(silence.dueAt);
		expect(r.events()).toHaveLength(0);
		// Held, not consumed — the backstop is still owed once answered.
		expect(r.resps.get(r.id)!.followup.token).toBe(silence.token);

		const promise = r.plan(r.programs.get(r.program.id)!.nextRun!);
		r.tick(promise.dueAt);
		expect(r.events()).toHaveLength(1);
	});

	test("leaving the operator's stage re-arms the backstop instead of firing it stale", () => {
		const r = rig();
		r.resps.report(r.id, { state: "ready", reason: "at the checkpoint" }, "goblin");
		const held = r.resps.get(r.id)!.followup.dueAt;
		const next = r.programs.get(r.program.id)!.nextRun!;
		r.tick(Date.parse(next) > Date.parse(held) ? next : held);
		expect(r.events()).toHaveLength(0);
		Bun.sleepSync(2);
		r.resps.report(r.id, { state: "progress", reason: "carrying on" }, "goblin");
		const rearmed = r.resps.get(r.id)!.followup;
		expect(rearmed.kind).toBe("silence");
		expect(Date.parse(rearmed.dueAt)).toBeGreaterThan(Date.parse(held));
	});

	test("the operator's correction releases a held silence backstop", () => {
		const r = rig();
		r.resps.report(r.id, { state: "ready", reason: "at the pre-send checkpoint" }, "goblin");
		r.tick(r.resps.get(r.id)!.followup.dueAt);
		expect(r.events()).toHaveLength(0);
		r.svc.correct(r.id, { text: "looks good, carry on" });
		const due = r.resps.get(r.id)!.followup.dueAt;
		const next = r.programs.get(r.program.id)!.nextRun!;
		r.tick(Date.parse(next) > Date.parse(due) ? next : due);
		expect(r.events()).toHaveLength(1);
	});

	test("correction invalidates the old promise and wakes the correct coordination lane", () => {
		const r = rig();
		const previous = r.plan();
		const epoch = r.store.get(r.conv.id)!.epoch;
		r.svc.correct(r.id, { text: "Verify a reboot, not merely a built package" });
		r.tick(previous.dueAt);
		expect(r.events()).toHaveLength(0);
		expect(r.store.get(r.conv.id)!.epoch).toBe(epoch + 1);
		expect(r.feed().events.at(-1)).toMatchObject({
			kind: "operator-correction",
			conversationId: r.conv.id,
		});
		expect(r.resps.get(r.id)!.followup.kind).toBe("silence");
	});

	for (const edit of ["disable", "delete", "reschedule"] as const) {
		test(`${edit} wins over a stale scheduled snapshot`, () => {
			const r = rig();
			const plan = r.plan();
			if (edit === "disable") r.programs.update(r.program.id, { enabled: false });
			if (edit === "delete") r.programs.remove(r.program.id);
			if (edit === "reschedule") r.programs.update(r.program.id, { cron: "0 12 * * *" });
			fireScheduled(r.deps, r.program, new Date(plan.dueAt));
			expect(r.events()).toHaveLength(0);
			expect(r.resps.get(r.id)!.followup).toEqual(plan);
		});
	}

	test("a newer review is not overwritten when the previous enqueue completes", () => {
		const r = rig();
		const old = r.plan();
		const later = new Date(Date.parse(old.dueAt) + 30 * 60_000).toISOString();
		const newer = r.plan(later, "Review after the extended test run");
		expect(r.resps.consumeFollowup(r.id, old.token, new Date(old.dueAt))).toBe(false);
		r.tick(old.dueAt);
		expect(r.inputs).toHaveLength(0);
		expect(r.resps.get(r.id)!.followup).toEqual(newer);
	});

	test("repeated identical plans preserve identity; due time and purpose validate at the store boundary", () => {
		const r = rig();
		const plan = r.plan();
		expect(r.plan()).toEqual(plan);
		expect(() => r.plan("not a date")).toThrow();
		expect(() => r.plan("2030-01-01T12:00:00")).toThrow();
		expect(() => r.plan(r.program.nextRun!, "   ")).toThrow();
		expect(r.resps.get(r.id)!.followup).toEqual(plan);
	});

	test("replanning and rescheduling during enqueue cannot be overwritten by stale accounting", () => {
		const r = rig();
		const previous = r.plan();
		const dueAt = new Date(Date.parse(previous.dueAt) + SILENCE_LIMIT_MS).toISOString();
		let nextRun: string | null = null;
		fireScheduled(
			{
				...r.deps,
				recordDevelopment(input) {
					r.wakes.record(input);
					r.plan(dueAt, "Assess the extended test after completion");
					nextRun = r.programs.update(r.program.id, { cron: "0 12 * * *" })!.nextRun;
				},
			},
			r.program,
			new Date(previous.dueAt),
		);
		expect(r.events()).toHaveLength(1);
		expect(r.resps.get(r.id)!.followup).toMatchObject({ kind: "commitment", dueAt });
		expect(r.programs.get(r.program.id)!.nextRun).toBe(nextRun);
		expect(r.programs.get(r.program.id)!.lastRun).toBeNull();
	});

	test("an unlinked create is silent until recovery relinks it, without losing the due review", () => {
		const r = rig();
		const plan = r.plan();
		r.resps.setFollowup(r.id, null);
		r.tick(plan.dueAt);
		expect(r.events()).toHaveLength(0);
		expect(r.resps.get(r.id)!.followup).toEqual(plan);
		expect(r.svc.ensureFollowup(r.id)!.id).toBe(r.program.id);
		r.tick(r.programs.get(r.program.id)!.nextRun!);
		expect(r.events()).toHaveLength(1);
	});

	test("legacy name-only follow-ups keep their cron while gaining the due-review gate", () => {
		const r = rig();
		r.store.db.run("UPDATE programs SET kind = 'custom' WHERE id = ?", [r.program.id]);
		const legacy = r.programs.update(r.program.id, { cron: "*/15 * * * *" })!;
		r.tick(legacy.nextRun!);
		expect(r.events()).toHaveLength(0);
		expect(r.svc.ensureFollowup(r.id)!.cron).toBe("*/15 * * * *");
		const plan = r.plan(r.programs.get(r.program.id)!.nextRun!);
		r.tick(plan.dueAt);
		expect(r.events()).toHaveLength(1);
	});

	test("feed shows cadence-constrained time, not an ordinary next tick", () => {
		const r = rig();
		const due = new Date(Date.parse(r.program.nextRun!) + 500).toISOString();
		const plan = r.plan(due);
		expect(r.feed()).toMatchObject({
			nextCheckinAt: new Date(Date.parse(r.program.nextRun!) + 60_000).toISOString(),
			nextCheckinReason: plan.reason,
			responsibility: { followup: { dueAt: due } },
		});
		r.programs.update(r.program.id, { enabled: false });
		expect(r.feed()).toMatchObject({ nextCheckinAt: null, nextCheckinReason: null });
		r.programs.remove(r.program.id);
		expect(r.feed().responsibility.notArmedReason).toBe("follow-up program missing");
	});

	test("a linked enabled Program without cron is honestly unarmed", () => {
		const r = rig();
		r.programs.update(r.program.id, { mailFilter: "from:tests", cron: null });
		expect(r.feed()).toMatchObject({
			nextCheckinAt: null,
			nextCheckinReason: null,
			responsibility: { armed: false, notArmedReason: "follow-up schedule missing" },
		});
	});

	test("legacy migration persists a bounded backstop and identity instead of rearming on every open", () => {
		const r = rig();
		// Test-owned database: emulate the pre-column schema without deleting its data.
		r.store.db.run(
			"ALTER TABLE responsibilities RENAME COLUMN followup_json TO previous_followup_json",
		);
		const migrated = openResponsibilities(r.store.db).get(r.id)!;
		expect(migrated.followup.kind).toBe("silence");
		expect(Date.parse(migrated.followup.dueAt) - Date.parse(migrated.createdAt)).toBe(
			SILENCE_LIMIT_MS,
		);
		expect(openResponsibilities(r.store.db).get(r.id)!.followup).toEqual(migrated.followup);
	});

	test("reattachment invalidates a review tied to the old worker", () => {
		const r = rig();
		const target = {
			server: "local",
			session: "default",
			agentName: "worker",
			paneId: "w1:p1",
			terminalId: "t1",
			agentSession: "s1",
			kind: "pi",
			cwd: "/w",
		};
		const attachment = r.resps.attach({ responsibilityId: r.id, target, baseline: {} });
		const prior = r.plan();
		r.resps.reattach(attachment.attachmentId, { ...target, agentSession: "s2" }, {});
		r.tick(prior.dueAt);
		expect(r.events()).toHaveLength(0);
		expect(r.resps.get(r.id)!.followup.kind).toBe("silence");
		expect(r.resps.consumeFollowup(r.id, prior.token, new Date(prior.dueAt))).toBe(false);
	});

	test("the coordination tool can plan a useful review but cannot schedule for another project or inactive work", async () => {
		const r = rig();
		const tool = responsibilityTool({
			resps: r.resps,
			service: r.svc,
			projectId: r.resp.projectId,
			coordinationConversationId: r.conv.id,
			handoverKey: "tool",
			listFor: async () => [],
		});
		if (tool.execute === undefined) throw new Error("missing execute");
		const followup = {
			dueAt: new Date(Date.now() + 2 * SILENCE_LIMIT_MS).toISOString(),
			reason: "Assess smoke-test evidence after the scheduled reboot",
		};
		const options = { toolCallId: "plan", messages: [], context: {} };
		expect(await tool.execute({ action: "followup", followup }, options)).toMatchObject({
			followupStatus: { armed: true },
		});
		expect(r.resps.get(r.id)!.followup).toMatchObject(followup);
		expect(
			await tool.execute(
				{
					action: "followup",
					followup: { ...followup, dueAt: "2000-01-01T00:00:00Z" },
				},
				options,
			),
		).toMatchObject({ error: expect.stringContaining("future") });
		expect(
			await tool.execute(
				{
					action: "followup",
					followup,
					responsibility: "other-project-responsibility",
				},
				options,
			),
		).toMatchObject({ error: expect.stringContaining("not found in this project") });
		r.resps.setStatus(r.id, "paused");
		expect(await tool.execute({ action: "followup", followup }, options)).toMatchObject({
			error: expect.stringContaining("resume first"),
		});
	});
	test("the coordination tool reports; done names each unverified evidence item and disarms on close", async () => {
		const r = rig();
		const tool = responsibilityTool({
			resps: r.resps,
			service: r.svc,
			projectId: r.resp.projectId,
			coordinationConversationId: r.conv.id,
			handoverKey: "tool",
			listFor: async () => [],
		});
		if (tool.execute === undefined) throw new Error("missing execute");
		const options = { toolCallId: "report", messages: [], context: {} };
		const check = (item: string) => ({ item, ref: "uname -r", checked: `${item} observed` });
		expect(
			await tool.execute(
				{
					action: "report",
					report: { state: "done", reason: "booted", evidence: [check("Booted new kernel")] },
				},
				options,
			),
		).toMatchObject({ error: expect.stringContaining('"Driver smoke tests passed"') });
		expect(r.resps.get(r.id)!.status).toBe("active");
		expect(
			await tool.execute(
				{
					action: "report",
					report: {
						state: "done",
						reason: "verified",
						evidence: [check("Booted new kernel"), check("Driver smoke tests passed")],
					},
				},
				options,
			),
		).toMatchObject({ report: { state: "done", reporter: "goblin" }, stage: { stage: "closed" } });
		expect(r.resps.get(r.id)!.status).toBe("completed");
		expect(r.svc.armedStatus(r.id).armed).toBe(false);
	});
});
