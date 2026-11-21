// Live drift check: pins the real `t3` CLI's (T3 Code) wire behavior
// for the four verbs goblin uses — argv flags, JSON result shapes,
// and the thread-gone error sentences the adapter matches.
//     GOBLIN_T3_LIVE=1 bun test src/t3.live.test.ts
// Run it after a t3 upgrade; red means the interface moved: re-pin
// the shapes here (one probe), then fix src/t3.ts.
//
// Store safety: reading existing threads is fine, but nothing here
// ever starts or sends in the operator's real projects. The one
// started thread lives in a throwaway project created for the run:
// `t3 project add` over a temp git dir, removed again with
// `t3 project remove --force` (the flag is required once the project
// has threads; the workspace dir must still exist at remove time, so
// the temp dir is deleted only after removal succeeded). The started
// run itself is a single cheap turn on the operator-designated test
// model (repo AGENTS.md: gpt-6-luna on the codex provider).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { T3Error, makeT3 } from "./t3.ts";
import { setLogFile } from "./log.ts";

const LIVE = process.env.GOBLIN_T3_LIVE === "1";
const PROVIDER = "codex";
const MODEL = "gpt-6-luna";
// Read-only listing target: the operator's real checkout. Only `list`
// ever touches it — the pinned shapes are the same everywhere.
const READ_PROJECT = "/home/daniel/build/little-goblin";

const cli = (args: string[]): string =>
	execSync(["t3", ...args].join(" "), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe.skipIf(!LIVE)("t3 live wire", () => {
	let projectDir: string;
	const t3 = makeT3();

	beforeAll(() => {
		setLogFile("t3-live.log");
		projectDir = mkdtempSync(join(tmpdir(), "t3-drift-"));
		execSync("git init -q .", { cwd: projectDir });
		cli(["project", "add", projectDir]);
	});

	afterAll(() => {
		// Remove before trashing the dir: the CLI wants the workspace
		// path to exist. --force is required once the project has
		// threads. A failure here fails the run — a leaked throwaway
		// project is cleanup the operator should not have to find.
		if (projectDir === undefined) return;
		try {
			cli(["project", "remove", projectDir, "--force"]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("list reads an existing project without side effects", async () => {
		const rows = await t3.listThreads(READ_PROJECT);
		expect(Array.isArray(rows)).toBe(true);
		for (const row of rows) {
			expect(typeof row.threadId).toBe("string");
			expect(typeof row.status).toBe("string");
			expect(typeof row.link).toBe("string");
		}
	});

	test("start pins the {threadId, projectId, runId} shape", async () => {
		const started = await t3.startThread({
			project: projectDir,
			message:
				"This is a goblin wire-contract probe. Reply with the single word: probe-ack. Do nothing else.",
			provider: PROVIDER,
			model: MODEL,
			title: "goblin drift check",
		});
		// Thread ids are `mcp:<uuid>` on this server.
		expect(started.threadId).toMatch(/^mcp:[0-9a-f-]+$/i);
		expect(started.projectId).toMatch(/^[a-z0-9-]+$/i);
		// Run ids are namespaced URIs of the thread's ordinal runs.
		expect(started.runId).toMatch(/^run:thread:/);
	});

	test("show returns the thread record and messages with runIds", async () => {
		const started = await t3.startThread({
			project: projectDir,
			message: "Probe two. Reply with: probe-ack-2",
			provider: PROVIDER,
			model: MODEL,
		});
		const shown = await t3.showThread(started.threadId, 10);
		expect(shown).not.toBeNull();
		expect(shown!.thread.threadId).toBe(started.threadId);
		expect(shown!.thread.status).toBeTruthy();
		expect(Array.isArray(shown!.messages)).toBe(true);
		// The user turn carries our run id — the attribution the
		// watcher's verdict keys on.
		expect(shown!.messages.some((m) => m.runId === started.runId)).toBe(true);
	});

	test("send returns {threadId, link, messageId, runId, status, delivery}", async () => {
		const started = await t3.startThread({
			project: projectDir,
			message: "Probe three. Reply with: probe-ack-3",
			provider: PROVIDER,
			model: MODEL,
		});
		const sent = await t3.sendThread(started.threadId, "Follow-up probe. Reply with: probe-ack-3b");
		expect(sent.threadId).toBe(started.threadId);
		expect(sent.link).toBeTruthy();
		expect(sent.messageId).toBeTruthy();
		expect(sent.runId).toBeTruthy();
		expect(sent.status).toBeTruthy();
		expect(sent.delivery).toBeTruthy();
	});

	test("show of a missing thread resolves null", async () => {
		await expect(t3.showThread("definitely-not-a-thread-id", 1)).resolves.toBeNull();
	});

	test("send to a missing thread fails with thread_not_found", async () => {
		const err = await t3
			.sendThread("definitely-not-a-thread-id", "x")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(T3Error);
		expect((err as T3Error).code).toBe("thread_not_found");
	});

	test("a worktree start from the remote default branch is listed at once with its worktree", async () => {
		const origin = mkdtempSync(join(tmpdir(), "t3-drift-origin-"));
		try {
			execSync("git -c user.name=probe -c user.email=probe@example.invalid commit -q --allow-empty -m seed", { cwd: projectDir });
			const branch = execSync("git symbolic-ref --short HEAD", { cwd: projectDir, encoding: "utf8" }).trim();
			execSync(`git init -q --bare ${JSON.stringify(origin)}`);
			execSync(`git remote add origin ${JSON.stringify(origin)}`, { cwd: projectDir });
			execSync(`git push -q origin ${branch}`, { cwd: projectDir });
			execSync("git remote set-head origin --auto", { cwd: projectDir });
			const base = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", { cwd: projectDir, encoding: "utf8" }).trim();
			expect(base).toBe(`origin/${branch}`);
			const started = await t3.startThread({
				project: projectDir,
				message: "Probe four. Reply with: probe-ack-4",
				provider: PROVIDER,
				model: MODEL,
				worktree: base,
				branch: "goblin-drift/worktree",
			});
			const row = (await t3.listThreads(projectDir)).find((t) => t.threadId === started.threadId);
			expect(row).toBeDefined();
			expect(row?.worktreePath).toBeTruthy();
			expect(row?.worktreePath).not.toBe(projectDir);
		} finally {
			rmSync(origin, { recursive: true, force: true });
		}
	});

	test("list of the throwaway project sees its threads", async () => {
		const rows = await t3.listThreads(projectDir);
		expect(rows.length).toBeGreaterThanOrEqual(3);
	});
});
