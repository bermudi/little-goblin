import { log } from "./log.ts";
import type { GithubIssue } from "./pr-readiness.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import type { T3, T3StartResult } from "./t3.ts";

export interface InnerLoopModel {
	provider: string;
	model: string;
	options?: Readonly<Record<string, string | boolean>> | undefined;
}

export const INNER_LOOP_DEFAULT: InnerLoopModel = { provider: "claudeAgent", model: "claude-opus-5-5" };

export interface InnerLoopStart {
	projectDir: string;
	brief: string;
	branch: string;
	issue?: GithubIssue | undefined;
	model: InnerLoopModel;
}

export interface InnerLoopDeps {
	t3: Pick<T3, "startThread">;
	git(dir: string, args: string[]): Promise<string>;
}

export interface InnerLoopThread extends T3StartResult {
	base: string;
	branch: string;
}

export const VERIFIER_CONTRACT = [
	"Verifier contract: the verifier's PR comment opens with PASS, PASS+NOTES or FAIL",
	"and has exactly one standalone line `Checked-SHA: <full 40-character lowercase commit SHA>`.",
	"Post a new verdict for each checked head. PASS+NOTES does not waive the notes or authorize a merge.",
].join(" ");

export function innerLoopBranch(issue: GithubIssue | undefined, branch: string | undefined): string {
	if (branch !== undefined) return branch;
	if (issue !== undefined) return `issue/${issue.number}`;
	throw new Error("inner loop needs a branch name when no issue is linked");
}

export function innerLoopMessage(brief: string, issue: GithubIssue | undefined): string {
	if (issue === undefined) return brief;
	return [
		brief,
		"",
		`Issue: https://github.com/${issue.repository}/issues/${issue.number}. Open one draft PR whose body closes it (\`Closes #${issue.number}\`).`,
		VERIFIER_CONTRACT,
	].join("\n");
}

const GIT_TIMEOUT_MS = 60_000;

export async function runGit(dir: string, args: string[]): Promise<string> {
	const argv = ["git", "-C", dir, ...args];
	const r = await boundedRun(spawnProc(argv), { timeoutMs: GIT_TIMEOUT_MS, maxOutput: 64 * 1024 });
	if (r.exitCode !== 0 || r.timedOut)
		throw new Error(
			`git ${args.join(" ")} in ${dir} failed (${r.timedOut ? "timed out" : `exit ${r.exitCode}`}): ${r.stderr.trim()}`,
		);
	return r.stdout.trim();
}

export async function defaultBase(git: InnerLoopDeps["git"], dir: string): Promise<string> {
	let base: string;
	try {
		base = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	} catch (err) {
		throw new Error(
			`cannot resolve ${dir}'s default branch — run \`git -C ${dir} remote set-head origin --auto\``,
			{ cause: err },
		);
	}
	if (!/^origin\/[^\s]+$/.test(base)) throw new Error(`unexpected default branch ref "${base}" in ${dir}`);
	return base;
}

export async function startInnerLoop(deps: InnerLoopDeps, input: InnerLoopStart): Promise<InnerLoopThread> {
	const base = await defaultBase(deps.git, input.projectDir);
	await deps.git(input.projectDir, ["fetch", "origin", base.slice("origin/".length)]);
	const started = await deps.t3.startThread({
		project: input.projectDir,
		message: innerLoopMessage(input.brief, input.issue),
		provider: input.model.provider,
		model: input.model.model,
		...(input.model.options !== undefined ? { options: input.model.options } : {}),
		worktree: base,
		branch: input.branch,
	});
	log.info("inner loop started", {
		project: input.projectDir,
		thread: started.threadId,
		run: started.runId,
		base,
		branch: input.branch,
		provider: input.model.provider,
		model: input.model.model,
		...(input.issue !== undefined ? { repository: input.issue.repository, issue: input.issue.number } : {}),
	});
	return { ...started, base, branch: input.branch };
}
