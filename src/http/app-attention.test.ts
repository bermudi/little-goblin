import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { HindsightClient } from "../memory/hindsight.ts";
import type { OutboxEntry } from "../mail-outbox.ts";
import type { ProgramProposal } from "../program-proposals.ts";
import type { TurnRun, TurnToolCall } from "../turn-journal.ts";
import type { ResumeOps } from "../turn-resume.ts";
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

function interruptedRun(conversationId: string): { run: TurnRun; calls: TurnToolCall[] } {
	return {
		run: {
			runId: "run-1",
			conversationId,
			epoch: 0,
			anchorSeq: null,
			steerMark: null,
			convSnapshot: null,
			toolNames: [],
			startedMs: 1,
			finishedMs: null,
			status: "interrupted",
			delivery: "pending",
			partial: null,
			loopState: null,
			ownedInputSeqs: null,
			admissionExchangeExcluded: false,
			sourceInputSeq: null,
			ownedInputSeqsUnreadable: false,
			resumeRequestSeqs: null,
			resumeRequestSeqsUnreadable: false,
			filterRetryUsed: false,
			replyLanded: false,
			createdAt: "2026-10-21T00:02:00.000Z",
			resumedFrom: null,
			calls: { planned: 0, dispatched: 1, completed: 0, failed: 0, resolved: 0 },
		},
		calls: [
			{
				runId: "run-1",
				toolCallId: "call-1",
				name: "send_file",
				args: {},
				argsHash: "h",
				state: "dispatched",
				replayed: false,
				retryConsumed: false,
				retryFromKnown: false,
				result: null,
				error: null,
				beganMs: null,
				settledMs: null,
				resolutionNote: null,
				resolvedMs: null,
			},
		],
	};
}

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
					candidate: () => proposal.draft,
					base: () => null,
					decide: async () => ({ kind: "refused", proposal, refusal: "gone" }),
				},
				mail: {
					pending: () => [draft],
					decide: async () => ({ kind: "gone" }),
				},
			},
			resumeOps: () =>
				({
					interrupted: (convId: string) =>
						convId === "app/chat-01" ? [interruptedRun(convId)] : [],
					resume: () => ({ kind: "refused", code: "not-found", reason: "no" }),
					decide: () => ({ kind: "refused", code: "not-found", reason: "no" }),
					abandon: () => ({ kind: "refused", code: "not-found", reason: "no" }),
				}) satisfies ResumeOps,
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
							cwd: "/tmp",
							task: "finish the report",
							chatId: 0,
							threadId: null,
							appConversation: "app/chat-01",
							agentName: "agent",
							workspaceId: "workspace",
							paneId: "pane",
							status: "needs_input" as const,
							target: null,
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
					skillsDir: join(dirs, "skills"),
					proposedDir: join(dirs, "skills-proposed"),
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
					["interrupted-run:run-1", { kind: "conversation", conversationId: "app/chat-01" }],
				]),
			);
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
				"responsibilities",
				"recovery",
			]);
		} finally {
			http.stop();
		}
	});
});
