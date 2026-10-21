// The Telegram half of the grant boundary: the post carries the
// complete immutable candidate (chunked, never truncated, buttons on
// the last chunk), the tap turns into the store's one-transaction
// decision, and an approved hook's URL travels only to operator DMs —
// never into a stamp, an answer, or model-facing output.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { setLogFile, setLogWriter } from "../log.ts";
import type { ProgramDraft } from "../program-proposals.ts";
import { hookTokenHash } from "../program-hook.ts";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { tmpDb } from "../testkit.ts";
import { fakeApi, type FakeApi } from "../testkit/fake-api.ts";
import {
	chunkProposalText,
	PROGRAM_APPROVE_PREFIX,
	PROGRAM_REJECT_PREFIX,
	startProgramApproval,
	type ProgramApproval,
} from "./program-approval.ts";

setLogWriter(() => {});
setLogFile(null);

const ADDRESS = { chatId: -100, threadId: 7 };
const NOW = new Date("2026-09-20T10:00:00");

function draft(overrides: Partial<ProgramDraft> = {}): ProgramDraft {
	return {
		name: "reports",
		charter: "Own the weekly report: draft it, send it, escalate when blocked.",
		cron: "0 9 * * 1",
		maxLatenessMinutes: 60,
		hook: false,
		mailFilter: null,
		...overrides,
	};
}

interface Harness {
	api: FakeApi;
	programs: ProgramsStore;
	approval: ProgramApproval;
	dms: string[];
	answers: Array<string | undefined>;
	sends: Array<{ chatId: number; text: string; other: Record<string, unknown> }>;
	stamps: string[];
	tap(userId: number, data: string): Promise<void>;
	tapBare(userId: number, data: string): Promise<void>;
	cleanup(): void;
}

function harness(
	opts: {
		publicUrl?: string;
		sendPrivate?: (text: string) => Promise<void>;
		editMessageText?: (text: string) => Promise<unknown>;
	} = {},
): Harness {
	const programs = openPrograms(tmpDb("goblin-program-approval-"));
	const dms: string[] = [];
	const answers: Array<string | undefined> = [];
	const sends: Harness["sends"] = [];
	const stamps: string[] = [];
	const api = fakeApi({
		handlers: {
			sendMessage: async (chatId: number, text: string, other?: Record<string, unknown>) => {
				sends.push({ chatId, text, other: other ?? {} });
				return { message_id: sends.length };
			},
			answerCallbackQuery: async (_id: string, other?: { text?: string }) => {
				answers.push(other?.text);
				return true;
			},
			editMessageText: async (_c: number, _m: number, text: string) => {
				if (opts.editMessageText !== undefined) return opts.editMessageText(text);
				stamps.push(text);
				return true;
			},
		},
	});
	const approval = startProgramApproval({
		api: api.api,
		programs,
		publicUrl: () => opts.publicUrl,
		sendPrivate:
			opts.sendPrivate ??
			(async (text) => {
				dms.push(text);
			}),
	});
	const tapQuery = (userId: number, data: string, withMessage: boolean) =>
		approval.handleTap({
			id: `q-${userId}`,
			data,
			from: { id: userId },
			...(withMessage ? { message: { message_id: 1, chat: { id: ADDRESS.chatId } } } : {}),
		});
	return {
		api,
		programs,
		approval,
		dms,
		answers,
		sends,
		stamps,
		tap: (userId, data) => tapQuery(userId, data, true),
		tapBare: (userId, data) => tapQuery(userId, data, false),
		cleanup: () => programs.close(),
	};
}

const approveData = (id: number) => `${PROGRAM_APPROVE_PREFIX}${id}`;
const rejectData = (id: number) => `${PROGRAM_REJECT_PREFIX}${id}`;

describe("program approval posts", () => {
	test("the post carries the complete candidate and the buttons land on the final chunk", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(
				draft({ charter: "x".repeat(5000), hook: true, mailFilter: "from:bank" }),
				ADDRESS,
				NOW,
			);
			await h.approval.requestApproval(proposal);
			expect(h.sends.length).toBeGreaterThan(1);
			const full = h.sends.map((s) => s.text).join("");
			expect(full).toContain("x".repeat(5000));
			expect(full).toContain('cron "0 9 * * 1"');
			expect(full).toContain("webhook");
			expect(full).toContain('mail filter "from:bank"');
			expect(full).toContain("at most 60m late");
			for (const [i, send] of h.sends.entries()) {
				const markup = send.other.reply_markup as
					| { inline_keyboard: Array<Array<{ callback_data: string }>> }
					| undefined;
				if (i === h.sends.length - 1) {
					const data = markup?.inline_keyboard[0]?.map((b) => b.callback_data);
					expect(data).toEqual([approveData(proposal.id), rejectData(proposal.id)]);
				} else {
					expect(markup).toBeUndefined();
				}
				expect(send.chatId).toBe(ADDRESS.chatId);
				expect(send.other.message_thread_id).toBe(ADDRESS.threadId);
			}
		} finally {
			h.cleanup();
		}
	});

	test("an update post shows the resulting configuration — the merged grant, not the diff", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "old charter", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "new charter" },
				ADDRESS,
			);
			await h.approval.requestApproval(proposal);
			const text = h.sends.map((s) => s.text).join("");
			expect(text).toContain("new charter");
			expect(text).toContain('cron "0 9 * * *"');
			expect(text).not.toContain("old charter");
			// The unstaled card carries no drift warning.
			expect(text).not.toContain("changed since this proposal");
		} finally {
			h.cleanup();
		}
	});

	test("a re-post renders the staged base — a moved program never rewrites the card", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "new charter" },
				ADDRESS,
			);
			await h.approval.requestApproval(proposal);
			// Reschedule (a direct-authority edit) and re-post via review.
			h.programs.update(program.id, { cron: "0 10 * * *" });
			h.sends.length = 0;
			await h.approval.requestApproval(h.programs.proposals.get(proposal.id)!);
			const repost = h.sends.map((s) => s.text).join("");
			// The card advertises the staged base (09:00), never today's row,
			// and names the stale refusal the tap would now get.
			expect(repost).toContain('cron "0 9 * * *"');
			expect(repost).not.toContain("0 10 * * *");
			expect(repost).toContain("changed since this proposal");
			expect(repost).toContain("new charter");
			// Restore the base and approve: what lands is exactly the shown
			// candidate — the reschedule never rode in beside the charter.
			h.programs.update(program.id, { cron: "0 9 * * *" });
			await h.tap(1, approveData(proposal.id));
			expect(h.answers[0]).toBe("approved");
			expect(h.programs.get(program.id)!.cron).toBe("0 9 * * *");
			expect(h.programs.get(program.id)!.charter).toBe("new charter");
		} finally {
			h.cleanup();
		}
	});

	test("a legacy row with a drifted base renders the coming refusal — never a merge onto today's row", async () => {
		const path = tmpDb("goblin-program-approval-");
		const programs = openPrograms(path);
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(
			program.id,
			{ charter: "new charter" },
			ADDRESS,
		);
		// Rewind the row to pre-snapshot, then drift the program: nothing
		// immutable is left to render, so the post must name the refusal.
		const db = new Database(path);
		db.query("UPDATE program_proposals SET base_snapshot = NULL WHERE id = ?").run(proposal.id);
		db.close();
		programs.update(program.id, { cron: "0 10 * * *" });
		const sends: Array<{ text: string; other: Record<string, unknown> }> = [];
		const api = fakeApi({
			handlers: {
				sendMessage: async (_chatId: number, text: string, other?: Record<string, unknown>) => {
					sends.push({ text, other: other ?? {} });
					return { message_id: sends.length };
				},
			},
		});
		const approval = startProgramApproval({
			api: api.api,
			programs,
			publicUrl: () => undefined,
			sendPrivate: async () => {},
		});
		try {
			await approval.requestApproval(programs.proposals.get(proposal.id)!);
			const text = sends.map((s) => s.text).join("");
			expect(text).toContain("changed since this proposal");
			expect(text).toContain("requested:");
			// No merged candidate off today's row: the 10:00 cron appears
			// nowhere, and there is no rendered `name:` field at all.
			expect(text).not.toContain("0 10 * * *");
			expect(text).not.toContain("name: p");
		} finally {
			programs.close();
		}
	});

	test("a stopped turn fences the posting — later chunks and the buttons never send", async () => {
		const path = tmpDb("goblin-program-approval-");
		const programs = openPrograms(path);
		const controller = new AbortController();
		const sends: Array<{ text: string; other: Record<string, unknown> }> = [];
		const api = fakeApi({
			handlers: {
				sendMessage: async (_chatId: number, text: string, other?: Record<string, unknown>) => {
					sends.push({ text, other: other ?? {} });
					// The turn dies while the first chunk's send is in flight.
					if (sends.length === 1) controller.abort();
					return { message_id: sends.length };
				},
				answerCallbackQuery: async () => true,
			},
		});
		const approval = startProgramApproval({
			api: api.api,
			programs,
			publicUrl: () => undefined,
			sendPrivate: async () => {},
		});
		try {
			const program = programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const proposal = programs.proposals.proposeUpdate(
				program.id,
				{ charter: "x".repeat(9000) },
				ADDRESS,
			);
			await expect(approval.requestApproval(proposal, controller.signal)).rejects.toThrow(
				"turn stopped",
			);
			// Exactly the one send that was already in flight; it carried no
			// buttons, and the durable row stays pending for review.
			expect(sends).toHaveLength(1);
			expect(sends[0]!.other.reply_markup).toBeUndefined();
			expect(programs.proposals.get(proposal.id)!.state).toBe("pending");
		} finally {
			programs.close();
		}
	});

	test("a notification failure propagates — the proposal stays pending for review", async () => {
		const failing = fakeApi({ failOn: (method) => method === "sendMessage" });
		const programs = openPrograms(tmpDb("goblin-program-approval-"));
		const approval = startProgramApproval({
			api: failing.api,
			programs,
			publicUrl: () => "https://g.ts.net",
			sendPrivate: async () => {},
		});
		try {
			const proposal = programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			await expect(approval.requestApproval(proposal)).rejects.toThrow();
			expect(programs.proposals.get(proposal.id)!.state).toBe("pending");
			expect(programs.list()).toEqual([]);
		} finally {
			programs.close();
		}
	});

	test("chunkProposalText never splits a surrogate pair", () => {
		const text = `a${"😀".repeat(4000)}z`;
		const chunks = chunkProposalText(text);
		for (const chunk of chunks) {
			const first = chunk.charCodeAt(0);
			const last = chunk.charCodeAt(chunk.length - 1);
			expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		}
		expect(chunks.join("").replace(/\n/g, "")).toContain("a");
	});
});

const hookDraft = () => draft({ cron: null, maxLatenessMinutes: null, hook: true });

describe("program approval taps", () => {
	test("approve activates the candidate, stamps the card, answers once", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			await h.tap(1, approveData(proposal.id));
			expect(h.programs.list()).toHaveLength(1);
			expect(h.programs.list()[0]!.charter).toBe(draft().charter);
			expect(h.answers).toEqual(["approved"]);
			expect(h.stamps).toHaveLength(1);
			expect(h.stamps[0]).toContain(`Proposal #${proposal.id} approved`);
			expect(h.stamps[0]).toContain('"reports" is active');
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("approved");
		} finally {
			h.cleanup();
		}
	});

	test("reject stamps the decision and activates nothing", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			await h.tap(1, rejectData(proposal.id));
			expect(h.programs.list()).toEqual([]);
			expect(h.answers).toEqual(["rejected"]);
			expect(h.stamps[0]).toContain("rejected");
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("rejected");
			expect(h.programs.proposals.get(proposal.id)!.decidedBy).toBe(1);
		} finally {
			h.cleanup();
		}
	});

	test("a repeated tap is a dead press — already approved, buttons stripped, one program", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			await h.tap(1, approveData(proposal.id));
			await h.tap(1, approveData(proposal.id));
			expect(h.answers).toEqual(["approved", "already approved"]);
			expect(h.programs.list()).toHaveLength(1);
			expect(h.stamps).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});

	test("a stale base refuses — the live edit stands, nothing applies", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "wider" },
				ADDRESS,
			);
			h.programs.update(program.id, { name: "edited" });
			await h.tap(1, approveData(proposal.id));
			expect(h.answers[0]).toContain("changed since this proposal");
			expect(h.programs.get(program.id)!.charter).toBe("c");
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("pending");
		} finally {
			h.cleanup();
		}
	});

	test("a deleted target refuses with guidance — the row stays pending for rejection", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "wider" },
				ADDRESS,
			);
			h.programs.remove(program.id);
			await h.tap(1, approveData(proposal.id));
			expect(h.answers[0]).toContain("program is gone");
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("pending");
		} finally {
			h.cleanup();
		}
	});

	test("a superseded proposal names its supersession", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			const first = h.programs.proposals.proposeUpdate(program.id, { charter: "v2" }, ADDRESS);
			h.programs.proposals.proposeUpdate(program.id, { charter: "v3" }, ADDRESS);
			await h.tap(1, approveData(first.id));
			expect(h.answers).toEqual(["already superseded"]);
			expect(h.programs.get(program.id)!.charter).toBe("c");
		} finally {
			h.cleanup();
		}
	});

	test("garbage callback data answers and does nothing", async () => {
		const h = harness();
		try {
			await h.tap(1, "program:bogus:1");
			expect(h.answers).toEqual(["unknown button"]);
		} finally {
			h.cleanup();
		}
	});

	test("a tap whose message is gone still decides the row", async () => {
		const h = harness();
		try {
			const proposal = h.programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			await h.tapBare(1, approveData(proposal.id));
			expect(h.programs.list()).toHaveLength(1);
			expect(h.answers).toEqual(["approved"]);
			expect(h.stamps).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	test("the tap is acknowledged before the card edit — a held stamp can't stall it", async () => {
		let releaseEdit!: () => void;
		const edits: string[] = [];
		const h = harness({
			editMessageText: (text) => {
				edits.push(text);
				return new Promise<boolean>((resolve) => {
					releaseEdit = () => resolve(true);
				});
			},
		});
		try {
			const proposal = h.programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
			const pending = h.tap(1, approveData(proposal.id));
			await new Promise((r) => setImmediate(r));
			expect(h.answers).toEqual(["approved"]);
			expect(edits).toHaveLength(1);
			expect(h.programs.list()).toHaveLength(1);
			releaseEdit();
			await pending;
		} finally {
			h.cleanup();
		}
	});

	test("approving a change to a disabled program reports it remains disabled", async () => {
		const h = harness();
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			h.programs.update(program.id, { enabled: false });
			const proposal = h.programs.proposals.proposeUpdate(
				program.id,
				{ charter: "wider" },
				ADDRESS,
			);
			await h.tap(1, approveData(proposal.id));
			expect(h.programs.get(program.id)!.enabled).toBe(false);
			expect(h.answers).toEqual(["approved"]);
			expect(h.stamps[0]).toContain('"p" remains disabled');
			expect(h.stamps[0]).not.toContain("is active");
		} finally {
			h.cleanup();
		}
	});
});

describe("program approval — hook grant", () => {
	test("an approved hook mints at grant time — the URL exists only in operator DMs", async () => {
		const h = harness({ publicUrl: "https://g.ts.net" });
		try {
			const proposal = h.programs.proposals.proposeCreate(hookDraft(), ADDRESS, NOW);
			expect(h.programs.findByHook("anything")).toBeNull();
			await h.tap(1, approveData(proposal.id));
			expect(h.answers).toEqual(["approved"]);
			expect(h.programs.list()).toHaveLength(1);
			expect(h.dms).toHaveLength(1);
			const match = /https:\/\/g\.ts\.net\/hook\/([\w-]+)/.exec(h.dms[0]!);
			expect(match).not.toBeNull();
			const token = match![1]!;
			expect(h.programs.findByHook(hookTokenHash(token))).not.toBeNull();
			// The token never reaches the group: not the approval post, not
			// the stamp, not the callback answer.
			for (const send of h.sends) expect(send.text).not.toContain(token);
			for (const stamp of h.stamps) expect(stamp).not.toContain(token);
			expect(h.stamps[0]).toContain("sent privately");
		} finally {
			h.cleanup();
		}
	});

	test("no publicUrl, no grant — the approval refuses and the proposal stays pending", async () => {
		const h = harness({});
		try {
			const proposal = h.programs.proposals.proposeCreate(hookDraft(), ADDRESS, NOW);
			await h.tap(1, approveData(proposal.id));
			expect(h.answers[0]).toContain("publicUrl");
			expect(h.programs.list()).toEqual([]);
			expect(h.programs.proposals.get(proposal.id)!.state).toBe("pending");
			expect(h.dms).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	test("stop() joins an in-flight tap through the private credential delivery", async () => {
		// The reviewer's shutdown window: activation commits, then the tap
		// awaits the callback answer and the operator DM. A graceful
		// restart must not exit inside that await — the token's plaintext
		// exists only in the handler.
		let releaseDm!: () => void;
		const parked = new Promise<void>((resolve) => {
			releaseDm = resolve;
		});
		const dms: string[] = [];
		const h = harness({
			publicUrl: "https://g.ts.net",
			sendPrivate: async (text) => {
				dms.push(text);
				await parked;
			},
		});
		try {
			const proposal = h.programs.proposals.proposeCreate(hookDraft(), ADDRESS, NOW);
			const tapping = h.tap(1, approveData(proposal.id));
			await new Promise((r) => setImmediate(r));
			// Activation landed; the DM is parked mid-delivery.
			expect(h.programs.list()).toHaveLength(1);
			expect(dms).toHaveLength(1);
			let joined = false;
			const stopping = h.approval.stop().then(() => {
				joined = true;
			});
			await new Promise((r) => setTimeout(r, 10));
			// The join waits for the tap — the drain budget owns the bound.
			expect(joined).toBe(false);
			releaseDm();
			await tapping;
			await stopping;
			expect(joined).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("a failed hook delivery reports granted-but-undelivered — the activation stands", async () => {		const h = harness({
			publicUrl: "https://g.ts.net",
			sendPrivate: async () => {
				throw new Error("couldn't DM the operator");
			},
		});
		try {
			const proposal = h.programs.proposals.proposeCreate(hookDraft(), ADDRESS, NOW);
			await h.tap(1, approveData(proposal.id));
			expect(h.programs.list()).toHaveLength(1);
			expect(h.programs.list()[0]!.hookHash).not.toBeNull();
			expect(h.stamps[0]).toContain("is active");
			expect(h.stamps[0]).toContain("could not be delivered");
			expect(h.answers).toEqual(["approved"]);
		} finally {
			h.cleanup();
		}
	});

	test("a webhook granted to a disabled program reports disabled — the URL won't answer yet", async () => {
		const h = harness({ publicUrl: "https://g.ts.net" });
		try {
			const program = h.programs.create(
				{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
				NOW,
			);
			h.programs.update(program.id, { enabled: false });
			const proposal = h.programs.proposals.proposeUpdate(program.id, { hook: true }, ADDRESS);
			await h.tap(1, approveData(proposal.id));
			expect(h.programs.get(program.id)!.enabled).toBe(false);
			expect(h.programs.get(program.id)!.hookHash).not.toBeNull();
			expect(h.dms).toHaveLength(1);
			expect(h.stamps[0]).toContain('"p" remains disabled');
			expect(h.stamps[0]).toContain("sent privately");
		} finally {
			h.cleanup();
		}
	});
});
