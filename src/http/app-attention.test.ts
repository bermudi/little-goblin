import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
			sourceInputSeq: null,
			ownedInputSeqsUnreadable: false,
			resumeRequestSeqs: null,
			resumeRequestSeqsUnreadable: false,
			filterRetryUsed: false,
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
		const { http, call } = setup({
			token: APP_TOKEN_NAME,
			approvals: {
				program: {
					pending: () => [proposal],
					candidate: () => proposal.draft,
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
					blockedDetail: () => [
						{ document: "exchange/app/chat-01/1/a", error: "HTTP 429", attempts: 1 },
					],
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
							agentName: "agent",
							workspaceId: "workspace",
							paneId: "pane",
							status: "needs_input" as const,
							target: null,
							baselineSeq: null,
							promptedAt: "2026-10-21T00:03:00.000Z",
							promptPending: false,
							createdAt: "2026-10-21T00:02:30.000Z",
							finishedAt: null,
						},
					],
					active: () => [],
				},
				skillSources: {
					forConversation: () => [],
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
			expect(body.unavailable).toEqual([]);
			expect(new Map(body.items.map((i) => [i.id, i.target]))).toEqual(
				new Map([
					["program-approval:7", { kind: "page", page: "programs" }],
					["mail-approval:9", { kind: "page", page: "programs" }],
					["memory-blocked:exchange/app/chat-01/1/a", { kind: "page", page: "memory" }],
					["skill-proposal:watcher", { kind: "page", page: "skills" }],
					["delegation-input:3", { kind: "conversation", conversationId: "app/chat-01" }],
					["interrupted-run:run-1", { kind: "conversation", conversationId: "app/chat-01" }],
				]),
			);
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
				"recovery",
			]);
		} finally {
			http.stop();
		}
	});
});
