import type { Database } from "bun:sqlite";
import { z } from "zod";
import { log } from "./log.ts";
import type { GithubIssue, PrWatch } from "./pr-readiness.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import type { T3, T3StartResult } from "./t3.ts";

export interface InnerLoopModel {
	provider: string;
	model: string;
	options?: Readonly<Record<string, string | boolean>> | undefined;
}

export const INNER_LOOP_DEFAULT: InnerLoopModel = { provider: "claudeAgent", model: "claude-opus-5-5" };

export interface InnerLoopStart {
	handoverKey: string;
	authorize(): void;
	projectDir: string;
	brief: string;
	branch: string;
	pr?: PrWatch | undefined;
	model: InnerLoopModel;
}

export interface InnerLoopDeps {
	t3: Pick<T3, "startThread">;
	git(dir: string, args: string[]): Promise<string>;
	starts: InnerLoopStarts;
}

export interface InnerLoopThread extends T3StartResult {
	base: string;
	branch: string;
}

export interface InnerLoopStarts {
	get(handoverKey: string): InnerLoopThread | null;
	record(handoverKey: string, thread: InnerLoopThread): void;
}

const startedSchema = z.object({
	threadId: z.string(),
	projectId: z.string(),
	runId: z.string(),
	base: z.string(),
	branch: z.string(),
});

export function makeInnerLoopStarts(db: Database): InnerLoopStarts {
	const qGet = db.query("SELECT thread_json FROM inner_loop_starts WHERE handover_key = ?");
	const qRecord = db.query(
		"INSERT INTO inner_loop_starts (handover_key, thread_json) VALUES (?, ?) ON CONFLICT(handover_key) DO NOTHING",
	);
	return {
		get(handoverKey) {
			const row = z.object({ thread_json: z.string() }).nullable().parse(qGet.get(handoverKey));
			return row === null ? null : startedSchema.parse(JSON.parse(row.thread_json));
		},
		record(handoverKey, thread) {
			qRecord.run(handoverKey, JSON.stringify(startedSchema.parse(thread)));
		},
	};
}

export function innerLoopBranch(issue: GithubIssue | undefined, branch: string | undefined): string {
	if (branch !== undefined) return branch;
	if (issue !== undefined) return `issue/${issue.number}`;
	throw new Error("inner loop needs a branch name when no issue is linked");
}

export function innerLoopMessage(brief: string, pr: PrWatch | undefined): string {
	if (pr === undefined) return brief;
	const { issue, checks } = pr;
	return [
		brief,
		"",
		`Issue: https://github.com/${issue.repository}/issues/${issue.number}. Open one draft PR whose body closes it (\`Closes #${issue.number}\`).`,
		`Code watches that PR's current head commit: CI${checks.length > 0 ? ` and the required commit checks ${checks.join(", ")}` : ""} must pass on it. A check counts only for the commit it is on; every new push needs its checks again. Readiness never authorizes a merge.`,
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
	const prior = deps.starts.get(input.handoverKey);
	if (prior !== null) {
		log.info("inner loop start reused", {
			project: input.projectDir,
			thread: prior.threadId,
			branch: prior.branch,
		});
		return prior;
	}
	const base = await defaultBase(deps.git, input.projectDir);
	await deps.git(input.projectDir, ["fetch", "origin", base.slice("origin/".length)]);
	input.authorize();
	const started = await deps.t3.startThread({
		project: input.projectDir,
		message: innerLoopMessage(input.brief, input.pr),
		provider: input.model.provider,
		model: input.model.model,
		...(input.model.options !== undefined ? { options: input.model.options } : {}),
		worktree: base,
		branch: input.branch,
	});
	const thread: InnerLoopThread = { ...started, base, branch: input.branch };
	deps.starts.record(input.handoverKey, thread);
	log.info("inner loop started", {
		project: input.projectDir,
		thread: started.threadId,
		run: started.runId,
		base,
		branch: input.branch,
		provider: input.model.provider,
		model: input.model.model,
		...(input.pr !== undefined
			? { repository: input.pr.issue.repository, issue: input.pr.issue.number, checks: input.pr.checks }
			: {}),
	});
	return thread;
}
