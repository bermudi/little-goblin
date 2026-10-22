// Responsibility routes — the feed GETs serve the durable read model
// (events + wake dispositions + live responsibility state), and the
// control POSTs drive the same verbs the coordination tool owns:
// a correction lands as a durable operator event, pause/cancel move
// status, cancel quiets the follow-up, detach never touches the
// workspace, and reattach binds the current occupant only.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { OperatorAgent } from "../herdr.ts";
import { openPrograms } from "../programs.ts";
import {
	openResponsibilities,
	type AttachmentTarget,
	type ResponsibilityStore,
} from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { openWakeStore } from "../wake-store.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppResponsibilityDeps } from "./app-responsibilities.ts";
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
	opts: { agents?: OperatorAgent[] } = {},
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
		listAgents: () => Promise.resolve(opts.agents ?? []),
	};
	return { resps, programs, store: ctx.store, responsibilities };
}

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

	test("detach marks the row; reattach binds the current occupant only", async () => {
		const live: OperatorAgent = {
			pane_id: "pane-7",
			workspace_id: "w",
			tab_id: "t",
			agent: "pi",
			agent_status: "idle",
			name: "worker-1",
			cwd: "/w",
			terminal_title: null,
			workspace_label: null,
			tab_label: null,
			terminal_id: "term-9",
			agent_session: "sess-NEW",
			state_change_seq: 9,
			completion_seq: 2,
			revision: 4,
		};
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { agents: [live] });
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
			// Reattach binds the live session — a new generation, the new
			// agent_session, never the stale binding revived.
			const rebound = await call(
				`/api/app/responsibilities/${responsibility.responsibilityId}/attachments/${att.attachmentId}/reattach`,
				{ method: "POST" },
			);
			expect(rebound.status).toBe(200);
			const body = (await rebound.json()) as { generation: number };
			expect(body.generation).toBe(att.generation + 1);
			expect(rig.resps.getAttachment(att.attachmentId)!.target.agentSession).toBe("sess-NEW");
			// The live snapshot is the new generation's observation cursor —
			// a null here would make the observer adopt its next poll as
			// baseline and developments in between would be lost.
			expect(rig.resps.getAttachment(att.attachmentId)!.cursor).toMatchObject({
				seq: 9,
				completionSeq: 2,
				status: "idle",
				agentSession: "sess-NEW",
				terminalId: "term-9",
				missing: false,
				epoch: 0,
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

const liveAgent = (over: Partial<OperatorAgent> = {}): OperatorAgent => ({
	pane_id: "pane-7",
	workspace_id: "w",
	tab_id: "t",
	agent: "pi",
	agent_status: "idle",
	name: "worker-1",
	cwd: "/w",
	terminal_title: null,
	workspace_label: null,
	tab_label: null,
	terminal_id: "term-CURRENT",
	agent_session: "sess-CURRENT",
	state_change_seq: 1,
	completion_seq: null,
	revision: 1,
	...over,
});

for (const scenario of [
	{
		name: "stored pane wins over a reused name",
		agents: [
			liveAgent({ pane_id: "pane-OTHER", agent_session: "sess-OTHER" }),
			liveAgent({ name: "renamed" }),
		],
		paneId: "pane-7",
		status: 200,
	},
	{
		name: "missing pane never falls back to a reused name",
		agents: [liveAgent({ pane_id: "pane-OTHER" })],
		paneId: "pane-7",
		status: 409,
	},
	{
		name: "legacy name must resolve uniquely",
		agents: [liveAgent(), liveAgent({ pane_id: "pane-OTHER" })],
		paneId: null,
		status: 409,
	},
	{
		name: "legacy unique name remains supported",
		agents: [liveAgent()],
		paneId: null,
		status: 200,
	},
	{
		name: "duplicate pane observations are ambiguous",
		agents: [liveAgent(), liveAgent({ name: "other" })],
		paneId: "pane-7",
		status: 409,
	},
	{
		name: "missing terminal identity refuses binding",
		agents: [liveAgent({ terminal_id: null })],
		paneId: "pane-7",
		status: 409,
	},
]) {
	test(`reattach: ${scenario.name}`, async () => {
		let rig!: Rig;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				rig = depsFor(ctx, { agents: scenario.agents });
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
				target: target({ paneId: scenario.paneId }),
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
				expect(after.target.paneId).toBe("pane-7");
				expect(after.target.agentSession).toBe("sess-CURRENT");
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

test("reattach to the same agent with an unresolved delivery is a 409, not a crash", async () => {
	// The live agent still reports the bound identity — same dispatch
	// target — so a generation bump would silently skip reconciliation.
	const live: OperatorAgent = {
		pane_id: "pane-7",
		workspace_id: "w",
		tab_id: "t",
		agent: "pi",
		agent_status: "idle",
		name: "worker-1",
		cwd: "/w",
		terminal_title: null,
		workspace_label: null,
		tab_label: null,
		terminal_id: "term-9",
		agent_session: "sess-abc",
		state_change_seq: 9,
		completion_seq: 2,
		revision: 4,
	};
	let rig!: Rig;
	const { http, call, store, projects } = setup({
		token: APP_TOKEN_NAME,
		responsibilities: (ctx) => {
			rig = depsFor(ctx, { agents: [live] });
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
