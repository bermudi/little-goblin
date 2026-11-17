// Responsibility routes — the feed GETs serve the durable read model
// (events + wake dispositions + live responsibility state), and the
// control POSTs drive the same verbs the coordination tool owns:
// a correction lands as a durable operator event, pause/cancel move
// status, cancel quiets the follow-up, detach never touches the
// workspace, and reattach binds the current occupant only.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { T3Thread } from "../t3.ts";
import { openPrograms } from "../programs.ts";
import { openResponsibilities, type ResponsibilityStore } from "../responsibilities.ts";
import type { AttachmentTarget } from "../responsibility-types.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { openWakeStore } from "../wake-store.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import { deferred } from "../testkit.ts";
import type { AppResponsibilityDeps } from "./app-responsibilities.ts";
import type { AppAttentionResponse, AppResponsibilityFeed } from "./app-wire.ts";
import type { ConversationStore } from "../conversation.ts";
import type { ProjectStore } from "../projects.ts";

interface Rig {
	resps: ResponsibilityStore;
	programs: ReturnType<typeof openPrograms>;
	store: ConversationStore;
	responsibilities: AppResponsibilityDeps;
}

function depsFor(
	ctx: { store: ConversationStore; projects: ProjectStore; home: string },
	opts: { threads?: T3Thread[]; listThreads?: (project: string) => Promise<T3Thread[]> } = {},
): Rig {
	const resps = openResponsibilities(ctx.store.db);
	const wakes = openWakeStore(ctx.store.db);
	const programs = openPrograms(join(ctx.home, "programs.sqlite"));
	const responsibilities: AppResponsibilityDeps = {
		feed: { db: ctx.store.db, resps, programs },
		resps,
		service: makeResponsibilityService({
			db: ctx.store.db,
			resps,
			wakes,
			programs,
			conversations: ctx.store,
			pump: () => {},
		}),
		listThreads: opts.listThreads ?? (() => Promise.resolve(opts.threads ?? [])),
	};
	return { resps, programs, store: ctx.store, responsibilities };
}

const target = (over: Partial<AttachmentTarget> = {}): AttachmentTarget => ({
	server: "t3",
	session: "proj-1",
	agentName: "mcp:t1",
	paneId: null,
	terminalId: null,
	agentSession: "mcp:t1",
	kind: null,
	cwd: null,
	...over,
});

const liveThread = (over: Partial<T3Thread> = {}): T3Thread => ({
	threadId: "mcp:t1",
	projectId: "proj-1",
	title: "worker",
	link: "https://t3/t1",
	status: "idle",
	latestRunId: "run:9",
	itemCount: 9,
	pendingRequestCount: 0,
	createdAt: "2026-11-16T00:00:00Z",
	updatedAt: "2026-11-16T00:00:00Z",
	...over,
});

const understanding = {
	outcome: "land the fix",
	situation: "mid-task",
	nextAction: "check diff",
	checkpoints: [],
	completionEvidence: ["ci"],
};

describe("app responsibilities", () => {
	test("feed GETs, correction event, pause/cancel lifecycle", async () => {
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx);
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const id = responsibility.responsibilityId;

			// Project feed + home aggregation.
			const feed = await call(`/api/app/projects/${project.id}/responsibilities`);
			expect(feed.status).toBe(200);
			const items = (
				(await feed.json()) as {
					items: { responsibility: { responsibilityId: string } }[];
				}
			).items;
			expect(items.map((i) => i.responsibility.responsibilityId)).toEqual([id]);
			const homeFeed = await call("/api/app/responsibilities");
			expect(((await homeFeed.json()) as { items: unknown[] }).items).toHaveLength(1);

			const att = rig.resps.attach({
				responsibilityId: id,
				target: target(),
				baseline: {},
			});
			const prepared = rig.resps.prepareOperation({
				responsibilityId: id,
				attachmentId: att.attachmentId,
				brief: "b",
			});
			if (!("operation" in prepared)) throw new Error("expected prepared");

			// Malformed client JSON is a 400, never a mutation or a
			// successful correction with an empty/default body.
			const malformed = await call(`/api/app/responsibilities/${id}/correct`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			});
			expect(malformed.status).toBe(400);
			expect(await malformed.json()).toEqual({ error: "bad json" });
			expect(rig.resps.get(id)!.revision).toBe(responsibility.revision);
			expect(rig.store.db.query("SELECT event_id FROM work_events").all()).toHaveLength(0);

			// Correct — a comment lands as a durable operator event.
			const corrected = await call(`/api/app/responsibilities/${id}/correct`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "watch the flaky test instead" }),
			});
			expect(corrected.status).toBe(200);
			expect(
				(rig.store.db.query("SELECT kind FROM work_events").all() as { kind: string }[]).map(
					(row) => row.kind,
				),
			).toEqual(["operator-correction"]);
			expect(rig.resps.get(id)!.revision).toBe(responsibility.revision + 1);
			expect(rig.resps.validateForSend(prepared.operation.operationId)).toEqual({
				refused: "stale-revision",
			});

			// Pause → status; cancel → status + disabled follow-up.
			expect((await call(`/api/app/responsibilities/${id}/pause`, { method: "POST" })).status).toBe(
				200,
			);
			expect(rig.resps.get(id)!.status).toBe("paused");
			const p = rig.programs.create({
				name: "f",
				charter: "c",
				cron: "* * * * *",
				responsibilityId: id,
			});
			rig.resps.setFollowup(id, String(p.id));
			expect(
				(await call(`/api/app/responsibilities/${id}/cancel`, { method: "POST" })).status,
			).toBe(200);
			expect(rig.resps.get(id)!.status).toBe("cancelled");
			expect(rig.programs.get(p.id)!.enabled).toBe(false);
			expect(rig.resps.get(id)!.armed).toBe(false);
			expect(
				(await call(`/api/app/responsibilities/${id}/resume`, { method: "POST" })).status,
			).toBe(200);
			expect(rig.resps.get(id)!.status).toBe("active");
			expect(rig.resps.get(id)!.followupProgramId).toBe(String(p.id));
			expect(rig.programs.get(p.id)!.enabled).toBe(true);
			expect(rig.programs.get(p.id)!.nextRun).not.toBeNull();
			expect(rig.resps.get(id)!.armed).toBe(true);
		} finally {
			http.stop();
		}
	});

	test("detach marks the row; reattach binds the live thread record", async () => {
		const live = liveThread({ status: "idle", latestRunId: "run:9", itemCount: 9 });
		const listCalls: string[] = [];
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, {
					threads: [live],
					listThreads: async (project) => {
						listCalls.push(project);
						return [live];
					},
				});
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const att = rig.resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: target(),
				baseline: {},
			});
			expect(
				(
					await call(
						`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/detach`,
						{ method: "POST" },
					)
				).status,
			).toBe(200);
			expect(rig.resps.getAttachment(att.attachmentId)!.health).toBe("detached");
			// Reattach binds the live record of the bound thread id — the
			// listing is asked for the attachment's T3 project.
			const rebound = await call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			expect(rebound.status).toBe(200);
			const body = (await rebound.json()) as { generation: number };
			expect(body.generation).toBe(att.generation + 1);
			expect(listCalls).toEqual(["proj-1"]);
			// The live snapshot is the new generation's observation cursor —
			// a null here would make the observer adopt its next poll as
			// baseline and developments in between would be lost.
			expect(rig.resps.getAttachment(att.attachmentId)!.cursor).toMatchObject({
				status: "idle",
				latestRunId: "run:9",
				itemCount: 9,
				missing: false,
				epoch: 0,
				waitingTransitions: 0,
			});
		} finally {
			http.stop();
		}
	});

	test("unwired surface refuses 503; wired surface 404s unknown ids", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await call("/api/app/responsibilities")).status).toBe(503);
			expect((await call("/api/app/responsibilities/nope/pause", { method: "POST" })).status).toBe(
				503,
			);
		} finally {
			http.stop();
		}
		let rig!: Rig;
		const { http: http2, call: call2 } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx);
				return rig.responsibilities;
			},
		});
		try {
			expect((await call2("/api/app/responsibilities/nope/pause", { method: "POST" })).status).toBe(
				404,
			);
		} finally {
			http2.stop();
		}
	});
});

for (const scenario of [
	{
		name: "a listed thread rebinds its current record",
		threads: [liveThread({ providerInstanceId: "pi-2", worktreePath: "/w/x" })],
		status: 200,
	},
	{
		name: "a thread absent from the project list refuses 409",
		threads: [],
		status: 409,
	},
]) {
	test(`reattach: ${scenario.name}`, async () => {
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { threads: scenario.threads });
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "target resolution" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "resolution",
				understanding,
			});
			const att = rig.resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: target(),
				baseline: {},
			});
			rig.resps.detach(att.attachmentId);
			const before = rig.resps.getAttachment(att.attachmentId)!;
			const response = await call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			expect(response.status).toBe(scenario.status);
			const after = rig.resps.getAttachment(att.attachmentId)!;
			if (scenario.status === 200) {
				expect(after.target.agentSession).toBe("mcp:t1");
				expect(after.target.kind).toBe("pi-2");
				expect(after.target.cwd).toBe("/w/x");
				expect(after.generation).toBe(before.generation + 1);
			} else {
				expect(after).toEqual(before);
				expect(await response.json()).toHaveProperty("error");
			}
		} finally {
			http.stop();
		}
	});
}

// The reattach route snapshots the attachment, then awaits the live
// listing — a binding that moves in that window (a detach, another
// reattach, a health write) must refuse 409, never overwrite the win.
describe("reattach mid-listing races", () => {
	const gated = (live: T3Thread[]) => {
		const started = deferred<void>();
		const release = deferred<void>();
		return {
			started,
			release,
			listThreads: async () => {
				started.resolve();
				await release.promise;
				return live;
			},
		};
	};

	test("a detach landing mid-listing refuses 409 and stays detached", async () => {
		const gate = gated([liveThread()]);
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { listThreads: gate.listThreads });
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const att = rig.resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: target(),
				baseline: {},
			});
			const pending = call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			await gate.started.promise;
			const det = await call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/detach`,
				{ method: "POST" },
			);
			expect(det.status).toBe(200);
			const detached = rig.resps.getAttachment(att.attachmentId)!;
			gate.release.resolve();
			const res = await pending;
			expect(res.status).toBe(409);
			expect(await res.json()).toHaveProperty("error");
			// The delayed request wrote nothing — the detach wins whole.
			expect(rig.resps.getAttachment(att.attachmentId)!).toEqual(detached);
			expect(rig.resps.getAttachment(att.attachmentId)!.generation).toBe(att.generation);
		} finally {
			http.stop();
		}
	});

	test("a competing reattach landing first wins; the delayed request 409s", async () => {
		const gate = gated([liveThread()]);
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { listThreads: gate.listThreads });
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const att = rig.resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: target(),
				baseline: {},
			});
			const pending = call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			await gate.started.promise;
			const winner = rig.resps.reattach(
				att.attachmentId,
				target({ agentName: "mcp:winner", agentSession: "mcp:winner" }),
				{ won: true },
			);
			gate.release.resolve();
			const res = await pending;
			expect(res.status).toBe(409);
			const after = rig.resps.getAttachment(att.attachmentId)!;
			expect(after.generation).toBe(winner.generation);
			expect(after.target.agentSession).toBe("mcp:winner");
			expect(after.baseline).toEqual({ won: true });
		} finally {
			http.stop();
		}
	});

	test("a health write landing mid-listing refuses 409", async () => {
		const gate = gated([liveThread()]);
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { listThreads: gate.listThreads });
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const att = rig.resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: target(),
				baseline: {},
			});
			const pending = call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			await gate.started.promise;
			rig.resps.setHealth(att.attachmentId, "missing");
			gate.release.resolve();
			const res = await pending;
			expect(res.status).toBe(409);
			const after = rig.resps.getAttachment(att.attachmentId)!;
			expect(after.health).toBe("missing");
			expect(after.generation).toBe(att.generation);
		} finally {
			http.stop();
		}
	});
});

test("reattach to the same thread with an unresolved delivery is a 409, not a crash", async () => {
	// The listing still carries the bound thread — same dispatch
	// identity — so a generation bump would silently skip reconciliation.
	const live = liveThread({ status: "running", latestRunId: "run:9", itemCount: 9 });
	let rig!: Rig;
	const { http, call, store, projects } = setup({
		token: APP_TOKEN_NAME,
		responsibilities: (ctx) => {
			rig = depsFor(ctx, { threads: [live] });
			return rig.responsibilities;
		},
	});
	try {
		const project = projects.create({ name: "rig" });
		const conv = store.resolve(
			{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
			project.dir,
		);
		const { responsibility } = rig.resps.create({
			projectId: project.id,
			coordinationConversationId: conv.id,
			handoverKey: "k1",
			understanding,
		});
		const att = rig.resps.attach({
			responsibilityId: responsibility.responsibilityId,
			target: target(),
			baseline: {},
		});
		const prepared = rig.resps.prepareOperation({
			responsibilityId: responsibility.responsibilityId,
			attachmentId: att.attachmentId,
			brief: "b",
		});
		if (!("operation" in prepared)) throw new Error("expected prepared");
		rig.resps.claimForSend(prepared.operation.operationId);
		rig.resps.transitionOperation(prepared.operation.operationId, "uncertain", {
			outcome: { error: "io" },
			from: "sent",
		});
		rig.resps.detach(att.attachmentId);
		const response = await call(
			`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
			{ method: "POST" },
		);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string; operation?: { operationId: string } };
		expect(body.operation?.operationId).toBe(prepared.operation.operationId);
		expect(body.error).toContain(prepared.operation.operationId);
		expect(rig.resps.getAttachment(att.attachmentId)!.generation).toBe(1);
	} finally {
		http.stop();
	}
});

describe("reports and attention", () => {
	test("a report the operator must answer reaches the feed stage and Attention", async () => {
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx);
				return rig.responsibilities;
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = rig.resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k-report",
				understanding,
			});
			const id = responsibility.responsibilityId;
			const attention = async () =>
				((await (await call("/api/app/attention")).json()) as AppAttentionResponse).items.filter(
					(i) => i.kind === "responsibility",
				);
			expect(await attention()).toEqual([]);

			rig.resps.report(
				id,
				{ state: "blocked", reason: "CI needs a secret", question: "Add DEPLOY_KEY to the repo?" },
				"goblin",
			);
			const feed = (await (
				await call("/api/app/responsibilities")
			).json()) as AppResponsibilityFeed;
			expect(feed.items[0]!.stage).toEqual({
				waitsFor: "operator",
				stage: "question",
				reason: "Add DEPLOY_KEY to the repo?",
			});
			expect(feed.items[0]!.latestReport?.reporter).toBe("goblin");
			const items = await attention();
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				detail: "Add DEPLOY_KEY to the repo?",
				target: { kind: "conversation", conversationId: conv.id },
			});

			// The operator's correction answers it — the item leaves Attention.
			const res = await call(`/api/app/responsibilities/${id}/correct`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "added it" }),
			});
			expect(res.status).toBe(200);
			expect(await attention()).toEqual([]);
		} finally {
			rig?.programs.close();
			http.stop();
		}
	});
});
