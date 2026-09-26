// The program tool's contract: cron validates at the boundary, new
// programs are pinned to the conversation the tool call runs in (the
// model never passes chat ids), and every action round-trips through
// the store the scheduler reads.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrograms } from "../../programs.ts";
import { programTool } from "./program.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function toolFor(chatId = -100, threadId: number | null = 7) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-programtool-"));
	dirs.push(dir);
	const programs = openPrograms(join(dir, "goblin.sqlite"));
	return { programs, tool: programTool({ programs, chatId, threadId }) };
}

const exec = (t: ReturnType<typeof programTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("program tool", () => {
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
				"charter", "cron", "enabled", "id", "last_run", "name", "next_run",
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
});
