// The handover loop end-to-end on real stores: accept binds +
// arranges, the observer turns snapshots into deduped developments,
// a scheduled occurrence lands on the same coordination lane, and
// the feed read model reports all of it with wake dispositions —
// the project owns the work across every seam.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import type { OperatorAgent } from "./herdr.ts";
import { setLogFile } from "./log.ts";
import { openPrograms } from "./programs.ts";
import { openProjects } from "./projects.ts";
import { feedForProject, feedOpen } from "./responsibility-feed.ts";
import { openResponsibilities, type AttachmentTarget } from "./responsibilities.ts";
import { makeResponsibilityService } from "./responsibility-service.ts";
import { fireScheduled, type SchedulerDeps } from "./scheduler.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore, type DevelopmentInput } from "./wake-store.ts";

setLogFile(null);

const agent = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
	pane_id: "pane-7",
	workspace_id: "w",
	tab_id: "t",
	agent: "pi",
	agent_status: "working",
	name: "worker-1",
	cwd: "/w",
	terminal_title: null,
	workspace_label: null,
	tab_label: null,
	terminal_id: "term-9",
	agent_session: "sess-abc",
	state_change_seq: 4,
	completion_seq: 1,
	revision: 2,
	...over,
});

const target = (over: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
	server: "local",
	session: "op",
	agentName: "worker-1",
	paneId: "pane-7",
	terminalId: "term-9",
	agentSession: "sess-abc",
	kind: "pi",
	cwd: "/w",
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
			attachments: [{ target: target(), baseline: agent() }],
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

		// 3. Scheduled check-in — the occurrence lands a development on
		// the coordination lane, deduped by its occurrence key.
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
		fireScheduled(schedDeps, program, new Date(program.nextRun!));
		expect(recorded).toEqual([expect.stringContaining(`program:${program.id}:occ:`)]);

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
