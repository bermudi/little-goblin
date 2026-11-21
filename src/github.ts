// gh owns authentication. Only this adapter knows GitHub's wire contract.
import { createHash } from "node:crypto";
import { z } from "zod";
import { BoundaryError, type BoundaryKind } from "./boundary-error.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import {
	commitShaSchema,
	githubIssueSchema,
	prWatchSchema,
	readinessReasons,
	type PrWatch,
	type PrReadiness,
	type RequiredCheck,
} from "./pr-readiness.ts";

export type GithubRunner = (args: string[]) => Promise<string>;
function githubKind(message: string): BoundaryKind {
	if (/HTTP 404\b|Could not resolve to an? /i.test(message)) return "missing";
	if (/HTTP 5\d\d|rate limit|timed?\s*out|connection|network|Could not resolve host|temporarily unavailable/i.test(message)) return "transient";
	return "fatal";
}
export class GithubError extends BoundaryError {
	constructor(message: string, kind = githubKind(message), options?: { cause?: unknown }) {
		super("github", kind, message, options);
		this.name = "GithubError";
	}
}
const runGh: GithubRunner = async (args) => {
	const r = await boundedRun(spawnProc(["gh", ...args]), {
		timeoutMs: 30_000,
		maxOutput: 1 << 20,
	});
	if (r.timedOut || r.truncated || r.exitCode !== 0) {
		const detail = r.stderr.replace(/\s+/g, " ").trim().slice(0, 300);
		throw new GithubError(
			`gh evidence read failed (exit ${r.exitCode}, timeout ${r.timedOut}, truncated ${r.truncated})${detail === "" ? "" : `: ${detail}`}`,
			r.timedOut ? "transient" : githubKind(r.stderr),
		);
	}
	return r.stdout;
};

const connectionPage = z.object({ hasNextPage: z.boolean() });
const linkedSchema = z.object({
	errors: z.never().optional(),
	data: z.object({
		repository: z.object({
			issue: z.object({
				url: z.string().url(),
				closed: z.boolean(),
				closedByPullRequestsReferences: z.object({
					nodes: z.array(z.object({
						number: z.number().int(), url: z.string().url(),
						state: z.enum(["OPEN", "CLOSED", "MERGED"]),
						repository: z.object({ nameWithOwner: githubIssueSchema.shape.repository }),
					})),
					pageInfo: connectionPage,
				}),
			}),
		}),
	}),
});
const commentSchema = z.object({
	body: z.string(),
	url: z.string().url(),
	updatedAt: z.string().datetime(),
	isMinimized: z.boolean(),
	author: z.object({ login: z.string() }).nullable(),
});
const prSchema = z.object({
	errors: z.never().optional(),
	data: z.object({
		repository: z.object({
			pullRequest: z.object({
				url: z.string().url(),
				state: z.enum(["OPEN", "CLOSED", "MERGED"]),
				headRefOid: commitShaSchema,
				closingIssuesReferences: z.object({
					nodes: z.array(z.object({ url: z.string().url() })),
					pageInfo: connectionPage,
				}),
				comments: z.object({
					nodes: z.array(commentSchema),
					pageInfo: z.object({ hasPreviousPage: z.boolean() }),
				}),
				commits: z.object({
					nodes: z.array(z.object({
						commit: z.object({
							oid: commitShaSchema,
							statusCheckRollup: z.object({
								state: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
								contexts: z.object({
									nodes: z.array(z.discriminatedUnion("__typename", [
										z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullable(), title: z.string().nullable(), detailsUrl: z.string().nullable() }),
										z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string(), description: z.string().nullable(), targetUrl: z.string().nullable() }),
									])),
									pageInfo: connectionPage,
								}),
							}).nullable(),
						}),
					})).length(1),
				}),
			}),
		}),
	}),
});

// Bounded queries fail closed on truncation rather than trusting partial evidence.
const ISSUE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
	repository(owner:$owner,name:$repo){issue(number:$number){url closed
		closedByPullRequestsReferences(first:100){nodes{number url state repository{nameWithOwner}} pageInfo{hasNextPage}}
	}}
}`;
const PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
	repository(owner:$owner,name:$repo){pullRequest(number:$number){
		url state headRefOid
		closingIssuesReferences(first:100){nodes{url} pageInfo{hasNextPage}}
		comments(last:100){nodes{body url updatedAt isMinimized author{login}} pageInfo{hasPreviousPage}}
		commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){
			nodes{__typename ... on CheckRun{name status conclusion title detailsUrl} ... on StatusContext{context state description targetUrl}}
			pageInfo{hasNextPage}
		}}}}}
	}}
}`;

export function makeGithubReadiness(run: GithubRunner = runGh) {
	return async (input: PrWatch): Promise<PrReadiness> => {
		const watch = prWatchSchema.parse(input);
		const issue = watch.issue;
		let source = `https://github.com/${issue.repository}/issues/${issue.number}`;
		const start = Date.now();
		const query = async (text: string, repository: string, number: number): Promise<unknown> => {
			const [owner, repo] = repository.split("/");
			log.info("GitHub query", { repository, number, resource: text === ISSUE_QUERY ? "issue" : "pr" });
			const raw = await run([
				"api", "--hostname", "github.com", "graphql",
				"-f", `query=${text}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`,
			]);
			log.info("GitHub query received", { repository, number, bytes: Buffer.byteLength(raw) });
			try {
				return JSON.parse(raw) as unknown;
			} catch (err) {
				throw new GithubError("GitHub returned malformed JSON", "fatal", { cause: err });
			}
		};
		let result: PrReadiness["result"];
		log.info("GitHub readiness read", { repository: issue.repository, issue: issue.number });
		try {
			const linked = linkedSchema.parse(await query(ISSUE_QUERY, issue.repository, issue.number)).data.repository.issue;
			source = linked.url;
			const prs = linked.closedByPullRequestsReferences;
			if (prs.pageInfo.hasNextPage) throw new GithubError("Closing PR evidence exceeds 100 entries");
			const open = prs.nodes.filter((pr) => pr.state === "OPEN");
			if (linked.closed || open.length === 0) {
				result = { kind: "no-pr", issueClosed: linked.closed };
			} else if (open.length > 1) {
				result = { kind: "ambiguous", prs: open.map((p) => p.url) };
			} else {
				const candidate = open[0]!;
				const pr = prSchema.parse(await query(PR_QUERY, candidate.repository.nameWithOwner, candidate.number)).data.repository.pullRequest;
				if (pr.comments.pageInfo.hasPreviousPage || pr.closingIssuesReferences.pageInfo.hasNextPage)
					throw new GithubError("PR evidence exceeds the 100-entry observation bound");
				if (pr.state !== "OPEN" || !pr.closingIssuesReferences.nodes.some((i) => i.url === source))
					throw new GithubError("PR no longer open or no longer closes this issue", "transient");
				const commit = pr.commits.nodes[0]!.commit;
				if (commit.oid !== pr.headRefOid) throw new GithubError("CI commit does not match the PR head", "transient");
				const rollup = commit.statusCheckRollup;
				if (rollup?.contexts.pageInfo.hasNextPage) throw new Error("CI evidence exceeds 100 entries");
				const succeeded = rollup?.contexts.nodes.some((c) => c.__typename === "StatusContext"
					? c.state === "SUCCESS" : c.status === "COMPLETED" && c.conclusion === "SUCCESS") ?? false;
				const ci = rollup === null || rollup.contexts.nodes.length === 0 ? "missing"
					: rollup.state === "SUCCESS" ? succeeded ? "green" : "missing"
					: rollup.state === "FAILURE" || rollup.state === "ERROR" ? "red" : "pending";
				const checks: RequiredCheck[] = watch.checks.map((name) => {
					const entries = rollup?.contexts.nodes.filter((c) =>
						c.__typename === "CheckRun" ? c.name === name : c.context === name,
					) ?? [];
					const stateOf = (c: typeof entries[number]): RequiredCheck["state"] => {
						if (c.__typename === "StatusContext")
							return c.state === "SUCCESS" ? "passed" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failed";
						return c.status !== "COMPLETED" ? "pending" : c.conclusion === "SUCCESS" ? "passed" : "failed";
					};
					const state: RequiredCheck["state"] = entries.length === 0 ? "missing"
						: entries.some((c) => stateOf(c) === "failed") ? "failed"
						: entries.some((c) => stateOf(c) === "pending") ? "pending" : "passed";
					const winner = entries.find((c) => stateOf(c) === state);
					const rawUrl = winner?.__typename === "CheckRun" ? winner.detailsUrl : winner?.targetUrl ?? null;
					const url = rawUrl === "" ? null : rawUrl;
					const description = winner?.__typename === "CheckRun" ? winner.title : winner?.description ?? null;
					const comment = url === null ? undefined : pr.comments.nodes.find((c) => !c.isMinimized && c.url === url);
					return {
						name, state, detail: entries.map((c) => c.__typename === "CheckRun" ? c.conclusion ?? c.status : c.state),
						description, url,
						notes: comment === undefined ? null : {
							source: comment.url, author: comment.author?.login ?? null,
							text: comment.body.slice(0, 6000), truncated: comment.body.length > 6000,
							digest: createHash("sha256").update(comment.body).digest("hex"),
						},
					};
				});
				const reasons = readinessReasons(checks, ci);
				result = {
					kind: "checked", pr: pr.url,
					head: { sha: pr.headRefOid, source: `${pr.url}/commits/${pr.headRefOid}` },
					checks,
					ci: { state: ci, sha: commit.oid, source: `${pr.url}/checks` },
					ready: reasons.length === 0, reasons,
				};
			}
		} catch (err) {
			const boundary = err instanceof BoundaryError
				? err
				: new GithubError(
					err instanceof Error ? err.message : String(err),
					githubKind(err instanceof Error ? err.message : String(err)),
					{ cause: err },
				);
			if (boundary.kind === "fatal") {
				log.error("GitHub readiness unavailable", err, { repository: issue.repository, issue: issue.number, boundary: boundary.boundary, kind: boundary.kind });
			} else {
				log.warn("GitHub readiness unavailable", err, { repository: issue.repository, issue: issue.number, boundary: boundary.boundary, kind: boundary.kind });
			}
			result = { kind: "unavailable", reason: `${boundary.kind === "fatal" ? "fatal: " : boundary.kind === "missing" ? "missing: " : ""}${boundary.message}` };
		}
		log.info("GitHub readiness observed", {
			repository: issue.repository, issue: issue.number, kind: result.kind,
			...(result.kind === "checked" ? { head: result.head.sha, ci: result.ci.state, ready: result.ready, checks: result.checks.map(({ name, state }) => ({ name, state })) } : {}),
			ms: Date.now() - start,
		});
		return { issue, source, observedAt: new Date().toISOString(), result };
	};
}
