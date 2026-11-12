// Synthetic GitHub wire responses test policy; live probing is read-only via scripts/pr-readiness.ts.
import { describe, expect, test } from "bun:test";
import { makeGithubReadiness, type GithubRunner } from "./github.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const issue = { repository: "owner/repo", number: 7 };
const issueUrl = "https://github.com/owner/repo/issues/7";
const prUrl = "https://github.com/owner/repo/pull/8";

function comment(body = `PASS\n\nChecked-SHA: ${HEAD}`, updatedAt = "2026-11-12T00:00:00Z") {
	return { body, updatedAt, url: `${prUrl}#issuecomment-1`, isMinimized: false, author: { login: "verifier" } };
}
function fixture() {
	const linked = { data: { repository: { issue: {
		url: issueUrl,
		closed: false,
		closedByPullRequestsReferences: {
			nodes: [{ number: 8, url: prUrl, state: "OPEN", repository: { nameWithOwner: "owner/repo" } }], pageInfo: { hasNextPage: false },
		},
	} } } };
	const pr = {
		url: prUrl, state: "OPEN", headRefOid: HEAD,
		closingIssuesReferences: { nodes: [{ url: issueUrl }], pageInfo: { hasNextPage: false } },
		comments: { nodes: [comment()], pageInfo: { hasPreviousPage: false } },
		commits: { nodes: [{ commit: {
			oid: HEAD, statusCheckRollup: {
				state: "SUCCESS", contexts: {
					nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
					pageInfo: { hasNextPage: false },
				},
			},
		} }] },
	};
	const calls: string[][] = [];
	const run: GithubRunner = (args) => {
		calls.push(args);
		return Promise.resolve(JSON.stringify(calls.length === 1 ? linked : { data: { repository: { pullRequest: pr } } }));
	};
	return { linked: linked.data.repository.issue, pr, calls, observe: () => makeGithubReadiness(run)(issue) };
}

describe("GitHub PR readiness", () => {
	test("a passing verifier and green CI share the current SHA, with sources", async () => {
		const f = fixture();
		const observed = await f.observe();
		expect(observed.source).toBe(issueUrl);
		expect(observed.result).toMatchObject({
			kind: "checked", ready: true, reasons: [],
			head: { sha: HEAD, source: `${prUrl}/commits/${HEAD}` },
			verifier: { verdict: "PASS", sha: HEAD, source: `${prUrl}#issuecomment-1`, author: "verifier" },
			ci: { state: "green", sha: HEAD, source: `${prUrl}/checks` },
		});
		expect(f.calls).toHaveLength(2);
		expect(f.calls[0]).toContain("--hostname");
		expect(f.calls[0]).toContain("github.com");
	});

	test.each([
		["stale SHA", `PASS\nChecked-SHA: ${OLD}`, "older or different SHA"],
		["missing SHA", "PASS\nLooks fine.", "no full Checked-SHA"],
		["short SHA", `PASS\nChecked-SHA: ${HEAD.slice(0, 7)}`, "no full Checked-SHA"],
		["contradictory SHA", `PASS\nChecked-SHA: ${HEAD}\nChecked-SHA: ${OLD}`, "no full Checked-SHA"],
		["failed verdict", `FAIL\nChecked-SHA: ${HEAD}`, "FAIL"],
		["no verdict", "The lead says everything passed.", "Missing verifier"],
	])("%s cannot make the PR ready", async (_name, body, reason) => {
		const f = fixture();
		f.pr.comments.nodes = [comment(body)];
		expect((await f.observe()).result).toMatchObject({
			kind: "checked", ready: false, reasons: expect.arrayContaining([expect.stringContaining(reason)]),
		});
	});

	test.each([
		["PENDING", "pending"], ["EXPECTED", "pending"], ["FAILURE", "red"], ["ERROR", "red"],
	])("CI %s is not green", async (state, expected) => {
		const f = fixture();
		f.pr.commits.nodes[0]!.commit.statusCheckRollup.state = state;
		expect((await f.observe()).result).toMatchObject({
			kind: "checked", ready: false, ci: { state: expected, sha: HEAD },
		});
	});

	test("a successful rollup with no checks is missing, not green", async () => {
		const f = fixture();
		f.pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes = [];
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: false, ci: { state: "missing" } });
	});

	test("PASS+NOTES keeps its notes, and the newest verdict overrides an old pass", async () => {
		const f = fixture();
		f.pr.comments.nodes.push(comment(`PASS+NOTES\nChecked-SHA: ${HEAD}\nReview the migration.`, "2026-11-12T01:00:00Z"));
		expect((await f.observe()).result).toMatchObject({
			kind: "checked", ready: true,
			verifier: { verdict: "PASS+NOTES", notes: expect.stringContaining("Review the migration.") },
		});
		const g = fixture();
		g.pr.comments.nodes.push(comment(`FAIL\nChecked-SHA: ${HEAD}`, "2026-11-12T01:00:00Z"));
		expect((await g.observe()).result).toMatchObject({ kind: "checked", ready: false, verifier: { verdict: "FAIL" } });
	});

	test("minimized verdicts do not count", async () => {
		const f = fixture();
		f.pr.comments.nodes[0]!.isMinimized = true;
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: false, verifier: null });
	});

	test("long verifier notes are explicitly marked as truncated, with their source", async () => {
		const f = fixture();
		f.pr.comments.nodes = [comment(`PASS+NOTES\nChecked-SHA: ${HEAD}\n${"note ".repeat(2000)}`)];
		expect((await f.observe()).result).toMatchObject({
			kind: "checked", ready: true,
			verifier: { notesTruncated: true, source: `${prUrl}#issuecomment-1` },
		});
	});

	test("missing and ambiguous PRs are explicit, without choosing a convenient PR", async () => {
		const f = fixture();
		f.linked.closedByPullRequestsReferences.nodes = [];
		expect((await f.observe()).result).toEqual({ kind: "no-pr", issueClosed: false });
		expect(f.calls).toHaveLength(1);
		const g = fixture();
		g.linked.closedByPullRequestsReferences.nodes.push({ number: 9, url: "https://github.com/owner/repo/pull/9", state: "OPEN", repository: { nameWithOwner: "owner/repo" } });
		expect((await g.observe()).result.kind).toBe("ambiguous");
		expect(g.calls).toHaveLength(1);
	});

	test("skipped-only checks are not green, and CI pagination is not partial success", async () => {
		const f = fixture();
		f.pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!.conclusion = "SKIPPED";
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: false, ci: { state: "missing" } });
		const g = fixture();
		g.pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
		expect((await g.observe()).result.kind).toBe("unavailable");
	});

	test("follows cross-repository closing PRs and ignores historical closed PRs", async () => {
		const f = fixture();
		f.linked.closedByPullRequestsReferences.nodes[0]!.repository.nameWithOwner = "another/implementation";
		f.linked.closedByPullRequestsReferences.nodes.push({
			number: 9, url: "https://github.com/owner/repo/pull/9", state: "MERGED",
			repository: { nameWithOwner: "owner/repo" },
		});
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: true });
		expect(f.calls[1]).toContain("owner=another");
		expect(f.calls[1]).toContain("repo=implementation");
	});

	test.each(["comments", "links", "head", "closed", "unlinked"] as const)(
		"incomplete or raced %s evidence fails closed", async (change) => {
			const f = fixture();
			if (change === "comments") f.pr.comments.pageInfo.hasPreviousPage = true;
			if (change === "links") f.linked.closedByPullRequestsReferences.pageInfo.hasNextPage = true;
			if (change === "head") f.pr.commits.nodes[0]!.commit.oid = OLD;
			if (change === "closed") f.pr.state = "MERGED";
			if (change === "unlinked") f.pr.closingIssuesReferences.nodes = [];
			expect((await f.observe()).result.kind).toBe("unavailable");
		},
	);

	test("authentication failures, malformed JSON and GraphQL errors are unavailable, never a pass", async () => {
		for (const run of [
			async () => { throw new Error("gh not authenticated"); },
			async () => "not JSON",
			async () => JSON.stringify({ errors: [{ message: "rate limited" }], data: null }),
		]) {
			expect((await makeGithubReadiness(run)(issue)).result.kind).toBe("unavailable");
		}
	});
});
