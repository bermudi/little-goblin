// Real-podman coverage of the seams fakes can't hold — gated on
// GOBLIN_TEST_PODMAN=1. Uses a test-only container prefix and network
// and removes exactly what it creates.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxConfigSchema } from "./config.ts";
import { makePodman } from "./podman.ts";
import { containerNameFor, makeSandboxes, openSandboxes } from "./sandboxes.ts";
import { sandboxTool } from "./agent/tools/sandbox.ts";

const RUN = process.env.GOBLIN_TEST_PODMAN === "1";
const PREFIX = "goblin-sbxtest-";
const NETWORK = "goblin-sbxtest";
const CONV = "dm:sandbox-integration";

function podmanSync(args: string[]): { code: number; stdout: string; stderr: string } {
	const r = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
	return {
		code: r.exitCode,
		stdout: r.stdout.toString(),
		stderr: r.stderr.toString(),
	};
}

interface ToolResult {
	error?: string;
	exit_code?: number | null;
	timed_out?: boolean;
	truncated?: boolean;
	output?: string;
	note?: string;
	enabled?: boolean;
	exported?: string;
	bytes?: number;
	reset?: boolean;
	[k: string]: unknown;
}

const toolOpts = { toolCallId: "t", messages: [], context: {} };

describe.skipIf(!RUN)("sandbox against real podman", () => {
	const name = containerNameFor(CONV, PREFIX);
	let ws = "";
	let t: ReturnType<typeof sandboxTool>;
	const call = (input: Parameters<NonNullable<typeof t.execute>>[0]) =>
		t.execute!(input, toolOpts) as Promise<ToolResult>;

	beforeAll(() => {
		ws = mkdtempSync(join(tmpdir(), "goblin-sbx-it-"));
		const store = openSandboxes(join(ws, "goblin.sqlite"));
		t = sandboxTool({
			conversation: CONV,
			workspace: ws,
			sandboxes: makeSandboxes({
				podman: makePodman(),
				store,
				config: () => sandboxConfigSchema.parse({}),
				containerPrefix: PREFIX,
				networkName: NETWORK,
			}),
		});
	});

	afterAll(() => {
		// The test prefix owns these names — only this suite can have
		// created them, so removal here is always cleanup, never damage.
		podmanSync(["rm", "-f", "-t", "0", name]);
		podmanSync(["network", "rm", NETWORK]);
		if (ws !== "") rmSync(ws, { recursive: true, force: true });
	});

	test("exec creates the sandbox and runs as root under the pinned uid_map", async () => {
		const out = await call({
			action: "exec",
			command: "id -u; pwd; cat /proc/self/uid_map",
		});
		expect(out.error).toBeUndefined();
		expect(out.note).toContain("created");
		expect(out.output).toMatch(/^0\n\/work\n\s*0\s+40000\s+8192/m);
		expect(podmanSync(["inspect", name]).code).toBe(0);
	});

	test("network is off by default; toggling is live and files survive", async () => {
		const off = await call({ action: "exec", command: "nc -z -w 2 1.1.1.1 443" });
		expect(off.exit_code).not.toBe(0);
		expect(
			(await call({ action: "exec", command: "echo survives > /work/marker" })).exit_code,
		).toBe(0);

		const on = await call({ action: "network", enabled: true });
		expect(on.enabled).toBe(true);
		expect((await call({ action: "exec", command: "nc -z -w 3 1.1.1.1 443" })).exit_code).toBe(0);

		expect((await call({ action: "network", enabled: false })).enabled).toBe(false);
		expect((await call({ action: "exec", command: "nc -z -w 2 1.1.1.1 443" })).exit_code).not.toBe(
			0,
		);
		expect((await call({ action: "exec", command: "cat /work/marker" })).output).toContain(
			"survives",
		);
	});

	test("export reads the container's file content through a container symlink", async () => {
		await call({ action: "exec", command: "ln -sf /etc/passwd /work/pw-link" });
		const out = await call({ action: "export", from: "/work/pw-link", to: "passwd-copy" });
		expect(out.error).toBeUndefined();
		const got = readFileSync(join(ws, "passwd-copy"), "utf8");
		// The bytes are the CONTAINER's /etc/passwd — alpine's tiny passwd
		// file, not the host's (which would carry the operator's user).
		expect(got).toContain("root:x:0:0:root:");
		expect(got).not.toContain("daniel");
		const inside = await call({ action: "exec", command: "cat /etc/passwd" });
		expect(inside.output).toBe(got);
	});

	test("a timed-out exec restarts the sandbox — background dies, files stay", async () => {
		const out = await call({
			action: "exec",
			command: "echo keep > /work/kept && sleep 60",
			timeout_ms: 2_000,
		});
		expect(out.timed_out).toBe(true);
		expect(out.exit_code).toBeNull();
		expect(out.note).toContain("restarted");
		// podman exec does not propagate the client kill — the restart
		// reaped the sleeper while the filesystem survived.
		const after = await call({ action: "exec", command: "cat /work/kept; ps" });
		expect(after.output).toContain("keep");
		expect(after.output).not.toContain("sleep 60");
	});

	test("export refuses non-regular files and nothing lands in the workspace", async () => {
		const out = await call({ action: "export", from: "/work", to: "dir-out" });
		expect(out.error).toContain("not a regular file");
		expect(podmanSync(["inspect", name]).code).toBe(0);
	});
});
