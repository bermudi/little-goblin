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
import { openWakeStore } from "../wake-store.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppAttentionResponse } from "./app-wire.ts";
import { storeFence } from "../testkit/store-fence.ts";

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
					pending: () => [proposal, { ...proposal, id: 8, target: "dm:99" }],
					candidate: () => proposal.draft!,
					base: () => null,
					decide: async () => ({ kind: "refused", proposal, refusal: "gone" }),
				},
				mail: {
					pending: () => [draft, { ...draft, id: 10, target: "topic:-100:3" }],
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
							createdAt: "2026-10-21T00:02:30.000Z",
							finishedAt: null,
						},
						{
							id: 4,
							name: "worker without chat",
							harness: "pi",
							cwd: "/tmp",
							task: "wait for a decision",
							chatId: 0,
							threadId: null,
							appConversation: null,
							agentName: "g1-worker-2",
							workspaceId: "w2",
							paneId: "w2:p1",
							status: "needs_input" as const,
							baselineSeq: null,
							promptedAt: "2026-10-21T00:04:00.000Z",
							promptPending: false,
							createdAt: "2026-10-21T00:03:30.000Z",
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
			expect(body.unavailable).toEqual([]);
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
					["program-approval:8", { kind: "page", page: "programs" }],
					["mail-approval:9", { kind: "page", page: "programs" }],
					["mail-approval:10", { kind: "page", page: "programs" }],
					["memory-blocked:HTTP 401", { kind: "page", page: "memory" }],
					["memory-blocked:HTTP 500", { kind: "page", page: "memory" }],
					["skill-proposal:radar", { kind: "page", page: "skills" }],
					["skill-proposal:watcher", { kind: "page", page: "skills" }],
					["delegation-input:3", { kind: "conversation", conversationId: "app/chat-01" }],
					["delegation-input:4", { kind: "page", page: "delegations" }],
				]),
			);
			expect(new Map(body.items.map((i) => [i.id, i.conversationId]))).toEqual(
				new Map([
					["program-approval:7", "app/chat-01"],
					["program-approval:8", null],
					["mail-approval:9", "app/chat-01"],
					["mail-approval:10", null],
					["memory-blocked:HTTP 401", null],
					["memory-blocked:HTTP 500", null],
					["skill-proposal:radar", null],
					["skill-proposal:watcher", null],
					["delegation-input:3", "app/chat-01"],
					["delegation-input:4", null],
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
			]);
		} finally {
			http.stop();
		}
	});
});
