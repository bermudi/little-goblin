import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigValue } from "../config.ts";
import { ensureProjectsSchema } from "../projects.ts";
import type { T3CallOpts, T3RunResult, T3Runner } from "../t3.ts";
import { t3Health } from "./t3.ts";

const config = parseConfigValue({
	providers: { fake: { kind: "codex" } },
	model: "fake/model",
	operators: [1],
	delegation: {
		harnesses: { fixture: { kind: "fake" } },
	},
});
const ok = (stdout: string): T3RunResult => ({ code: 0, stdout, stderr: "" });
const nonzero = (stderr: string): T3RunResult => ({ code: 1, stdout: "", stderr });
const unknownProject = (dir: string) =>
	nonzero(`No T3 Code project matches '${dir}'. Pass a project id or a path inside a project.`);

interface ProjectRowInput {
	dir: string;
	archived?: boolean;
}

function home(projects?: ProjectRowInput[]) {
	const path = mkdtempSync(join(tmpdir(), "goblin-health-t3-"));
	if (projects !== undefined) {
		mkdirSync(join(path, "state"));
		const db = new Database(join(path, "state/goblin.sqlite"));
		ensureProjectsSchema(db);
		projects.forEach((p, i) => {
			db.query(
				"INSERT INTO projects (id, name, slug, home, dir, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(`p${i}`, `p${i}`, `p${i}`, p.dir, p.dir, `2026-11-19T00:00:0${i}Z`, p.archived ? "2026-11-19T01:00:00Z" : null);
		});
		db.close();
	}
	return {
		path,
		workspace: join(path, "workspace"),
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}

function recorder(answer: (dir: string) => T3RunResult) {
	const calls: { args: string[]; opts?: T3CallOpts }[] = [];
	const runner: T3Runner = async (args, opts) => {
		calls.push({ args, ...(opts === undefined ? {} : { opts }) });
		return answer(args[3]!);
	};
	return { calls, runner, dirs: () => calls.map((c) => c.args[3]) };
}

describe("delegation.t3 health check", () => {
	test("no delegation block still probes — handover runs on t3 regardless", async () => {
		const r = recorder(() => ok("[]"));
		const target = home([{ dir: "/repo/a" }]);
		try {
			const finding = await t3Health(
				parseConfigValue({
					providers: { fake: { kind: "codex" } },
					model: "fake/model",
					operators: [1],
				}),
				target.path,
				"installed",
				{},
				r.runner,
			);
			expect(finding.status).toBe("pass");
			expect(r.calls).toHaveLength(1);
		} finally {
			target.cleanup();
		}
	});

	test("preflight and unreadable config skip without calling the runner", async () => {
		const r = recorder(() => ok("[]"));
		const target = home([{ dir: "/repo/a" }]);
		try {
			const pre = await t3Health(config, target.path, "preflight", {}, r.runner);
			expect(pre.status).toBe("skip");
			const blocked = await t3Health(undefined, target.path, "installed", {}, r.runner);
			expect(blocked.status).toBe("skip");
			expect(blocked.detail).toContain("Blocked by config");
			expect(r.calls).toHaveLength(0);
		} finally {
			target.cleanup();
		}
	});

	test("no state database or no active project skips without calling t3", async () => {
		const r = recorder(() => ok("[]"));
		const bare = home();
		const archived = home([{ dir: "/repo/old", archived: true }]);
		try {
			expect((await t3Health(config, bare.path, "installed", {}, r.runner)).status).toBe("skip");
			const none = await t3Health(config, archived.path, "installed", {}, r.runner);
			expect(none.status).toBe("skip");
			expect(none.detail).toContain("No active project");
			expect(r.calls).toHaveLength(0);
		} finally {
			bare.cleanup();
			archived.cleanup();
		}
	});

	test("an empty thread list for a goblin project passes with one read-only list", async () => {
		const r = recorder(() => ok("[]"));
		const target = home([{ dir: "/repo/a" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, r.runner);
			expect(finding.status).toBe("pass");
			expect(r.calls).toHaveLength(1);
			expect(r.calls[0]!.args).toEqual(["thread", "list", "--project", "/repo/a", "--json"]);
			expect(r.calls[0]!.opts?.timeoutMs).toBeGreaterThan(0);
		} finally {
			target.cleanup();
		}
	});

	test("goblin's workspace is never probed; an unknown project falls through to the next", async () => {
		const r = recorder((dir) => (dir === "/repo/b" ? ok("[]") : unknownProject(dir)));
		const target = home([{ dir: "/repo/a" }, { dir: "/repo/old", archived: true }, { dir: "/repo/b" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, r.runner);
			expect(finding.status).toBe("pass");
			expect(r.dirs()).toEqual(["/repo/a", "/repo/b"]);
			expect(r.dirs()).not.toContain(target.workspace);
		} finally {
			target.cleanup();
		}
	});

	test("t3 knowing none of goblin's projects warns and never suggests registering the workspace", async () => {
		const r = recorder(unknownProject);
		const target = home([{ dir: "/repo/a" }, { dir: "/repo/b" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, r.runner);
			expect(finding.status).toBe("warn");
			expect(finding.detail).toContain("none of goblin's 2 active projects");
			expect(finding.detail).not.toContain("No T3 Code project matches");
			expect(finding.next).not.toContain(target.workspace);
			expect(r.dirs()).toEqual(["/repo/a", "/repo/b"]);
		} finally {
			target.cleanup();
		}
	});

	test("handover reports safe T3 exit detail without raw stderr", async () => {
		const secret = "raw stderr sentinel";
		const r = recorder(() => nonzero(secret));
		const target = home([{ dir: "/repo/a" }, { dir: "/repo/b" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, r.runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("t3 server or CLI unreachable: exit_1");
			expect(finding.detail).not.toContain(secret);
			expect(finding.next).toContain("t3 serve");
			expect(r.calls).toHaveLength(1);
		} finally {
			target.cleanup();
		}
	});

	test("runner errors do not expose their message", async () => {
		const runner: T3Runner = async () => {
			throw Object.assign(new Error("spawn t3 ENOENT"), { code: "ENOENT" });
		};
		const target = home([{ dir: "/repo/a" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("t3 server or CLI unreachable: ENOENT");
			expect(finding.detail).not.toContain("spawn t3 ENOENT");
		} finally {
			target.cleanup();
		}
	});

	test("a hanging runner is bounded and reported as a timeout", async () => {
		const runner: T3Runner = () => new Promise<T3RunResult>(() => {});
		const target = home([{ dir: "/repo/a" }]);
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("t3 server or CLI unreachable: timeout");
		} finally {
			target.cleanup();
		}
	}, 10_000);
});
