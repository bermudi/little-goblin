import { describe, expect, test } from "bun:test";
import { appAddress } from "../conversation.ts";
import { makeAppMailLane, presentProgramApproval } from "../app-approvals.ts";
import { startMailApproval, type MailApproval } from "../mail-approval.ts";
import { openOutbox } from "../mail-outbox.ts";
import type { MailSender } from "../mail.ts";
import { startProgramApproval, type ProgramApproval } from "../program-approval.ts";
import type { ProgramDraft } from "../program-proposals.ts";
import { openPrograms } from "../programs.ts";
import { APP_ACTOR, telegramActor, telegramTarget } from "../targets.ts";
import { tmpDb } from "../testkit.ts";
import { fakeApi } from "../testkit/fake-api.ts";
import { startTelegramMailApproval } from "../tg/mail-approval.ts";
import { startTelegramProgramApproval } from "../tg/program-approval.ts";
import type { AppApprovalDecisionResponse, AppApprovalsResponse } from "./app-wire.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

const NOW = new Date("2026-10-21T10:00:00Z");

const draft = (overrides: Partial<ProgramDraft> = {}): ProgramDraft => ({
	name: "reports",
	charter: "Own the weekly report.",
	cron: "0 9 * * 1",
	maxLatenessMinutes: 60,
	hook: false,
	mailFilter: null,
	...overrides,
});

const lane = {
	present: async () => ({ kind: "posted", messageId: null, surface: "test" }) as const,
	notice: async () => {},
	settle: async () => {},
	strip: async () => {},
};

function harness(opts: { publicUrl?: string; sender?: MailSender } = {}) {
	const programs = openPrograms(tmpDb("goblin-app-approvals-"));
	const outbox = openOutbox(tmpDb("goblin-app-approvals-"));
	const sent: unknown[] = [];
	const mail: MailApproval = startMailApproval(
		{
			outbox,
			sender: () =>
				opts.sender ?? {
					send: async (mailDraft) => {
						sent.push(mailDraft);
						return { id: `sent-${sent.length}`, threadId: "thread-1" };
					},
				},
			reader: () => null,
			lanes: { app: lane, telegram: lane },
			now: () => NOW,
		},
		60_000,
	);
	const program: ProgramApproval = startProgramApproval({
		programs,
		publicUrl: () => opts.publicUrl,
		present: async () => {},
	});
	const app = setup({
		token: APP_TOKEN_NAME,
		approvals: { program, mail },
	});
	return { ...app, programs, outbox, program, mail, sent };
}

async function cleanup(h: ReturnType<typeof harness>): Promise<void> {
	h.http.stop();
	await h.mail.stop();
	h.programs.close();
	h.outbox.close();
}

describe("app approval routes", () => {
	test("the pending list carries the complete program candidate and mail draft", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(
				draft({ hook: true, mailFilter: "from:bank" }),
				{ target: "app/chat-01" },
				NOW,
			);
			const row = h.outbox.queue(
				{
					to: ["a@x.com"],
					cc: ["b@y.com"],
					subject: "hi",
					body: "hello",
					address: { target: "app/chat-01" },
				},
				NOW,
			);
			const res = await h.call("/api/app/approvals");
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-store");
			const body = (await res.json()) as AppApprovalsResponse;
			expect(body.programs).toHaveLength(1);
			expect(body.programs[0]).toMatchObject({
				id: proposal.id,
				target: "app/chat-01",
				state: "pending",
				candidate: {
					name: "reports",
					charter: "Own the weekly report.",
					cron: "0 9 * * 1",
					hook: true,
					mailFilter: "from:bank",
				},
			});
			expect(body.mail).toHaveLength(1);
			expect(body.mail[0]).toMatchObject({
				id: row.id,
				to: ["a@x.com"],
				cc: ["b@y.com"],
				subject: "hi",
				body: "hello",
				target: "app/chat-01",
				status: "pending",
			});
		} finally {
			await cleanup(h);
		}
	});

	test("a program approval activates once through the app door and reveals the hook only there", async () => {
		const h = harness({ publicUrl: "https://g.ts.net" });
		try {
			const proposal = h.programs.proposals.proposeCreate(
				draft({ cron: null, maxLatenessMinutes: null, hook: true }),
				{ target: "app/chat-01" },
				NOW,
			);
			const res = await h.call(`/api/app/approvals/program/${proposal.id}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "approve" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as AppApprovalDecisionResponse;
			expect(body.status).toBe("activated");
			expect(body.hookUrl).toMatch(/^https:\/\/g\.ts\.net\/hook\//);
			expect(h.programs.list()).toHaveLength(1);
			expect(h.programs.proposals.get(proposal.id)).toMatchObject({
				state: "approved",
				decidedBy: APP_ACTOR,
			});
			const again = await h.call(`/api/app/approvals/program/${proposal.id}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "approve" }),
			});
			const second = (await again.json()) as AppApprovalDecisionResponse;
			expect(second).toMatchObject({ status: "refused" });
			expect(second.hookUrl).toBeUndefined();
			expect(h.programs.list()).toHaveLength(1);
		} finally {
			await cleanup(h);
		}
	});

	test("a hook approval without publicUrl stays pending and answers 422", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(
				draft({ cron: null, maxLatenessMinutes: null, hook: true }),
				{ target: "app/chat-01" },
				NOW,
			);
			const res = await h.call(`/api/app/approvals/program/${proposal.id}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "approve" }),
			});
			expect(res.status).toBe(422);
			expect(await res.json()).toMatchObject({ status: "needs-public-url" });
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("pending");
			expect(h.programs.list()).toEqual([]);
		} finally {
			await cleanup(h);
		}
	});

	test("a stale update refuses and keeps the live edit", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{
					name: "p",
					charter: "old",
					cron: "0 9 * * *",
					address: { target: "app/chat-01" },
				},
				NOW,
			);
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "wider" },
				{ target: "app/chat-01" },
				NOW,
			);
			h.programs.update(program.id, { name: "edited" });
			const res = await h.call(`/api/app/approvals/program/${proposal.id}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "approve" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ status: "refused" });
			expect(h.programs.get(program.id)).toMatchObject({ name: "edited", charter: "old" });
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("pending");
		} finally {
			await cleanup(h);
		}
	});

	test("the app and Telegram doors race one proposal to exactly one grant", async () => {
		const h = harness();
		const answers: Array<string | undefined> = [];
		const api = fakeApi({
			handlers: {
				answerCallbackQuery: async (_id: string, opts?: { text?: string }) => {
					answers.push(opts?.text);
					return true;
				},
				editMessageReplyMarkup: async () => true,
				editMessageText: async () => true,
			},
		});
		const telegram = startTelegramProgramApproval({
			api: api.api,
			approval: h.program,
			programs: h.programs,
			sendPrivate: async () => {},
		});
		try {
			const proposal = h.programs.proposals.proposeCreate(
				draft(),
				{ target: telegramTarget(-100, 7) },
				NOW,
			);
			const [res] = await Promise.all([
				h.call(`/api/app/approvals/program/${proposal.id}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "approve" }),
				}),
				telegram.handleTap({
					id: "q-1",
					data: `program:approve:${proposal.id}`,
					from: { id: 7 },
					message: { message_id: 50, chat: { id: -100 } },
				}),
			]);
			const body = (await res.json()) as AppApprovalDecisionResponse;
			expect(["activated", "refused"]).toContain(body.status);
			expect(h.programs.list()).toHaveLength(1);
			const decided = h.programs.proposals.get(proposal.id)!;
			expect(decided.state).toBe("approved");
			expect(decided.decidedBy === APP_ACTOR || decided.decidedBy === telegramActor(7)).toBe(true);
			expect(decided.activatedId).not.toBeNull();
			expect(h.programs.list()[0]!.id).toBe(decided.activatedId!);
			expect(answers.length).toBe(1);
		} finally {
			await cleanup(h);
		}
	});

	test("the app and Telegram doors race one draft to exactly one send", async () => {
		const h = harness();
		const api = fakeApi({
			handlers: {
				answerCallbackQuery: async () => true,
				editMessageReplyMarkup: async () => true,
				editMessageText: async () => true,
			},
		});
		const telegram = startTelegramMailApproval({ api: api.api, approval: h.mail });
		try {
			const row = h.outbox.queue(
				{
					to: ["a@x.com"],
					subject: "hi",
					body: "hello",
					address: { target: "app/chat-01" },
				},
				NOW,
			);
			const [res] = await Promise.all([
				h.call(`/api/app/approvals/mail/${row.id}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "send" }),
				}),
				telegram.handleTap({
					id: "q-mail",
					data: `mail:send:${row.id}`,
					from: { id: 7 },
					message: { message_id: 60, chat: { id: -100 } },
				}),
			]);
			const body = (await res.json()) as AppApprovalDecisionResponse;
			expect(["sent", "busy", "settled"]).toContain(body.status);
			expect(h.sent).toHaveLength(1);
			expect(h.outbox.get(row.id)).toMatchObject({
				status: "sent",
				sentId: "sent-1",
			});
			const decidedBy = h.outbox.get(row.id)!.decidedBy;
			expect(decidedBy === APP_ACTOR || decidedBy === telegramActor(7)).toBe(true);
		} finally {
			await cleanup(h);
		}
	});

	test("app presentation writes durable approval markers to the conversation transcript", async () => {
		const h = harness();
		try {
			h.store.resolve(appAddress("chat-01"), "/w");
			const proposal = h.programs.proposals.proposeCreate(
				draft(),
				{ target: "app/chat-01" },
				NOW,
			);
			presentProgramApproval(h.store, proposal);
			const row = h.outbox.queue(
				{
					to: ["a@x.com"],
					subject: "hi",
					body: "hello",
					address: { target: "app/chat-01" },
				},
				NOW,
			);
			await makeAppMailLane(h.store).present(row);
			const parts = h.store
				.history("app/chat-01")
				.flatMap((message) => message.parts)
				.filter((part) => part.type === "data-approval");
			expect(parts).toEqual([
				{ type: "data-approval", data: { kind: "program", id: proposal.id } },
				{ type: "data-approval", data: { kind: "mail", id: row.id } },
			]);
		} finally {
			await cleanup(h);
		}
	});

	test("missing approval wiring answers 503, not a transport fallback", async () => {
		const h = setup({ token: APP_TOKEN_NAME });
		try {
			expect((await h.call("/api/app/approvals")).status).toBe(503);
			const res = await h.call("/api/app/approvals/program/1", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "approve" }),
			});
			expect(res.status).toBe(503);
		} finally {
			h.http.stop();
		}
	});
});
