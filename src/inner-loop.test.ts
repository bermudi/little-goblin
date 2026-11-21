import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import {
	defaultBase,
	INNER_LOOP_DEFAULT,
	innerLoopBranch,
	innerLoopMessage,
	makeInnerLoopStarts,
	runGit,
	startInnerLoop,
	type InnerLoopDeps,
	type InnerLoopStart,
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
	function rig(dir: string) {
		const starts: T3StartInput[] = [];
		const deps: InnerLoopDeps = {
			git: runGit,
			starts: makeInnerLoopStarts(openStore(join(tmpDir(), "goblin.sqlite")).db),
			t3: {
				startThread: async (input) => {
					starts.push(input);
					return { threadId: `t-${starts.length}`, projectId: "p-1", runId: "r-1" };
				},
			},
		};
		const input: InnerLoopStart = {
			handoverKey: "h1",
			authorize: () => {},
			projectDir: dir,
			brief: "fix the bug",
			branch: "issue/7",
			pr: { issue: { repository: "owner/repo", number: 7 }, checks: ["verify", "build"] },
			model: INNER_LOOP_DEFAULT,
		};
		return { starts, deps, input };
	}

	test("starts the T3 thread in a fresh worktree from the fetched default branch", async () => {
		const dir = await clonedRepo();
		const { starts, deps, input } = rig(dir);
		const out = await startInnerLoop(deps, input);
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
		expect(starts[0]?.message).toContain("the required commit checks verify, build must pass on it");
		expect(starts[0]?.message).not.toContain("PASS");
	});

	test("a retried handover reuses the thread it already started", async () => {
		const dir = await clonedRepo();
		const { starts, deps, input } = rig(dir);
		const first = await startInnerLoop(deps, input);
		const again = await startInnerLoop(deps, input);
		expect(again).toEqual(first);
		expect(starts).toHaveLength(1);
		await startInnerLoop(deps, { ...input, handoverKey: "h2", branch: "issue/7-b" });
		expect(starts).toHaveLength(2);
	});

	test("authority lost during the git work starts nothing", async () => {
		const dir = await clonedRepo();
		const { starts, deps, input } = rig(dir);
		const fenced = startInnerLoop(deps, {
			...input,
			authorize: () => {
				throw new Error("conversation fenced");
			},
		});
		await expect(fenced).rejects.toThrow("conversation fenced");
		expect(starts).toHaveLength(0);
		expect(deps.starts.get("h1")).toBeNull();
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
		const ciOnly = innerLoopMessage("b", { issue: { repository: "o/r", number: 12 }, checks: [] });
		expect(ciOnly).toContain("Code watches that PR's current head commit: CI must pass on it.");
	});
});
