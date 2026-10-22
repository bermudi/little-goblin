import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../conversation.ts";
import { z } from "zod";
import { hookTokenHash } from "../../program-hook.ts";
import type { ProgramProposal } from "../../program-proposals.ts";
import { makePrivateSender, programInputSchema, programTool } from "./program.ts";
import { openPrograms, type ProgramsStore } from "../../programs.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function toolFor(
	chatId = -100,
	threadId: number | null = 7,
	publicUrl?: string,
	opts: { operatorIds?: number[]; sendError?: string; approvalError?: string } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
	dirs.push(dir);
	const programs = openPrograms(join(dir, "goblin.sqlite"));
	const store = openStore(join(dir, "conv.sqlite"));
	const sent: Array<{ chatId: number; text: string }> = [];
	const approvals: ProgramProposal[] = [];
	let posts = 0;
	const tool = programTool({
		programs,
		chatId,
		threadId,
		publicUrl: () => publicUrl,
		sendPrivate: makePrivateSender(
			async (chatId, text) => {
				if (opts.sendError) throw new Error(opts.sendError);
				sent.push({ chatId, text });
			},
			() => opts.operatorIds ?? [42],
		),
		requestApproval: async (proposal) => {
			// A post failure fires once — the review path's repost succeeds.
			posts++;
			if (opts.approvalError && posts === 1) throw new Error(opts.approvalError);
			approvals.push(proposal);
		},
	});
	return { programs, store, sent, approvals, tool };
}

const exec = (t: ReturnType<typeof programTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

// Approving through the store is the operator-tap's store half — the
// full callback path lives in tg/program-approval.test.ts.
const grant = (
	programs: ProgramsStore,
	proposal: { id: number },
	hookHash?: string,
): ReturnType<ProgramsStore["get"]> => {
	const outcome = programs.proposals.approve(
		proposal.id,
		42,
		hookHash === undefined ? {} : { hookHash },
	);
	if (outcome.kind !== "activated") throw new Error(`approval refused: ${outcome.refusal}`);
	return outcome.program;
};

describe("program tool", () => {
	test("provider sees an object schema; missing action arguments still fail validation", () => {
		const wire = z.toJSONSchema(programInputSchema);
		expect(wire.type).toBe("object");
		expect(wire.properties?.action).toEqual({
			type: "string",
			enum: ["list", "create", "update", "delete", "toggle", "hook", "review"],
		});
		expect(wire.required).toContain("action");
		expect(programInputSchema.safeParse({}).success).toBe(false);
		expect(programInputSchema.safeParse({ action: "create" }).success).toBe(false);
		expect(programInputSchema.safeParse({ action: "create", name: "x" }).success).toBe(false);
		expect(
			programInputSchema.safeParse({ action: "create", name: "x", charter: "y", cron: null })
				.success,
		).toBe(false);
		expect(
			programInputSchema.safeParse({ action: "create", name: "x", charter: "y" }).success,
		).toBe(true);
		expect(programInputSchema.safeParse({ action: "update", id: 1, cron: null }).success).toBe(
			true,
		);
		expect(
			programInputSchema.safeParse({
				action: "create",
				name: "x",
				charter: "y",
				cron: "0 9 * * *",
				maxLatenessMinutes: 30,
			}).success,
		).toBe(true);
		expect(
			programInputSchema.safeParse({ action: "update", id: 1, maxLatenessMinutes: null }).success,
		).toBe(true);
		expect(
			programInputSchema.safeParse({
				action: "create",
				name: "x",
				charter: "y",
				cron: "0 9 * * *",
				maxLatenessMinutes: -1,
			}).success,
		).toBe(false);
		expect(
			programInputSchema.safeParse({
				action: "update",
				id: 1,
				maxLatenessMinutes: 1.5,
			}).success,
		).toBe(false);
		expect(programInputSchema.safeParse({ action: "toggle", id: 3 }).success).toBe(true);
		expect(programInputSchema.safeParse({ action: "review", id: 3 }).success).toBe(true);
		// Grant is the operator's tap — there is deliberately no
		// model-side approve action or approved flag.
		expect(programInputSchema.safeParse({ action: "approve", id: 3 }).success).toBe(false);
		expect(
			programInputSchema.safeParse({ action: "create", name: "x", charter: "y", approved: true })
				.success,
		).toBe(false);
	});

	test("create stages a pending proposal — nothing activates before the operator approves", async () => {
		const { tool, programs, approvals } = toolFor();
		const out = (await exec(tool, {
			action: "create",
			name: "morning brief",
			charter: "brief me on the day",
			cron: "30 8 * * 1-5",
			maxLatenessMinutes: 45,
		})) as Record<string, unknown> & { proposal: { id: number; kind: string; state: string } };
		expect(out).toHaveProperty("proposal");
		expect(out).not.toHaveProperty("program");
		expect(out).toMatchObject({ status: expect.stringContaining("pending") });
		expect(out.proposal).toMatchObject({ kind: "create", state: "pending" });
		// No active row, and no trigger path can reach it.
		expect(programs.list()).toEqual([]);
		expect(programs.due(new Date("2999-01-01"))).toEqual([]);
		expect(programs.withMailFilter()).toEqual([]);
		expect(approvals.map((p) => p.id)).toEqual([out.proposal.id]);
		// The approval post carried the staged row; approving it creates
		// exactly the shown candidate at the pinned address.
		const program = grant(programs, out.proposal)!;
		expect(program).toMatchObject({
			name: "morning brief",
			charter: "brief me on the day",
			cron: "30 8 * * 1-5",
			maxLatenessMinutes: 45,
			chatId: -100,
			threadId: 7,
			enabled: true,
		});
		expect(program.nextRun).not.toBeNull();
	});

	test("a charter update leaves the live charter intact until approved", async () => {
		const { tool, programs } = toolFor();
		const seeded = programs.create({
			name: "x",
			charter: "original",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "update",
			id: seeded.id,
			charter: "rewritten",
		})) as Record<string, unknown> & { proposal: { id: number } };
		expect(out).toHaveProperty("proposal");
		expect(out).not.toHaveProperty("program");
		expect(programs.get(seeded.id)!.charter).toBe("original");
		const program = grant(programs, out.proposal)!;
		expect(program.charter).toBe("rewritten");
	});

	test("a staged update carries its entire requested patch — no partial application", async () => {
		const { tool, programs } = toolFor();
		const seeded = programs.create({
			name: "old name",
			charter: "original",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "update",
			id: seeded.id,
			name: "new name",
			charter: "new charter",
		})) as { proposal: { id: number; request: Record<string, unknown> } };
		expect(out.proposal.request).toEqual({ name: "new name", charter: "new charter" });
		// Even the approval-free half of the patch waits for the tap.
		const live = programs.get(seeded.id)!;
		expect(live.name).toBe("old name");
		expect(live.charter).toBe("original");
		const program = grant(programs, out.proposal)!;
		expect(program).toMatchObject({ name: "new name", charter: "new charter" });
	});

	test("safe edits stay direct: reschedule, rename, lateness, identical charter, trigger removal", async () => {
		const { tool, programs, approvals } = toolFor();
		const seeded = programs.create({
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "existing-hook",
			address: { chatId: -100, threadId: 7 },
		});
		for (const input of [
			{ action: "update", id: seeded.id, cron: "0 10 * * *" },
			{ action: "update", id: seeded.id, name: "renamed" },
			{ action: "update", id: seeded.id, maxLatenessMinutes: 30 },
			{ action: "update", id: seeded.id, charter: "c" },
			{ action: "update", id: seeded.id, cron: null },
		]) {
			const out = (await exec(tool, input)) as { program?: { id: number }; error?: string };
			expect(out.error).toBeUndefined();
			expect(out.program?.id).toBe(seeded.id);
		}
		const live = programs.get(seeded.id)!;
		expect(live).toMatchObject({ name: "renamed", cron: null, maxLatenessMinutes: 30 });
		expect(approvals).toEqual([]);
	});

	test("trigger-kind additions and a changed non-null mail filter stage", async () => {
		const { tool, programs, approvals } = toolFor();
		const cronOnly = programs.create({
			name: "a",
			charter: "c",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const staged = (await exec(tool, {
			action: "update",
			id: cronOnly.id,
			mailFilter: "from:bank",
		})) as { proposal: { id: number; kind: string } };
		expect(staged.proposal.kind).toBe("update");
		expect(programs.get(cronOnly.id)!.mailFilter).toBeNull();

		const hookOnly = programs.create({
			name: "b",
			charter: "c",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const stagedCron = (await exec(tool, {
			action: "update",
			id: hookOnly.id,
			cron: "0 9 * * *",
		})) as { proposal: { id: number; kind: string } };
		expect(stagedCron.proposal.kind).toBe("update");
		expect(programs.get(hookOnly.id)!.cron).toBeNull();

		grant(programs, staged.proposal);
		const filtered = programs.get(cronOnly.id)!;
		expect(filtered.mailFilter).toBe("from:bank");
		const changed = (await exec(tool, {
			action: "update",
			id: cronOnly.id,
			mailFilter: "from:bank is:important",
		})) as { proposal: { id: number; kind: string } };
		expect(changed.proposal.kind).toBe("update");
		expect(programs.get(cronOnly.id)!.mailFilter).toBe("from:bank");
		expect(approvals).toHaveLength(3);
	});

	test("create pins the live conversation's address onto the program", async () => {
		const { tool, programs } = toolFor(-100, 7);
		const out = (await exec(tool, {
			action: "create",
			name: "morning brief",
			charter: "brief me on the day",
			cron: "30 8 * * 1-5",
			maxLatenessMinutes: 45,
		})) as { proposal: { id: number; request: Record<string, unknown> } };
		expect(out.proposal.request).not.toHaveProperty("chat_id");
		expect(out.proposal.request).not.toHaveProperty("thread_id");
		const program = grant(programs, out.proposal)!;
		expect(new Date(program.nextRun!).getTime()).toBeGreaterThan(Date.now());
		expect(program.maxLatenessMinutes).toBe(45);
		expect(programs.list()).toHaveLength(1);
		expect(programs.list()[0]).toMatchObject({ chatId: -100, threadId: 7 });
	});

	test("an app turn pins the app conversation target onto the proposal and program", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
		dirs.push(dir);
		const programs = openPrograms(join(dir, "goblin.sqlite"));
		const approvals: ProgramProposal[] = [];
		const tool = programTool({
			programs,
			target: "app/chat-01",
			publicUrl: () => undefined,
			sendPrivate: async () => {},
			requestApproval: async (proposal) => {
				approvals.push(proposal);
			},
		});
		const out = (await exec(tool, {
			action: "create",
			name: "app brief",
			charter: "brief the app",
			cron: "30 8 * * 1-5",
		})) as { proposal: { id: number } };
		expect(approvals[0]?.target).toBe("app/chat-01");
		const program = grant(programs, out.proposal)!;
		expect(program.target).toBe("app/chat-01");
		expect(program.chatId).toBe(0);
		expect(program.threadId).toBeNull();
		programs.close();
	});

	test("an invalid cron is a tool error — no row and no proposal exists", async () => {
		const { tool, programs } = toolFor();
		const out = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "61 8 * * *",
		})) as { error: string };
		expect(out.error).toContain("invalid cron");
		expect(programs.list()).toEqual([]);
		expect(programs.proposals.list()).toEqual([]);
	});

	test("a dm conversation pins without a thread id", async () => {
		const { tool, programs } = toolFor(42, null);
		const out = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
		})) as { proposal: { id: number } };
		const program = grant(programs, out.proposal)!;
		expect(program.chatId).toBe(42);
		expect(program.threadId).toBeNull();
	});

	test("list shows active programs and pending proposals separately", async () => {
		const { tool, programs } = toolFor();
		const seeded = programs.create({
			name: "live",
			charter: "c",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const staged = (await exec(tool, {
			action: "create",
			name: "pending one",
			charter: "c",
			cron: "0 9 * * *",
		})) as { proposal: { id: number } };
		const listed = (await exec(tool, { action: "list" })) as {
			programs: Array<{ id: number; name: string }>;
			proposals: Array<{ id: number; name?: string; state: string }>;
		};
		expect(listed.programs.map((p) => p.id)).toEqual([seeded.id]);
		expect(listed.proposals.map((p) => p.id)).toEqual([staged.proposal.id]);
		// Decided proposals leave the pending list.
		grant(programs, staged.proposal);
		const relisted = (await exec(tool, { action: "list" })) as {
			programs: Array<{ id: number }>;
			proposals: Array<{ id: number }>;
		};
		expect(relisted.programs).toHaveLength(2);
		expect(relisted.proposals).toEqual([]);
	});

	test("name/cron update, toggle and delete round-trip on an approved program", async () => {
		const { tool, programs } = toolFor();
		const created = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
		})) as { proposal: { id: number } };
		const program = grant(programs, created.proposal)!;

		const updated = (await exec(tool, {
			action: "update",
			id: program.id,
			name: "renamed",
			cron: "0 10 * * *",
		})) as { program: { name: string; cron: string } };
		expect(updated.program).toMatchObject({ name: "renamed", cron: "0 10 * * *" });

		const toggled = (await exec(tool, { action: "toggle", id: program.id })) as {
			program: { enabled: boolean };
		};
		expect(toggled.program.enabled).toBe(false);
		for (const view of [updated.program, toggled.program]) {
			expect(Object.keys(view!).sort()).toEqual([
				"charter",
				"cron",
				"enabled",
				"has_hook",
				"id",
				"last_run",
				"mail_filter",
				"max_lateness_minutes",
				"name",
				"next_run",
			]);
		}

		const gone = (await exec(tool, { action: "delete", id: program.id })) as {
			deleted: number;
		};
		expect(gone.deleted).toBe(program.id);
		expect(programs.list()).toEqual([]);
	});

	test("actions on a missing program or proposal are errors, not throws", async () => {
		const { tool } = toolFor();
		const del = (await exec(tool, { action: "delete", id: 99 })) as { error: string };
		const upd = (await exec(tool, { action: "update", id: 99, charter: "x" })) as {
			error: string;
		};
		const rev = (await exec(tool, { action: "review", id: 99 })) as { error: string };
		const hook = (await exec(tool, { action: "hook", id: 99, op: "enable" })) as {
			error: string;
		};
		expect(del.error).toContain("no program 99");
		expect(upd.error).toContain("no program 99");
		expect(rev.error).toContain("no proposal 99");
		expect(hook.error).toContain("no program 99");
	});

	test("invalid update cron leaves the stored program unchanged and stages nothing", async () => {
		const { tool, programs } = toolFor();
		const program = programs.create({
			name: "x",
			cron: "0 9 * * *",
			charter: "c",
			address: { chatId: -100, threadId: 7 },
		});
		expect(
			await exec(tool, {
				action: "update",
				id: program.id,
				name: "changed",
				cron: "61 8 * * *",
			}),
		).toEqual({ error: expect.stringContaining("invalid cron") });
		expect(programs.get(program.id)).toEqual(program);
		expect(programs.proposals.list()).toEqual([]);
	});

	test("lateness override can be set and cleared; hook-only programs cannot have one", async () => {
		const { tool, programs } = toolFor(-100, 7, "https://goblin.example");
		const seeded = programs.create({
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		expect(seeded.maxLatenessMinutes).toBeNull();

		const limited = (await exec(tool, {
			action: "update",
			id: seeded.id,
			maxLatenessMinutes: 15,
		})) as { program: { max_lateness_minutes: number } };
		expect(limited.program.max_lateness_minutes).toBe(15);

		const reset = (await exec(tool, {
			action: "update",
			id: seeded.id,
			maxLatenessMinutes: null,
		})) as { program: { max_lateness_minutes: null } };
		expect(reset.program.max_lateness_minutes).toBeNull();

		const hookOnly = programs.create({
			name: "hook",
			charter: "c",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const refused = await exec(tool, {
			action: "update",
			id: hookOnly.id,
			maxLatenessMinutes: 10,
		});
		expect(refused).toEqual({ error: "maxLatenessMinutes requires a cron trigger" });
	});

	test("update validates before storage and propagates storage failures", async () => {
		const { tool, programs } = toolFor();
		programs.close();
		expect(
			await exec(tool, {
				action: "update",
				id: 1,
				cron: "61 8 * * *",
			}),
		).toEqual({ error: expect.stringContaining("invalid cron") });
		await expect(
			exec(tool, {
				action: "update",
				id: 1,
				cron: "0 9 * * *",
			}),
		).rejects.toThrow();
	});

	test("a storage failure that merely sounds like a rule violation propagates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
		dirs.push(dir);
		const store = openPrograms(join(dir, "goblin.sqlite"));
		const seeded = store.create({
			name: "x",
			cron: "0 9 * * *",
			charter: "c",
			address: { chatId: -100, threadId: 7 },
		});
		const failing = {
			...store,
			update: (): never => {
				throw new Error(
					"sqlite: disk full — maxLatenessMinutes requires a cron trigger, a program needs at least one trigger",
				);
			},
		};
		const tool = programTool({
			programs: failing,
			chatId: -100,
			threadId: 7,
			publicUrl: () => undefined,
			sendPrivate: async () => {},
			requestApproval: async () => {},
		});
		await expect(
			exec(tool, { action: "update", id: seeded.id, cron: "0 10 * * *", maxLatenessMinutes: 5 }),
		).rejects.toThrow("disk full");
		store.close();
	});

	test("a mail filter alone is a trigger; clearing the last one is refused", async () => {
		const { tool, programs } = toolFor();
		const staged = (await exec(tool, {
			action: "create",
			name: "bank watch",
			charter: "flag bank mail",
			mailFilter: "from:bank is:important",
		})) as { proposal: { id: number } };
		const program = grant(programs, staged.proposal)!;
		expect(program.mailFilter).toBe("from:bank is:important");
		expect(program.nextRun).toBeNull();
		expect(programs.withMailFilter()).toHaveLength(1);

		const cleared = (await exec(tool, {
			action: "update",
			id: program.id,
			mailFilter: null,
		})) as { error: string };
		expect(cleared.error).toContain("at least one trigger");
		expect(programs.get(program.id)!.mailFilter).toBe("from:bank is:important");
	});

	test("hook enable on a hookless program stages a proposal — no credential exists before approval", async () => {
		const { tool, programs, approvals } = toolFor(-100, 7, "https://goblin.ts.net/");
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "hook",
			id: seeded.id,
			op: "enable",
		})) as { proposal: { id: number; request: Record<string, unknown> } };
		expect(out.proposal.request).toEqual({ hook: true });
		expect(programs.get(seeded.id)!.hookHash).toBeNull();
		expect(approvals).toHaveLength(1);
		// The approval adapter mints the token and injects the hash —
		// exercised end to end in tg/program-approval.test.ts.
		const program = grant(programs, out.proposal, hookTokenHash("minted-token"))!;
		expect(program.hookHash).toBe(hookTokenHash("minted-token"));
	});

	test("hook rotation on an existing hook stays direct and private; the token never reaches the model", async () => {
		const { tool, programs, store, sent } = toolFor(-100, 7, "https://goblin.ts.net/");
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: hookTokenHash("old-token"),
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "hook",
			id: seeded.id,
			op: "rotate",
		})) as { hook: string; url_sent: boolean };
		expect(out).toEqual({ hook: "rotated", url_sent: true });
		expect(sent).toHaveLength(1);
		const url = sent[0]!.text.match(/https:\/\/goblin\.ts\.net\/hook\/(\S+)/);
		expect(url).not.toBeNull();
		const token = url![1]!;
		expect(programs.get(seeded.id)!.hookHash).toBe(hookTokenHash(token));
		expect(programs.findByHook(hookTokenHash(token))!.id).toBe(seeded.id);
		expect(programs.findByHook(hookTokenHash("old-token"))).toBeNull();
		expect(JSON.stringify(out)).not.toContain(token);
		for (const m of store.history("topic:-100:7")) {
			expect(JSON.stringify(m)).not.toContain(token);
		}
		expect(sent[0]!.text).toContain("Keep it secret");
	});

	test("a disabled Telegram lane refuses rotation before the stored credential can change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
		dirs.push(dir);
		const programs = openPrograms(join(dir, "goblin.sqlite"));
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "old-hash",
			address: { chatId: -100, threadId: 7 },
		});
		const tool = programTool({
			programs,
			target: "app/chat-01",
			publicUrl: () => "https://g.ts.net",
			requestApproval: async () => {},
		});
		expect(await exec(tool, { action: "hook", id: seeded.id, op: "rotate" })).toEqual({
			error:
				"telegram channel is disabled — rotate or reveal the hook from Programs in the app instead",
		});
		expect(programs.get(seeded.id)!.hookHash).toBe("old-hash");
		programs.close();
	});

	test("hook rotation DMs every operator, never the topic chat", async () => {
		const { tool, programs, sent } = toolFor(-100, 7, "https://g.ts.net", {
			operatorIds: [42, 7],
		});
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "hook",
			id: seeded.id,
			op: "rotate",
		})) as { hook: string; url_sent: boolean };
		expect(out).toEqual({ hook: "rotated", url_sent: true });
		expect(sent.map((s) => s.chatId)).toEqual([42, 7]);
	});

	test("all DMs failing on a rotation is an error — hook stays set, token unseen", async () => {
		const { tool, programs, sent } = toolFor(-100, 7, "https://g.ts.net", {
			operatorIds: [42, 7],
			sendError: "chat not found",
		});
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "hook",
			id: seeded.id,
			op: "rotate",
		})) as { error: string };
		expect(out.error).toContain("couldn't DM");
		expect(out.error).toContain("rotate");
		expect(programs.get(seeded.id)!.hookHash).not.toBeNull();
		expect(JSON.stringify(out)).not.toContain("/hook/");
		expect(sent).toEqual([]);
	});

	test("hook disable reduces authority — direct; on a cron-less program it refuses", async () => {
		const { tool, programs } = toolFor(-100, 7, "https://g.ts.net");
		const hooked = programs.create({
			name: "a",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const off = (await exec(tool, { action: "hook", id: hooked.id, op: "disable" })) as {
			program: { has_hook: boolean };
		};
		expect(off.program.has_hook).toBe(false);
		expect(programs.get(hooked.id)!.hookHash).toBeNull();

		const cronless = programs.create({
			name: "b",
			charter: "c",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const refused = (await exec(tool, { action: "hook", id: cronless.id, op: "disable" })) as {
			error: string;
		};
		expect(refused.error).toContain("at least one trigger");
		expect(programs.get(cronless.id)!.hookHash).toBe("h");
	});

	test("hook rotate needs publicUrl — unset is an error, no row change", async () => {
		const { tool, programs, sent } = toolFor(-100, 7);
		const seeded = programs.create({
			name: "ci",
			charter: "c",
			cron: "0 9 * * *",
			hookHash: "h",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(tool, {
			action: "hook",
			id: seeded.id,
			op: "rotate",
		})) as { error: string };
		expect(out.error).toContain("publicUrl");
		expect(programs.get(seeded.id)!.hookHash).toBe("h");
		expect(sent).toEqual([]);
	});

	test("a failed approval post keeps the proposal pending with review guidance", async () => {
		const { tool, programs, approvals } = toolFor(-100, 7, undefined, {
			approvalError: "telegram down",
		});
		const out = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
		})) as { proposal: { id: number; state: string }; error: string };
		expect(out.proposal.state).toBe("pending");
		expect(out.error).toContain(`proposal #${out.proposal.id}`);
		expect(out.error).toContain("review");
		expect(programs.list()).toEqual([]);
		expect(programs.proposals.pending().map((p) => p.id)).toEqual([out.proposal.id]);
		expect(approvals).toEqual([]);

		// Delivery recovered — review re-posts the SAME proposal.
		approvals.length = 0;
		const reposted = (await exec(tool, { action: "review", id: out.proposal.id })) as {
			proposal: { id: number };
			status: string;
		};
		expect(reposted.proposal.id).toBe(out.proposal.id);
		expect(reposted.status).toContain("pending");
		expect(approvals.map((p) => p.id)).toEqual([out.proposal.id]);
	});

	test("review on a decided proposal reports its state without reposting", async () => {
		const { tool, programs, approvals } = toolFor();
		const staged = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
		})) as { proposal: { id: number } };
		expect(programs.proposals.reject(staged.proposal.id, 42).kind).toBe("rejected");
		const out = (await exec(tool, { action: "review", id: staged.proposal.id })) as {
			proposal: { id: number; state: string };
			status: string;
		};
		expect(out.proposal.state).toBe("rejected");
		expect(out.status).toContain("rejected");
		expect(approvals).toHaveLength(1); // only the original post
	});
});
