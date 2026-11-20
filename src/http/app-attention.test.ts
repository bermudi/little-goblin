import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { HindsightClient } from "../memory/hindsight.ts";
import { OutageTracker } from "../memory/outage.ts";
import type { OutboxEntry } from "../mail-outbox.ts";
import { openPrograms } from "../programs.ts";
import type { ProgramProposal } from "../program-proposals.ts";
import { openResponsibilities } from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { openWakeStore } from "../wake-store.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppAttentionResponse } from "./app-wire.ts";

const proposal: ProgramProposal = {
	id: 7,
	kind: "create",
	targetId: null,
	draft: {
		name: "nightly",
		charter: "summarize the log",
		cron: "0 6 * * *",
		maxLatenessMinutes: null,
		hook: false,
		mailFilter: null,
		responsibilityId: null,
	},
	patch: null,
	base: null,
	baseSnapshot: null,
	target: "app/chat-01",
	chatId: 0,
	threadId: null,
	state: "pending",
	createdAt: "2026-10-21T00:00:00.000Z",
	decidedAt: null,
	decidedBy: null,
	activatedId: null,
};

const draft: OutboxEntry = {
	id: 9,
	to: ["operator@example.test"],
	cc: [],
	subject: "Report",
	body: "body",
	replyToId: null,
	target: "app/chat-01",
	chatId: 0,
	threadId: null,
	draftMessageId: null,
	status: "pending",
	createdAt: "2026-10-21T00:01:00.000Z",
	expiresAt: "2026-10-22T00:01:00.000Z",
	decidedAt: null,
	decidedBy: null,
	sentId: null,
};

describe("app attention", () => {
	test("projects the durable owners and names unwired seams", async () => {
		const dirs = mkdtempSync(join(tmpdir(), "goblin-attention-"));
		const proposed = join(dirs, "skills-proposed", "watcher");
		mkdirSync(proposed, { recursive: true });
		writeFileSync(join(proposed, "SKILL.md"), "# watcher\n");
		// An installed skill with a parked update, to prove update vs new.
		mkdirSync(join(dirs, "skills", "radar"), { recursive: true });
		writeFileSync(join(dirs, "skills", "radar", "SKILL.md"), "old\n");
		mkdirSync(join(dirs, "skills-proposed", "radar"), { recursive: true });
		writeFileSync(join(dirs, "skills-proposed", "radar", "SKILL.md"), "new\n");
		// The route sorts proposals by SKILL.md mtime — pin radar older than watcher so the asserted order never rides the id tiebreak (#441).
		const proposedAt = new Date("2026-10-20T00:00:00.000Z");
		utimesSync(join(dirs, "skills-proposed", "radar", "SKILL.md"), proposedAt, proposedAt);
		const proposedLater = new Date("2026-10-20T00:00:01.000Z");
		utimesSync(join(proposed, "SKILL.md"), proposedLater, proposedLater);
		const memStore = openStore(join(dirs, "memory.sqlite"));
		const memClient = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
		const block = (id: string, conversationId: string, error: string, timestamp: string) => {
			const op = memStore.memoryQueue.enqueue(memClient.target, {
				id,
				content: "Operator: hi\nGoblin: hello",
				timestamp,
				conversationId,
				sourceIds: ["u1", "a1"],
			});
			const row = memStore.memoryQueue.get(op);
			if (row === null) throw new Error("expected queued memory");
			memStore.memoryQueue.update(row, "blocked", 0, error);
		};
		block("exchange/app/chat-01/1/a", "app/chat-01", "HTTP 401", "2026-10-01T00:00:00.000Z");
		block("exchange/app/chat-01/2/a", "app/chat-01", "HTTP 401", "2026-10-02T00:00:00.000Z");
		block("exchange/app/gone/1/a", "app/gone", "HTTP 401", "2026-10-03T00:00:00.000Z");
		block("exchange/app/chat-01/3/a", "app/chat-01", "HTTP 500", "2026-10-04T00:00:00.000Z");
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			approvals: {
				program: {
					pending: () => [proposal],
					candidate: () => {
						// The draft's responsibilityId is string | null; the
						// candidate carries it only as an optional string.
						const { responsibilityId: _bound, ...candidate } = proposal.draft!;
						return candidate;
					},
					base: () => null,
					decide: async () => ({ kind: "refused", proposal, refusal: "gone" }),
				},
				mail: {
					pending: () => [draft],
					decide: async () => ({ kind: "gone" }),
				},
			},
			operator: {
				memory: {
					counts: () => ({
						pending: 0,
						submitted: 0,
						completed: 0,
						blocked: 1,
						dismissed: 0,
						deleting: 0,
					}),
					deletingAll: () => 0,
					blockedDetail: () => memStore.memoryQueue.blockedDetail(memClient.target),
					queue: memStore.memoryQueue,
					client: memClient,
					conversationTitle: (id: string) => (id === "app/chat-01" ? { title: "Primary" } : null),
					lastRecallOk: () => null,
					lastRecallAt: () => null,
				},
				delegations: {
					list: () => [
						{
							id: 3,
							name: "worker",
							harness: "pi",
							role: "default",
							issue: null,
							readiness: null,
							readinessNotifiedKey: null,
							readinessVersion: 0,
							readinessPendingVerdict: null,
							cwd: "/tmp",
							task: "finish the report",
							chatId: 0,
							threadId: null,
							appConversation: "app/chat-01",
							agentName: "g1-worker",
							workspaceId: "w1",
							paneId: "w1:p1",
							status: "needs_input" as const,
							baselineSeq: null,
							promptedAt: "2026-10-21T00:03:00.000Z",
							promptPending: false,
							responsibilityId: null,
							responsibilityRevision: null,
							createdAt: "2026-10-21T00:02:30.000Z",
							finishedAt: null,
						},
					],
					active: () => [],
				},
				skillSources: {
					forConversation: () => [],
					forgetConversation: () => 0,
					managedNames: () => new Set(),
					skillsDir: join(dirs, "skills"),
					proposedDir: join(dirs, "skills-proposed"),
					usagePath: join(dirs, "skill-usage.json"),
					archiveDir: join(dirs, "skills-archive"),
				},
			},
		});
		try {
			await call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "chat-01", title: "Primary" }),
			});

			const res = await call("/api/app/attention");
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppAttentionResponse;
			expect(body.unavailable).toEqual(["responsibilities"]);
			const skillItems = body.items.filter((i) => i.kind === "skill-proposal");
			expect(skillItems.map((i) => [i.title, i.detail])).toEqual([
				["Skill update — radar", "1 changed — review the diff, then install or discard"],
				["New skill — watcher", "1 file — review, then install or discard"],
			]);
			// One card per cause, not per exchange, counted over the whole queue.
			const memoryItems = body.items.filter((i) => i.kind === "memory-blocked");
			expect(memoryItems.map((i) => [i.title, i.detail, i.createdAt])).toEqual([
				["Memory can't save 3 exchanges", "HTTP 401", "2026-10-01T00:00:00.000Z"],
				["Memory can't save 1 exchange", "HTTP 500", "2026-10-04T00:00:00.000Z"],
			]);
			expect(memoryItems[0]?.memory).toEqual({
				error: "HTTP 401",
				count: 3,
				conversations: [
					{ conversationId: "app/chat-01", name: "Primary", count: 2 },
					{ conversationId: "app/gone", name: "Deleted conversation", count: 1 },
				],
				fix: expect.stringContaining("rejects its key"),
			});
			expect(new Map(body.items.map((i) => [i.id, i.target]))).toEqual(
				new Map([
					["program-approval:7", { kind: "page", page: "programs" }],
					["mail-approval:9", { kind: "page", page: "programs" }],
					["memory-blocked:HTTP 401", { kind: "page", page: "memory" }],
					["memory-blocked:HTTP 500", { kind: "page", page: "memory" }],
					["skill-proposal:radar", { kind: "page", page: "skills" }],
					["skill-proposal:watcher", { kind: "page", page: "skills" }],
					["delegation-input:3", { kind: "conversation", conversationId: "app/chat-01" }],
				]),
			);
		} finally {
			http.stop();
			memStore.close();
		}
	});

	test("a recall outage and an undrained queue project until healthy", async () => {
		const dirs = mkdtempSync(join(tmpdir(), "goblin-attention-"));
		const memStore = openStore(join(dirs, "memory.sqlite"));
		const memClient = new HindsightClient({ baseUrl: "http://127.0.0.1:1", bankId: "g" });
		const tracker = new OutageTracker(memStore.db);
		// One exchange sits in the retain queue and the service is
		// unreachable — the same durable state the Telegram outage
		// notice reads.
		memStore.memoryQueue.enqueue(memClient.target, {
			id: "exchange/app/chat-01/1/a",
			content: "Operator: hi\nGoblin: hello",
			timestamp: "2026-10-01T00:00:00.000Z",
			conversationId: "app/chat-01",
			sourceIds: ["u1", "a1"],
		});
		tracker.recordFailure("app/chat-01");
		let recallOk: boolean | null = false;
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			operator: {
				memory: {
					counts: () => memStore.memoryQueue.counts(memClient.target),
					deletingAll: () => 0,
					blockedDetail: () => [],
					queue: memStore.memoryQueue,
					client: memClient,
					lastRecallOk: () => recallOk,
					lastRecallAt: () => "2026-10-21T01:00:00.000Z",
					outage: () => tracker.current(),
				},
			},
		});
		try {
			const res = await call("/api/app/attention");
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppAttentionResponse;
			const outage = body.items.find((i) => i.kind === "memory-outage");
			expect(outage?.title).toBe("Memory can't reach its service");
			expect(outage?.detail).toContain("1 exchange queued locally");
			expect(outage?.target).toEqual({ kind: "page", page: "memory" });
			expect(outage?.createdAt).toBe(
				new Date(tracker.current()?.startedAt ?? 0).toISOString(),
			);
			const recall = body.items.find((i) => i.kind === "memory-recall");
			expect(recall?.title).toBe("Memory can't recall");
			expect(recall?.target).toEqual({ kind: "page", page: "memory" });
			expect(recall?.createdAt).toBe("2026-10-21T01:00:00.000Z");

			// Healthy again — a save lands, a recall succeeds; both clear.
			tracker.recordSuccess();
			recallOk = true;
			const res2 = await call("/api/app/attention");
			const body2 = (await res2.json()) as AppAttentionResponse;
			expect(
				body2.items.filter(
					(i) => i.kind === "memory-outage" || i.kind === "memory-recall",
				),
			).toEqual([]);
		} finally {
			http.stop();
			memStore.close();
		}
	});

	test("a declared observation outage raises one item and clears with it", async () => {
		let resps!: import("../responsibilities.ts").ResponsibilityStore;
		const { http, call, store, projects } = setup({
			token: APP_TOKEN_NAME,
			responsibilities: (ctx) => {
				resps = openResponsibilities(ctx.store.db);
				const wakes = openWakeStore(ctx.store.db);
				const programs = openPrograms(join(ctx.home, "programs.sqlite"));
				return {
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
					listThreads: () => Promise.resolve([]),
				};
			},
		});
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = resps.create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "h1",
				understanding: {
					outcome: "o",
					situation: "s",
					nextAction: "n",
					checkpoints: [],
					completionEvidence: [],
				},
			});
			const att = resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: {
					server: "local",
					session: "op",
					agentName: "worker-1",
					paneId: "pane-7",
					terminalId: "term-9",
					agentSession: "sess-abc",
					kind: "pi",
					cwd: "/w",
				},
				baseline: {},
				cursor: {},
			});

			// Below the threshold nothing surfaces.
			resps.markUnreachable(att.attachmentId, "2030-01-01T11:00:00.000Z");
			resps.markUnreachable(att.attachmentId, "2030-01-01T11:01:00.000Z");
			let res = await call("/api/app/attention");
			let body = (await res.json()) as AppAttentionResponse;
			expect(body.items.filter((i) => i.kind === "observation-unreachable")).toEqual([]);

			// The third consecutive failure declares; the item names the
			// outage start and the responsibility's conversation.
			resps.markUnreachable(att.attachmentId, "2030-01-01T11:02:00.000Z");
			res = await call("/api/app/attention");
			body = (await res.json()) as AppAttentionResponse;
			expect(
				body.items
					.filter((i) => i.kind === "observation-unreachable")
					.map((i) => [i.id, i.title, i.createdAt, i.target]),
			).toEqual([
				[
					`observation-unreachable:${att.attachmentId}`,
					"Can't observe worker-1",
					"2030-01-01T11:00:00.000Z",
					{ kind: "conversation", conversationId: conv.id },
				],
			]);

			// A successful reconcile clears the durable state and the card.
			resps.clearUnreachable(att.attachmentId);
			res = await call("/api/app/attention");
			body = (await res.json()) as AppAttentionResponse;
			expect(body.items.filter((i) => i.kind === "observation-unreachable")).toEqual([]);
		} finally {
			http.stop();
		}
	});

	test("missing owners are explicit rather than empty state", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const res = await call("/api/app/attention");
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppAttentionResponse;
			expect(body.items).toEqual([]);
			expect(body.unavailable).toEqual([
				"approvals",
				"memory",
				"skills",
				"delegations",
				"responsibilities",
			]);
		} finally {
			http.stop();
		}
	});
});
