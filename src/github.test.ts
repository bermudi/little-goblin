import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeGithubReadiness, type GithubRunner } from "./github.ts";
import { readinessKey } from "./pr-readiness.ts";
import { log, setLogWriter } from "./log.ts";

const HEAD = "a".repeat(40);
const issue = { repository: "owner/repo", number: 7 };
const issueUrl = "https://github.com/owner/repo/issues/7";
const prUrl = "https://github.com/owner/repo/pull/8";
const commentUrl = `${prUrl}#issuecomment-1`;

function fixture(entries: unknown[] = [{
	__typename: "StatusContext", context: "verify", state: "SUCCESS",
	description: "passed", targetUrl: commentUrl,
}]) {
	const linked = { data: { repository: { issue: {
		url: issueUrl, closed: false,
		closedByPullRequestsReferences: { nodes: [{ number: 8, url: prUrl, state: "OPEN", repository: { nameWithOwner: "owner/repo" } }], pageInfo: { hasNextPage: false } },
	} } } };
	const pr = {
		url: prUrl, state: "OPEN", headRefOid: HEAD,
		closingIssuesReferences: { nodes: [{ url: issueUrl }], pageInfo: { hasNextPage: false } },
		comments: { nodes: [{ body: "Useful note", url: commentUrl, updatedAt: "2026-11-12T00:00:00Z", isMinimized: false, author: { login: "worker" } }], pageInfo: { hasPreviousPage: false } },
		commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: {
			state: "SUCCESS", contexts: { nodes: entries, pageInfo: { hasNextPage: false } },
		} } }] },
	};
	let count = 0;
	const calls: string[][] = [];
	const run: GithubRunner = async (args) => {
		calls.push(args);
		return JSON.stringify(count++ === 0 ? linked : { data: { repository: { pullRequest: pr } } });
	};
	return {
		linked: linked.data.repository.issue, pr, calls,
		observe: (checks: string[] = ["verify"]) => makeGithubReadiness(run)({ issue, checks }),
	};
}

describe("GitHub PR readiness", () => {
	test("required passing status includes linked untrusted comment notes", async () => {
		const f = fixture();
		f.pr.comments.nodes[0]!.body = "Read this";
		const result = (await f.observe()).result;
		expect(result).toMatchObject({ kind: "checked", ready: true, checks: [{
			name: "verify", state: "passed", description: "passed", url: commentUrl,
			notes: { source: commentUrl, author: "worker", text: "Read this", truncated: false,
				digest: createHash("sha256").update("Read this").digest("hex") },
		}] });
	});
	test("absent required name is missing regardless of verdict-like comment", async () => {
		const f = fixture([]);
		f.pr.comments.nodes[0]!.body = `PASS\nChecked-SHA: ${HEAD}`;
		expect((await f.observe()).result).toMatchObject({
			kind: "checked", ready: false,
			reasons: ["Required check verify is missing on the current head", "CI is missing on the current head"],
		});
	});
	test("check run failures and in-progress states map to failed and pending", async () => {
		const failed = fixture([{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", title: "failed", detailsUrl: null }]);
		expect((await failed.observe(["build"])).result).toMatchObject({
			kind: "checked", ready: false, checks: [{ name: "build", state: "failed", detail: ["FAILURE"], description: "failed" }],
			reasons: ["Required check build did not pass on the current head (FAILURE)", "CI is missing on the current head"],
		});
		const pending = fixture([{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, title: null, detailsUrl: null }]);
		expect((await pending.observe(["build"])).result).toMatchObject({ kind: "checked", checks: [{ state: "pending" }] });
	});
	test("worst duplicate result wins and zero required checks can pass", async () => {
		const duplicate = fixture([
			{ __typename: "StatusContext", context: "verify", state: "SUCCESS", description: null, targetUrl: null },
			{ __typename: "StatusContext", context: "verify", state: "FAILURE", description: "failure", targetUrl: null },
		]);
		expect((await duplicate.observe()).result).toMatchObject({ kind: "checked", ready: false, checks: [{ state: "failed" }] });
		expect((await fixture().observe([])).result).toMatchObject({ kind: "checked", ready: true, checks: [] });
	});
	test("minimized linked comment is not forwarded as notes", async () => {
		const f = fixture();
		f.pr.comments.nodes[0]!.isMinimized = true;
		expect((await f.observe()).result).toMatchObject({ kind: "checked", checks: [{ notes: null }] });
	});

	test("classifies missing, transient, and fatal gh failures from diagnostics", async () => {
		const warning = spyOn(log, "warn");
		const error = spyOn(log, "error");
		try {
			for (const [message, kind] of [
				["gh: HTTP 404 Not Found", "missing"],
				["gh: API rate limit exceeded", "transient"],
				["gh: HTTP 503 Service Unavailable", "transient"],
				["gh: connection timed out", "transient"],
				["gh: Could not resolve host: api.github.com", "transient"],
				["gh: GraphQL: Could not resolve to a Repository with the name 'o/r'", "missing"],
				["gh: cached 404 results are stale", "fatal"],
			] as const) {
				const run: GithubRunner = async () => { throw new Error(message); };
				const out = await makeGithubReadiness(run)({ issue, checks: [] });
				expect(out.result).toMatchObject({ kind: "unavailable" });
				const sink = kind === "fatal" ? error : warning;
				expect(sink).toHaveBeenLastCalledWith("GitHub readiness unavailable", expect.any(Error), expect.objectContaining({ boundary: "github", kind }));
				if (kind === "missing") expect((out.result as { reason: string }).reason).toStartWith("missing:");
			}
		} finally { warning.mockRestore(); error.mockRestore(); }
	});

	test("PR state and commit-head races are transient observations", async () => {
		const warning = spyOn(log, "warn");
		try {
			const closed = fixture();
			closed.pr.state = "MERGED";
			expect((await closed.observe()).result).toMatchObject({ kind: "unavailable" });
			expect(warning).toHaveBeenLastCalledWith("GitHub readiness unavailable", expect.any(Error), expect.objectContaining({ boundary: "github", kind: "transient" }));
			const changed = fixture();
			changed.pr.commits.nodes[0]!.commit.oid = "b".repeat(40);
			expect((await changed.observe()).result).toMatchObject({ kind: "unavailable" });
		} finally { warning.mockRestore(); }
	});

	test("fatal schema and JSON failures have a fatal reason and error log", async () => {
		const error = spyOn(log, "error");
		try {
			const malformed: GithubRunner = async () => "{";
			expect((await makeGithubReadiness(malformed)({ issue, checks: [] })).result).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/^fatal:/) });
			const invalid: GithubRunner = async () => JSON.stringify({ data: {} });
			expect((await makeGithubReadiness(invalid)({ issue, checks: [] })).result).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/^fatal:/) });
			expect(error).toHaveBeenCalled();
		} finally { error.mockRestore(); setLogWriter(null); }
	});

	test("a successful rollup with no checks is missing, not green", async () => {
		const f = fixture([]);
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: false, ci: { state: "missing" } });
	});

	test.each([
		["PENDING", "pending"], ["EXPECTED", "pending"], ["FAILURE", "red"], ["ERROR", "red"],
	] as const)("CI %s is not green", async (state, expected) => {
		const f = fixture();
		f.pr.commits.nodes[0]!.commit.statusCheckRollup.state = state;
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: false, ci: { state: expected, sha: HEAD } });
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
		const skipped = fixture([{ __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SKIPPED", title: null, detailsUrl: null }]);
		expect((await skipped.observe()).result).toMatchObject({ kind: "checked", ready: false, ci: { state: "missing" } });
		const paginated = fixture();
		paginated.pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
		expect((await paginated.observe()).result.kind).toBe("unavailable");
	});

	test("follows cross-repository closing PRs and ignores historical closed PRs", async () => {
		const f = fixture();
		f.linked.closedByPullRequestsReferences.nodes[0]!.repository.nameWithOwner = "another/implementation";
		f.linked.closedByPullRequestsReferences.nodes.push({ number: 9, url: "https://github.com/owner/repo/pull/9", state: "MERGED", repository: { nameWithOwner: "owner/repo" } });
		expect((await f.observe()).result).toMatchObject({ kind: "checked", ready: true });
		expect(f.calls[1]!).toContain("owner=another");
		expect(f.calls[1]!).toContain("repo=implementation");
	});

	test("authentication failures, malformed JSON and GraphQL errors are unavailable, never a pass", async () => {
		for (const run of [
			async () => { throw new Error("gh not authenticated"); },
			async () => "not JSON",
			async () => JSON.stringify({ errors: [{ message: "rate limited" }], data: null }),
		]) expect((await makeGithubReadiness(run)({ issue, checks: [] })).result.kind).toBe("unavailable");
	});

	test.each(["comments", "links", "head", "closed", "unlinked"] as const)(
		"incomplete or raced %s evidence fails closed", async (change) => {
			const f = fixture();
			if (change === "comments") f.pr.comments.pageInfo.hasPreviousPage = true;
			if (change === "links") f.linked.closedByPullRequestsReferences.pageInfo.hasNextPage = true;
			if (change === "head") f.pr.commits.nodes[0]!.commit.oid = "b".repeat(40);
			if (change === "closed") f.pr.state = "MERGED";
			if (change === "unlinked") f.pr.closingIssuesReferences.nodes = [];
			expect((await f.observe()).result.kind).toBe("unavailable");
		},
	);

	test("an edit beyond the delivered excerpt still changes readiness identity", async () => {
		const prefix = "note ".repeat(1300);
		const first = fixture();
		const second = fixture();
		first.pr.comments.nodes = [{ body: `${prefix}Old caveat.`, url: commentUrl, updatedAt: "2026-11-12T00:00:00Z", isMinimized: false, author: { login: "worker" } }];
		second.pr.comments.nodes = [{ body: `${prefix}New caveat.`, url: commentUrl, updatedAt: "2026-11-12T00:00:00Z", isMinimized: false, author: { login: "worker" } }];
		const a = await first.observe();
		const b = await second.observe();
		if (a.result.kind !== "checked" || b.result.kind !== "checked") throw new Error("Expected checked observations");
		expect(a.result.checks[0]?.notes?.text).toEqual(b.result.checks[0]?.notes?.text);
		expect(a.result.checks[0]?.notes?.digest).not.toEqual(b.result.checks[0]?.notes?.digest);
		expect(readinessKey(a)).not.toBe(readinessKey(b));
	});

	test("long required-check notes are truncated and retain their source", async () => {
		const f = fixture();
		f.pr.comments.nodes = [{ body: "x".repeat(7000), url: commentUrl, updatedAt: "2026-11-12T00:00:00Z", isMinimized: false, author: { login: "worker" } }];
		expect((await f.observe()).result).toMatchObject({ kind: "checked", checks: [{ notes: { truncated: true, source: commentUrl } }] });
	});

	test("odd and empty target URLs do not invalidate unrelated entries; empty required URL becomes null", async () => {
		const f = fixture([
			{ __typename: "StatusContext", context: "unrelated-empty", state: "SUCCESS", description: null, targetUrl: "" },
			{ __typename: "StatusContext", context: "unrelated-odd", state: "SUCCESS", description: null, targetUrl: "not a url" },
			{ __typename: "StatusContext", context: "verify", state: "SUCCESS", description: null, targetUrl: "" },
		]);
		expect((await f.observe()).result).toMatchObject({ kind: "checked", checks: [{ name: "verify", url: null }] });
	});
});
