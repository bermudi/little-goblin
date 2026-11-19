import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigValue } from "../config.ts";
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

function home() {
	const path = mkdtempSync(join(tmpdir(), "goblin-health-t3-"));
	return {
		path,
		cleanup: () => rmSync(path, { recursive: true, force: true }),
	};
}

describe("delegation.t3 health check", () => {
	test("no delegation block still probes — handover runs on t3 regardless", async () => {
		let calls = 0;
		const runner: T3Runner = async () => {
			calls++;
			return ok("[]");
		};
		const target = home();
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
				runner,
			);
			expect(finding.status).toBe("pass");
			expect(calls).toBe(1);
		} finally {
			target.cleanup();
		}
	});

	test("preflight and unreadable config skip without calling the runner", async () => {
		let calls = 0;
		const runner: T3Runner = async () => {
			calls++;
			return ok("[]");
		};
		const target = home();
		try {
			const pre = await t3Health(config, target.path, "preflight", {}, runner);
			expect(pre.status).toBe("skip");
			const blocked = await t3Health(undefined, target.path, "installed", {}, runner);
			expect(blocked.status).toBe("skip");
			expect(blocked.detail).toContain("Blocked by config");
			expect(calls).toBe(0);
		} finally {
			target.cleanup();
		}
	});

	test("handover reaches t3: an empty thread list passes and invokes only list", async () => {
		const calls: { args: string[]; opts?: T3CallOpts }[] = [];
		const runner: T3Runner = async (args, opts) => {
			calls.push({ args, ...(opts === undefined ? {} : { opts }) });
			return ok("[]");
		};
		const target = home();
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("pass");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.args).toEqual([
				"thread",
				"list",
				"--project",
				join(target.path, "workspace"),
				"--json",
			]);
			expect(calls[0]!.opts?.timeoutMs).toBeGreaterThan(0);
		} finally {
			target.cleanup();
		}
	});

	test("handover reports safe T3 exit detail without raw stderr", async () => {
		const secret = "raw stderr sentinel";
		const runner: T3Runner = async () => nonzero(secret);
		const target = home();
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("t3 server or CLI unreachable: exit_1");
			expect(finding.detail).not.toContain(secret);
			expect(finding.next).toContain("t3 serve");
		} finally {
			target.cleanup();
		}
	});

	test("an unknown T3 project fails with an actionable registration hint", async () => {
		const runner: T3Runner = async () =>
			nonzero(
				"No T3 Code project matches '/workspace'. Pass a project id or a path inside a project.",
			);
		const target = home();
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("not a T3 Code project");
			expect(finding.detail).not.toContain("No T3 Code project matches");
			expect(finding.next).toBe(`t3 project add ${join(target.path, "workspace")}`);
		} finally {
			target.cleanup();
		}
	});

	test("runner errors do not expose their message", async () => {
		const runner: T3Runner = async () => {
			throw Object.assign(new Error("spawn t3 ENOENT"), { code: "ENOENT" });
		};
		const target = home();
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
		const target = home();
		try {
			const finding = await t3Health(config, target.path, "installed", {}, runner);
			expect(finding.status).toBe("fail");
			expect(finding.detail).toContain("t3 server or CLI unreachable: timeout");
		} finally {
			target.cleanup();
		}
	}, 10_000);
});
