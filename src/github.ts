// gh owns authentication. Only this adapter knows GitHub's wire contract.
import { createHash } from "node:crypto";
import { z } from "zod";
import { BoundaryError, type BoundaryKind } from "./boundary-error.ts";
import { log } from "./log.ts";
import { boundedRun, spawnProc } from "./proc.ts";
import {
	commitShaSchema,
	githubIssueSchema,
	readinessReasons,
	type GithubIssue,
	type PrReadiness,
	type VerifierVerdict,
} from "./pr-readiness.ts";

export type GithubRunner = (args: string[]) => Promise<string>;
function githubKind(message: string): BoundaryKind {
	if (/HTTP 404\b|Could not resolve/i.test(message)) return "missing";
	if (/HTTP 5\d\d|rate limit|timed?\s*out|connection|network|temporarily unavailable/i.test(message)) return "transient";
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
										z.object({ __typename: z.literal("CheckRun"), status: z.string(), conclusion: z.string().nullable() }),
										z.object({ __typename: z.literal("StatusContext"), state: z.string() }),
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
			nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}}
			pageInfo{hasNextPage}
		}}}}}
	}}
}`;

function latestVerdict(comments: z.infer<typeof commentSchema>[]): VerifierVerdict | null {
	const candidates = comments
		.filter((c) => !c.isMinimized)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	for (const c of candidates) {
		const verdict = /^(PASS\+NOTES|PASS|FAIL)(?=\s|$)/.exec(c.body.trimStart())?.[1];
		if (verdict !== "PASS" && verdict !== "PASS+NOTES" && verdict !== "FAIL") continue;
		const declarations = c.body.split(/\r?\n/).filter((line) => line.trimStart().startsWith("Checked-SHA:"));
		const sha = declarations.length === 1
			? /^Checked-SHA: ([a-f0-9]{40})[ \t]*$/.exec(declarations[0]!)?.[1] ?? null
			: null;
		return {
			verdict,
			sha,
			source: c.url,
			author: c.author?.login ?? null,
			notes: c.body.slice(0, 6000),
			notesTruncated: c.body.length > 6000,
			notesDigest: createHash("sha256").update(c.body).digest("hex"),
		};
	}
	return null;
}

export function makeGithubReadiness(run: GithubRunner = runGh) {
	return async (input: GithubIssue): Promise<PrReadiness> => {
		const issue = githubIssueSchema.parse(input);
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
				const verifier = latestVerdict(pr.comments.nodes);
				const reasons = readinessReasons(pr.headRefOid, verifier, ci);
				result = {
					kind: "checked", pr: pr.url,
					head: { sha: pr.headRefOid, source: `${pr.url}/commits/${pr.headRefOid}` },
					verifier,
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
			...(result.kind === "checked" ? { head: result.head.sha, ci: result.ci.state, ready: result.ready } : {}),
			ms: Date.now() - start,
		});
		return { issue, source, observedAt: new Date().toISOString(), result };
	};
}
