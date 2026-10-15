// The durable run table: create/update round-trip, the sandbox-lease
// view the reaper and reset consult, the recovery/notice scans, and
// the lifecycle-note write the worker tools read back.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSubagentRuns, type SubagentRuns } from "./subagent-runs.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];

function open(): { runs: SubagentRuns; dbPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "goblin-runs-"));
	dirs.push(dir);
	const dbPath = join(dir, "goblin.sqlite");
	const runs = openSubagentRuns(dbPath);
	stores.push(runs);
	return { runs, dbPath };
}

afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("subagent_runs store", () => {
	test("create → get → listFor; ids are positive autoincrement", () => {
		const { runs } = open();
		const a = runs.create({
			kind: "worker",
			conversationId: "conv:a",
			workspace: "/ws/a",
			task: "do a",
		});
		const b = runs.create({
			kind: "computer",
			conversationId: "conv:b",
			workspace: "/ws/b",
			desktop: "d1",
			task: "do b",
			files: ["f.txt"],
			requestId: "req-1",
		});
		expect(a.id).toBeGreaterThan(0);
		expect(b.id).toBeGreaterThan(a.id);
		expect(a.status).toBe("queued");
		expect(b.desktop).toBe("d1");
		expect(b.files).toEqual(["f.txt"]);
		expect(b.requestId).toBe("req-1");
		expect(runs.get(a.id)?.task).toBe("do a");
		expect(runs.listFor("conv:a").map((r) => r.id)).toEqual([a.id]);
		expect(runs.get(9999)).toBeNull();
	});

	test("update is sparse, bumps updated_at, round-trips every field", () => {
		const { runs } = open();
		const row = runs.create({
			kind: "worker",
			conversationId: "conv:a",
			workspace: "/ws",
			task: "t",
		});
		const bumped = runs.update(row.id, {
			status: "running",
			piConversationId: "7",
			piSubmissionId: "9",
			inbox: ["/inbox/subagents/1/f.txt"],
			inputRev: 3,
			inputIntent: "do more",
			lifecycleNote: "recreated",
		});
		expect(bumped.status).toBe("running");
		expect(bumped.piConversationId).toBe("7");
		expect(bumped.inputRev).toBe(3);
		expect(bumped.inputIntent).toBe("do more");
		expect(bumped.inbox).toEqual(["/inbox/subagents/1/f.txt"]);
		expect(bumped.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
		const done = runs.update(row.id, {
			status: "done",
			result: "finished",
			exportedFiles: ["subagents/1/out.txt"],
			exportErrors: ["refused: x"],
			finalScreenshot: null,
			noticePending: true,
			finishedAt: 1234,
			inputIntent: null,
			lifecycleNote: null,
		});
		expect(done.result).toBe("finished");
		expect(done.exportedFiles).toEqual(["subagents/1/out.txt"]);
		expect(done.exportErrors).toEqual(["refused: x"]);
		expect(done.inputIntent).toBeNull();
		expect(done.lifecycleNote).toBeNull();
		expect(done.noticePending).toBe(true);
		expect(done.finishedAt).toBe(1234);
	});

	test("workerLease: live worker statuses hold, terminal/computer do not", () => {
		const { runs } = open();
		expect(runs.workerLease("conv:a")).toBeNull();
		const w = runs.create({
			kind: "worker",
			conversationId: "conv:a",
			workspace: "/ws",
			task: "t",
		});
		expect(runs.workerLease("conv:a")).toEqual({ id: w.id, status: "queued" });
		runs.update(w.id, { status: "needs_input" });
		// needs_input keeps the sandbox lease even though the global
		// slot freed.
		expect(runs.workerLease("conv:a")).toEqual({ id: w.id, status: "needs_input" });
		runs.update(w.id, { status: "done" });
		expect(runs.workerLease("conv:a")).toBeNull();
		const c = runs.create({
			kind: "computer",
			conversationId: "conv:a",
			workspace: "/ws",
			desktop: "d1",
			task: "t",
		});
		expect(runs.workerLease("conv:a")).toBeNull();
		void c;
	});

	test("unfinished and pendingNotices drive recovery and scan retry", () => {
		const { runs } = open();
		const a = runs.create({ kind: "worker", conversationId: "c1", workspace: "/w", task: "t" });
		const b = runs.create({ kind: "worker", conversationId: "c2", workspace: "/w", task: "t" });
		runs.update(a.id, { status: "running" });
		runs.update(b.id, { status: "stopped", noticePending: true });
		expect(runs.unfinished().map((r) => r.id)).toEqual([a.id]);
		expect(runs.pendingNotices().map((r) => r.id)).toEqual([b.id]);
		runs.update(b.id, { noticePending: false });
		expect(runs.pendingNotices()).toEqual([]);
	});

	test("noteLifecycle lands on the live worker holder only", () => {
		const { runs } = open();
		runs.noteLifecycle("conv:a", "nobody home"); // no rows — a no-op
		const w = runs.create({ kind: "worker", conversationId: "conv:a", workspace: "/w", task: "t" });
		const other = runs.create({
			kind: "worker",
			conversationId: "conv:b",
			workspace: "/w",
			task: "t",
		});
		runs.noteLifecycle("conv:a", "sandbox was recreated");
		expect(runs.get(w.id)?.lifecycleNote).toBe("sandbox was recreated");
		expect(runs.get(other.id)?.lifecycleNote).toBeNull();
		// Terminal runs stop carrying the note.
		runs.update(w.id, { status: "done" });
		runs.noteLifecycle("conv:a", "again");
		expect(runs.get(w.id)?.lifecycleNote).toBe("sandbox was recreated");
	});

	test("byPiConversation and rows survive reopen", () => {
		const { runs, dbPath } = open();
		const row = runs.create({
			kind: "computer",
			conversationId: "conv:a",
			workspace: "/w",
			desktop: "d1",
			task: "t",
		});
		runs.update(row.id, { piConversationId: "42", status: "running" });
		expect(runs.byPiConversation("42")?.id).toBe(row.id);
		expect(runs.byPiConversation("nope")).toBeNull();
		runs.close();
		stores.pop();
		const again = openSubagentRuns(dbPath);
		stores.push(again);
		expect(again.get(row.id)?.status).toBe("running");
		expect(again.unfinished().map((r) => r.id)).toEqual([row.id]);
	});
});
