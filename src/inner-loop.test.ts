import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setLogFile } from "./log.ts";
import {
	defaultBase,
	INNER_LOOP_DEFAULT,
	innerLoopBranch,
	innerLoopMessage,
	runGit,
	startInnerLoop,
} from "./inner-loop.ts";
import type { T3StartInput } from "./t3.ts";
import { tmpDir } from "./testkit.ts";

setLogFile(null);

async function clonedRepo(): Promise<string> {
	const root = tmpDir();
	const origin = join(root, "origin.git");
	const seed = join(root, "seed");
	const clone = join(root, "clone");
	await runGit(root, ["init", "-q", "--bare", "-b", "trunk", origin]);
	await runGit(root, ["init", "-q", "-b", "trunk", seed]);
	await runGit(seed, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "seed"]);
	await runGit(seed, ["push", "-q", origin, "trunk"]);
	await runGit(root, ["clone", "-q", origin, clone]);
	return clone;
}

describe("inner loop start", () => {
	test("starts the T3 thread in a fresh worktree from the fetched default branch", async () => {
		const dir = await clonedRepo();
		const starts: T3StartInput[] = [];
		const out = await startInnerLoop(
			{
				git: runGit,
				t3: {
					startThread: async (input) => {
						starts.push(input);
						return { threadId: "t-1", projectId: "p-1", runId: "r-1" };
					},
				},
			},
			{
				projectDir: dir,
				brief: "fix the bug",
				branch: "issue/7",
				issue: { repository: "owner/repo", number: 7 },
				model: INNER_LOOP_DEFAULT,
			},
		);
		expect(out).toMatchObject({ threadId: "t-1", base: "origin/trunk", branch: "issue/7" });
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({
			project: dir,
			provider: "claudeAgent",
			model: "claude-opus-5-5",
			worktree: "origin/trunk",
			branch: "issue/7",
		});
		expect(starts[0]?.message).toStartWith("fix the bug\n");
		expect(starts[0]?.message).toContain("Closes #7");
		expect(starts[0]?.message).toContain("Checked-SHA:");
	});

	test("a repo without a known default branch fails loud with the fix", async () => {
		const dir = await clonedRepo();
		await runGit(dir, ["remote", "set-head", "origin", "--delete"]);
		await expect(defaultBase(runGit, dir)).rejects.toThrow("remote set-head origin --auto");
	});

	test("branch names default to the issue, and a brief without an issue is sent as is", () => {
		expect(innerLoopBranch({ repository: "o/r", number: 12 }, undefined)).toBe("issue/12");
		expect(innerLoopBranch(undefined, "feat/x")).toBe("feat/x");
		expect(() => innerLoopBranch(undefined, undefined)).toThrow("needs a branch");
		expect(innerLoopMessage("just this", undefined)).toBe("just this");
	});
});
