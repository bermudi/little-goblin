// The schedule tool's contract: jobs validate at the boundary, new
// jobs are pinned to the conversation the tool call runs in (the model
// never passes chat ids), and every action round-trips through the
// store the scheduler reads.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJobs } from "../../jobs.ts";
import { scheduleTool } from "./schedule.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function toolFor(chatId = -100, threadId: number | null = 7) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-schedtool-"));
	dirs.push(dir);
	const jobs = openJobs(join(dir, "goblin.sqlite"));
	return { jobs, tool: scheduleTool({ jobs, chatId, threadId }) };
}

const exec = (t: ReturnType<typeof scheduleTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("schedule tool", () => {
	test("create pins the live conversation's address onto the job", async () => {
		const { tool, jobs } = toolFor(-100, 7);
		const out = (await exec(tool, {
			action: "create",
			name: "morning brief",
			cron: "30 8 * * 1-5",
			prompt: "brief me on the day",
		})) as { job: { chat_id: number; thread_id: number; next_run: string } };
		expect(out.job.chat_id).toBe(-100);
		expect(out.job.thread_id).toBe(7);
		expect(new Date(out.job.next_run).getTime()).toBeGreaterThan(Date.now());
		expect(jobs.list()).toHaveLength(1);
	});

	test("an invalid cron is a tool error — no row exists", async () => {
		const { tool, jobs } = toolFor();
		const out = (await exec(tool, {
			action: "create",
			name: "x",
			cron: "61 8 * * *",
			prompt: "p",
		})) as { error: string };
		expect(out.error).toContain("invalid cron");
		expect(jobs.list()).toEqual([]);
	});

	test("a dm conversation pins without a thread id", async () => {
		const { tool, jobs } = toolFor(42, null);
		await exec(tool, { action: "create", name: "x", cron: "0 9 * * *", prompt: "p" });
		const job = jobs.list()[0]!;
		expect(job.chatId).toBe(42);
		expect(job.threadId).toBeNull();
	});

	test("list/update/toggle/delete round-trip", async () => {
		const { tool, jobs } = toolFor();
		const created = (await exec(tool, {
			action: "create",
			name: "x",
			cron: "0 9 * * *",
			prompt: "p",
		})) as { job: { id: number } };

		const listed = (await exec(tool, { action: "list" })) as {
			jobs: Array<{ id: number; name: string }>;
		};
		expect(listed.jobs).toHaveLength(1);

		const updated = (await exec(tool, {
			action: "update",
			id: created.job.id,
			prompt: "p2",
		})) as { job: { prompt: string } };
		expect(updated.job.prompt).toBe("p2");

		const toggled = (await exec(tool, { action: "toggle", id: created.job.id })) as {
			job: { enabled: boolean };
		};
		expect(toggled.job.enabled).toBe(false);

		const gone = (await exec(tool, { action: "delete", id: created.job.id })) as {
			deleted: number;
		};
		expect(gone.deleted).toBe(created.job.id);
		expect(jobs.list()).toEqual([]);
	});

	test("actions on a missing job are errors, not throws", async () => {
		const { tool } = toolFor();
		const del = (await exec(tool, { action: "delete", id: 99 })) as { error: string };
		const upd = (await exec(tool, { action: "update", id: 99, prompt: "x" })) as {
			error: string;
		};
		expect(del.error).toContain("no job 99");
		expect(upd.error).toContain("no job 99");
	});
});
