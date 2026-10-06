// The program tool's contract: cron validates at the boundary, new
// programs are pinned to the conversation the tool call runs in (the
// model never passes chat ids), and every action round-trips through
// the store the scheduler reads.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../conversation.ts";
import { z } from "zod";
import { hookTokenHash, makePrivateSender, programInputSchema, programTool } from "./program.ts";
import { openPrograms } from "../../programs.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function toolFor(
	chatId = -100,
	threadId: number | null = 7,
	publicUrl?: string,
	opts: { operatorIds?: number[]; sendError?: string } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
	dirs.push(dir);
	const programs = openPrograms(join(dir, "goblin.sqlite"));
	const store = openStore(join(dir, "conv.sqlite"));
	const sent: Array<{ chatId: number; text: string }> = [];
	const tool = programTool({
		programs,
		chatId,
		threadId,
		publicUrl: () => publicUrl,
		// The real dep: DMs to each operator id, bare api.sendMessage —
		// it goes to Telegram only and never writes the conversation
		// store, so the token can't become model context next turn.
		sendPrivate: makePrivateSender(
			async (chatId, text) => {
				if (opts.sendError) throw new Error(opts.sendError);
				sent.push({ chatId, text });
			},
			() => opts.operatorIds ?? [42],
		),
	});
	return { programs, store, sent, tool };
}

const exec = (t: ReturnType<typeof programTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("program tool", () => {
	test("provider sees an object schema; missing action arguments still fail validation", () => {
		const wire = z.toJSONSchema(programInputSchema);
		expect(wire.type).toBe("object");
		expect(wire.properties?.action).toEqual({
			type: "string",
			enum: ["list", "create", "update", "delete", "toggle", "hook"],
		});
		expect(wire.required).toContain("action");
		expect(programInputSchema.safeParse({}).success).toBe(false);
		expect(programInputSchema.safeParse({ action: "create" }).success).toBe(false);
		expect(programInputSchema.safeParse({ action: "create", name: "x" }).success).toBe(false);
		// null only clears on update — never on create.
		expect(
			programInputSchema.safeParse({ action: "create", name: "x", charter: "y", cron: null })
				.success,
		).toBe(false);
		expect(
			programInputSchema.safeParse({ action: "create", name: "x", charter: "y" }).success,
		).toBe(true);
		expect(programInputSchema.safeParse({ action: "update", id: 1, cron: null }).success).toBe(true);
		expect(programInputSchema.safeParse({ action: "toggle", id: 3 }).success).toBe(true);
	});
	test("create pins the live conversation's address onto the program", async () => {
		const { tool, programs } = toolFor(-100, 7);
		const out = (await exec(tool, {
			action: "create",
			name: "morning brief",
			charter: "brief me on the day",
			cron: "30 8 * * 1-5",
		})) as { program: { next_run: string } };
		expect(out.program).not.toHaveProperty("chat_id");
		expect(out.program).not.toHaveProperty("thread_id");
		expect(new Date(out.program.next_run).getTime()).toBeGreaterThan(Date.now());
		expect(programs.list()).toHaveLength(1);
		expect(programs.list()[0]).toMatchObject({ chatId: -100, threadId: 7 });
	});

	test("an invalid cron is a tool error — no row exists", async () => {
		const { tool, programs } = toolFor();
		const out = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "61 8 * * *",
		})) as { error: string };
		expect(out.error).toContain("invalid cron");
		expect(programs.list()).toEqual([]);
	});

	test("a dm conversation pins without a thread id", async () => {
		const { tool, programs } = toolFor(42, null);
		await exec(tool, { action: "create", name: "x", charter: "c", cron: "0 9 * * *" });
		const program = programs.list()[0]!;
		expect(program.chatId).toBe(42);
		expect(program.threadId).toBeNull();
	});

	test("list/update/toggle/delete round-trip", async () => {
		const { tool, programs } = toolFor();
		const created = (await exec(tool, {
			action: "create",
			name: "x",
			charter: "c",
			cron: "0 9 * * *",
		})) as { program: { id: number } };

		const listed = (await exec(tool, { action: "list" })) as {
			programs: Array<{ id: number; name: string }>;
		};
		expect(listed.programs).toHaveLength(1);

		const updated = (await exec(tool, {
			action: "update",
			id: created.program.id,
			charter: "c2",
		})) as { program: { charter: string } };
		expect(updated.program.charter).toBe("c2");

		const toggled = (await exec(tool, { action: "toggle", id: created.program.id })) as {
			program: { enabled: boolean };
		};
		expect(toggled.program.enabled).toBe(false);
		for (const view of [listed.programs[0], updated.program, toggled.program]) {
			expect(Object.keys(view!).sort()).toEqual([
				"charter", "cron", "enabled", "has_hook", "id", "last_run", "mail_filter", "name", "next_run",
			]);
		}

		const gone = (await exec(tool, { action: "delete", id: created.program.id })) as {
			deleted: number;
		};
		expect(gone.deleted).toBe(created.program.id);
		expect(programs.list()).toEqual([]);
	});

	test("actions on a missing program are errors, not throws", async () => {
		const { tool } = toolFor();
		const del = (await exec(tool, { action: "delete", id: 99 })) as { error: string };
		const upd = (await exec(tool, { action: "update", id: 99, charter: "x" })) as {
			error: string;
		};
		expect(del.error).toContain("no program 99");
		expect(upd.error).toContain("no program 99");
	});

	test("invalid update cron leaves the stored program unchanged", async () => {
		const { tool, programs } = toolFor();
		const program = programs.create({
			name: "x", cron: "0 9 * * *", charter: "c",
			address: { chatId: -100, threadId: 7 },
		});
		expect(await exec(tool, {
			action: "update", id: program.id, name: "changed", cron: "61 8 * * *",
		})).toEqual({ error: expect.stringContaining("invalid cron") });
		expect(programs.get(program.id)).toEqual(program);
	});

	test("update validates before storage and propagates storage failures", async () => {
		const { tool, programs } = toolFor();
		programs.close();
		expect(await exec(tool, {
			action: "update", id: 1, cron: "61 8 * * *",
		})).toEqual({ error: expect.stringContaining("invalid cron") });
		await expect(exec(tool, {
			action: "update", id: 1, cron: "0 9 * * *",
		})).rejects.toThrow();
	});

	test("a mail filter alone is a trigger; clearing the last one is refused", async () => {
		const { tool, programs } = toolFor();
		const created = (await exec(tool, {
			action: "create",
			name: "bank watch",
			charter: "flag bank mail",
			mailFilter: "from:bank is:important",
		})) as { program: { id: number; mail_filter: string; next_run: null } };
		expect(created.program.mail_filter).toBe("from:bank is:important");
		expect(created.program.next_run).toBeNull();
		expect(programs.withMailFilter()).toHaveLength(1);

		const cleared = (await exec(tool, {
			action: "update", id: created.program.id, mailFilter: null,
		})) as { error: string };
		expect(cleared.error).toContain("at least one trigger");
		expect(programs.get(created.program.id)!.mailFilter).toBe("from:bank is:important");
	});

	test("hook enable sends the URL privately; the token never reaches the model", async () => {
		const { tool, programs, store, sent } = toolFor(-100, 7, "https://goblin.ts.net/");
		const created = (await exec(tool, {
			action: "create", name: "ci", charter: "c", cron: "0 9 * * *",
		})) as { program: { id: number } };

		const out = (await exec(tool, {
			action: "hook", id: created.program.id, op: "enable",
		})) as { hook: string; url_sent: boolean };
		expect(out).toEqual({ hook: "enabled", url_sent: true });

		// The operator-facing text carries a URL whose token hashes to the
		// stored hash — and it's the only place the token exists.
		expect(sent).toHaveLength(1);
		const url = sent[0]!.text.match(/https:\/\/goblin\.ts\.net\/hook\/(\S+)/);
		expect(url).not.toBeNull();
		const token = url![1]!;
		expect(programs.get(created.program.id)!.hookHash).toBe(hookTokenHash(token));
		expect(programs.findByHook(hookTokenHash(token))!.id).toBe(created.program.id);

		// The token is in neither the tool result nor the conversation
		// history (history is what the model reads next turn).
		expect(JSON.stringify(out)).not.toContain(token);
		for (const m of store.history("topic:-100:7")) {
			expect(JSON.stringify(m)).not.toContain(token);
		}
		expect(sent[0]!.text).toContain("Keep it secret");
	});

	test("hook enable DMs every operator, never the topic chat", async () => {
		// The tool ran in a group topic (-100/7) — the credential must
		// reach each operator's private chat and nothing else.
		const { tool, sent } = toolFor(-100, 7, "https://g.ts.net", {
			operatorIds: [42, 7],
		});
		const created = (await exec(tool, {
			action: "create", name: "ci", charter: "c", cron: "0 9 * * *",
		})) as { program: { id: number } };
		const out = (await exec(tool, {
			action: "hook", id: created.program.id, op: "enable",
		})) as { hook: string; url_sent: boolean };
		expect(out).toEqual({ hook: "enabled", url_sent: true });
		expect(sent.map((s) => s.chatId)).toEqual([42, 7]);
	});

	test("all DMs failing is an error — hook stays set, token unseen", async () => {
		const { tool, programs, sent } = toolFor(-100, 7, "https://g.ts.net", {
			operatorIds: [42, 7],
			sendError: "chat not found",
		});
		const created = (await exec(tool, {
			action: "create", name: "ci", charter: "c", cron: "0 9 * * *",
		})) as { program: { id: number } };
		const out = (await exec(tool, {
			action: "hook", id: created.program.id, op: "enable",
		})) as { error: string };
		expect(out.error).toContain("couldn't DM");
		expect(out.error).toContain("rotate");
		// The hook is live — rotate is the resend path — and nothing
		// URL-shaped reached the model.
		expect(programs.get(created.program.id)!.hookHash).not.toBeNull();
		expect(JSON.stringify(out)).not.toContain("/hook/");
		expect(sent).toEqual([]);
	});

	test("hook rotate replaces the credential; disable on a cron-less program refuses", async () => {
		const { tool, programs, sent } = toolFor(-100, 7, "https://g.ts.net");
		// Hook-only program — the hook is its only trigger.
		const created = (await exec(tool, {
			action: "create", name: "ci", charter: "c", hook: true,
		})) as { program: { id: number } };
		expect(sent).toHaveLength(1);
		const oldToken = sent[0]!.text.match(/\/hook\/(\S+)/)![1]!;
		expect(programs.get(created.program.id)!.cron).toBeNull();
		expect(programs.get(created.program.id)!.nextRun).toBeNull();

		const rotated = (await exec(tool, {
			action: "hook", id: created.program.id, op: "rotate",
		})) as { hook: string; url_sent: boolean };
		expect(rotated).toEqual({ hook: "rotated", url_sent: true });
		const newToken = sent[1]!.text.match(/\/hook\/(\S+)/)![1]!;
		expect(newToken).not.toBe(oldToken);
		// The old credential is dead at the store level.
		expect(programs.findByHook(hookTokenHash(oldToken))).toBeNull();

		// Disabling the only trigger refuses — the invariant holds at the
		// tool boundary too.
		const refused = (await exec(tool, {
			action: "hook", id: created.program.id, op: "disable",
		})) as { error: string };
		expect(refused.error).toContain("at least one trigger");
		expect(programs.get(created.program.id)!.hookHash).toBe(hookTokenHash(newToken));
	});

	test("hook needs publicUrl — unset is an error, no row change", async () => {
		const { tool, programs, sent } = toolFor(-100, 7); // no publicUrl
		const created = (await exec(tool, {
			action: "create", name: "ci", charter: "c", cron: "0 9 * * *",
		})) as { program: { id: number } };
		const out = (await exec(tool, {
			action: "hook", id: created.program.id, op: "enable",
		})) as { error: string };
		expect(out.error).toContain("publicUrl");
		expect(programs.get(created.program.id)!.hookHash).toBeNull();
		expect(sent).toEqual([]);
	});
});
