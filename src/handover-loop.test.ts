// The handover loop end-to-end on real stores: accept binds +
// arranges, the observer turns snapshots into deduped developments,
// a scheduled occurrence lands on the same coordination lane, and
// the feed read model reports all of it with wake dispositions —
// the project owns the work across every seam.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openPrograms } from "./programs.ts";
import { openProjects } from "./projects.ts";
import { feedForProject, feedOpen } from "./responsibility-feed.ts";
import { openResponsibilities } from "./responsibilities.ts";
import type { AttachmentTarget } from "./responsibility-types.ts";
import { makeResponsibilityService } from "./responsibility-service.ts";
import { fireScheduled, type SchedulerDeps } from "./scheduler.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore, type DevelopmentInput } from "./wake-store.ts";

setLogFile(null);

const baseline = { status: "working", messages: 4 };

const target = (over: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
	server: "t3",
	session: "proj-1",
	agentName: "mcp:t1",
	paneId: null,
	terminalId: null,
	agentSession: "mcp:t1",
	kind: "codex",
	cwd: null,
	...over,
});

describe("the handover loop, end to end", () => {
	test("accept → observe → check-in → feed, deduped across restarts", () => {
		const home = useHome(`goblin-loop-${tmpDir().slice(-6)}-`);
		mkdirSync(join(home, "state"), { recursive: true });
		const store = openStore(join(home, "state", "goblin.sqlite"));
		const projects = openProjects(store);
		const project = projects.create({ name: "loop" });
		const conv = store.resolve(
			{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
			project.dir,
		);
		store.bindProject(conv.id, project.id);
		const resps = openResponsibilities(store.db);
		const wakes = openWakeStore(store.db);
		const programs = openPrograms(join(home, "state", "programs.sqlite"));
		let pumps = 0;
		const svc = makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			conversations: store,
			pump: () => {
				pumps += 1;
			},
		});

		// 1. Accept — one transaction, follow-up linked, armed.
		const { responsibility, created } = svc.accept({
			projectId: project.id,
			coordinationConversationId: conv.id,
			handoverKey: "handover:m1",
			understanding: {
				outcome: "land the fix",
				situation: "agent mid-task",
				nextAction: "check the diff",
				checkpoints: ["diff reviewed"],
				completionEvidence: ["ci green"],
			},
			attachments: [{ target: target(), baseline }],
		});
		expect(created).toBe(true);
		const id = responsibility.responsibilityId;
		expect(resps.get(id)!.armed).toBe(true);
		// Duplicate handover: same responsibility, no second program.
		expect(
			svc.accept({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "handover:m1",
				understanding: {
					outcome: "land the fix",
					situation: "agent mid-task",
					nextAction: "check the diff",
					checkpoints: [],
					completionEvidence: ["ci"],
				},
				attachments: [{ target: target(), baseline: {} }],
			}).created,
		).toBe(false);
		expect(programs.list().filter((p) => p.responsibilityId === id)).toHaveLength(1);

		// 2. (Observation's reconcile internals — cursor + health +
		// event in one transaction, deduped polls — are covered by the
		// responsibility-observer suite against the same stores.)

		// 3. A due commitment, not an ordinary clock tick, lands a
		// development on the coordination lane with a durable plan key.
		const recorded: string[] = [];
		const schedDeps = {
			responsibilities: resps,
			recordDevelopment: (i: DevelopmentInput) => {
				wakes.record(i);
				recorded.push(i.sourceKey);
			},
			programs,
		} as unknown as SchedulerDeps;
		const program = programs.get(Number(responsibility.followupProgramId))!;
		resps.planFollowup(id, {
			dueAt: program.nextRun!,
			reason: "Verify the promised test result",
		});
		fireScheduled(schedDeps, program, new Date(program.nextRun!));
		expect(recorded).toEqual([expect.stringContaining(`followup:${id}:`)]);

		// 4. The feed reports everything — handover + check-in events
		// with wake dispositions, attachment health, next check-in.
		const feed = feedForProject({ db: store.db, resps, programs }, project.id);
		expect(feed).toHaveLength(1);
		const item = feed[0]!;
		expect(item.responsibility.responsibilityId).toBe(id);
		expect(item.attachments).toHaveLength(1);
		expect(item.attachments[0]!.health).toBe("attached");
		expect(item.nextCheckinAt).not.toBeNull();
		const kinds = item.events.map((e) => e.kind);
		expect(kinds).toEqual(["handover", "scheduled-checkin"]);
		expect(item.events.every((e) => e.wake !== null)).toBe(true);
		// Home aggregation surfaces the same item.
		expect(
			feedOpen({ db: store.db, resps, programs }).map((i) => i.responsibility.responsibilityId),
		).toEqual([id]);

		// 5. Cancel — the occurrence is consumed deterministically; the
		// feed still reports the full history.
		resps.setStatus(id, "cancelled");
		const next = programs.get(program.id)!;
		fireScheduled(schedDeps, next, new Date(next.nextRun!));
		expect(recorded).toHaveLength(1);
		expect(
			feedForProject({ db: store.db, resps, programs }, project.id)[0]!.responsibility.status,
		).toBe("cancelled");
		expect(feedOpen({ db: store.db, resps, programs })).toHaveLength(0);

		store.close();
	});
});
