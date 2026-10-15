// The sandbox tool's own boundaries: the flat-schema/per-action union,
// workspace containment on both file directions, and image-ref
// validation. The Sandboxes dep is faked at the interface — what the
// tests pin is that a bad input never reaches podman and that exported
// bytes land inside the workspace.

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandboxes } from "../../sandboxes.ts";
import { sandboxInputSchema, sandboxTool, type SandboxToolDeps } from "./sandbox.ts";

const opts = { toolCallId: "t1", messages: [], context: {} };

let dirs: string[] = [];
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-sbx-ws-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function fakeSandboxes(recorded: { cpIn: string[][]; catFile: string[] }): Sandboxes {
	return {
		exec: async () => ({
			result: { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false },
		}),
		execArgv: async () => ({
			result: { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false },
		}),
		execBytesArgv: async () => ({
			result: {
				stdout: new Uint8Array(),
				stderr: "",
				exitCode: 0,
				timedOut: false,
				truncated: false,
			},
		}),
		cpIn: async (_conv, hostPath, containerPath) => {
			recorded.cpIn.push([hostPath, containerPath]);
			return {};
		},
		catFile: async (_conv, path) => {
			recorded.catFile.push(path);
			return { data: new TextEncoder().encode("sandbox-file-bytes") };
		},
		setNetwork: async () => ({}),
		reset: async () => ({ note: "reset" }),
	};
}

function rig(ws: string, recorded: { cpIn: string[][]; catFile: string[] }) {
	const deps: SandboxToolDeps = {
		conversation: "dm:test",
		workspace: ws,
		sandboxes: fakeSandboxes(recorded),
	};
	return sandboxTool(deps);
}

describe("sandboxInputSchema", () => {
	test("accepts every action's valid shape", () => {
		const valid = [
			{ action: "exec", command: "ls" },
			{ action: "exec", command: "ls", timeout_ms: 5000 },
			{ action: "import", from: "a.txt", to: "/work/a.txt" },
			{ action: "export", from: "/work/out.bin" },
			{ action: "export", from: "/work/out.bin", to: "results/out.bin" },
			{ action: "network", enabled: true },
			{ action: "reset" },
			{ action: "reset", image: "docker.io/library/debian:stable-slim" },
		];
		for (const v of valid) expect(sandboxInputSchema.safeParse(v).success).toBe(true);
	});

	test("rejects missing per-action fields and flag-shaped image refs", () => {
		const invalid = [
			{ action: "exec" },
			{ action: "import", from: "a" },
			{ action: "export" },
			{ action: "network" },
			{ action: "reset", image: "--privileged" },
			{ action: "reset", image: "-v" },
			{ action: "reset", image: "img; rm -rf /" },
			{ action: "nuke" },
		];
		for (const v of invalid) expect(sandboxInputSchema.safeParse(v).success).toBe(false);
	});
});

describe("sandbox tool — import containment", () => {
	test("a workspace file imports from a pinned staged copy", async () => {
		const ws = workspace();
		writeFileSync(join(ws, "payload.txt"), "x");
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "import", from: "payload.txt", to: "/work/payload.txt" },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		expect(recorded.cpIn).toHaveLength(1);
		expect(recorded.cpIn[0]![0]).not.toBe(join(ws, "payload.txt"));
		expect(recorded.cpIn[0]![1]).toBe("/work/payload.txt");
	});

	test("../ escapes are refused before touching the sandbox", async () => {
		const ws = workspace();
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "import", from: "../outside.txt", to: "/work/x" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("outside the workspace");
		expect(recorded.cpIn).toHaveLength(0);
	});

	test("a symlink whose realpath escapes the workspace is refused", async () => {
		const ws = workspace();
		const outside = join(mkdtempSync(join(tmpdir(), "goblin-sbx-ext-")), "secret.txt");
		dirs.push(join(outside, ".."));
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(ws, "innocent.txt"));
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "import", from: "innocent.txt", to: "/work/x" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("outside the workspace");
		expect(recorded.cpIn).toHaveLength(0);
	});
});

describe("sandbox tool — export containment", () => {
	test("the default destination is sandbox-out/<basename>", async () => {
		const ws = workspace();
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!({ action: "export", from: "/work/result.bin" }, opts)) as Record<
			string,
			unknown
		>;
		expect(out.error).toBeUndefined();
		expect(out.exported).toBe(join("sandbox-out", "result.bin"));
		expect(readFileSync(join(ws, "sandbox-out", "result.bin"), "utf8")).toBe("sandbox-file-bytes");
		expect(recorded.catFile).toEqual(["/work/result.bin"]);
	});

	test("absolute destinations are refused", async () => {
		const ws = workspace();
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "export", from: "/work/x", to: "/tmp/evil" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("workspace-relative");
		expect(recorded.catFile).toHaveLength(0);
	});

	test(".. escapes are refused", async () => {
		const ws = workspace();
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "export", from: "/work/x", to: "../evil.txt" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("outside the workspace");
		expect(recorded.catFile).toHaveLength(0);
	});

	test("a symlinked missing-path ancestor refuses before mkdir seeds dirs outside", async () => {
		const ws = workspace();
		const outsideDir = mkdtempSync(join(tmpdir(), "goblin-sbx-ext-"));
		dirs.push(outsideDir);
		symlinkSync(outsideDir, join(ws, "link"));
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "export", from: "/work/x", to: "link/a/b/f" },
			opts,
		)) as Record<string, unknown>;
		expect(String(out.error)).toContain("outside the workspace");
		expect(existsSync(join(outsideDir, "a"))).toBe(false);
		expect(recorded.catFile).toHaveLength(0);
	});

	test("an existing destination is overwritten, not numbered", async () => {
		const ws = workspace();
		writeFileSync(join(ws, "exists.txt"), "old-bytes");
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "export", from: "/work/x", to: "exists.txt" },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		expect(readFileSync(join(ws, "exists.txt"), "utf8")).toBe("sandbox-file-bytes");
	});

	test("a leaf symlink inside the workspace is written through, not replaced", async () => {
		const ws = workspace();
		writeFileSync(join(ws, "real.txt"), "old");
		symlinkSync("real.txt", join(ws, "link.txt"));
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const t = rig(ws, recorded);
		const out = (await t.execute!(
			{ action: "export", from: "/work/x", to: "link.txt" },
			opts,
		)) as Record<string, unknown>;
		expect(out.error).toBeUndefined();
		expect(lstatSync(join(ws, "link.txt")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(ws, "real.txt"), "utf8")).toBe("sandbox-file-bytes");
	});

	// The destination was resolved before the container read — an
	// ancestor swapped for an outside symlink while the read is held
	// must not steer the write outside.
	test("an ancestor swapped to an outside symlink mid-read is refused at write time", async () => {
		const ws = workspace();
		mkdirSync(join(ws, "sub"));
		const outsideDir = mkdtempSync(join(tmpdir(), "goblin-sbx-ext-"));
		dirs.push(outsideDir);
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const deps: SandboxToolDeps = {
			conversation: "dm:test",
			workspace: ws,
			sandboxes: {
				...fakeSandboxes(recorded),
				catFile: async (_conv, path) => {
					recorded.catFile.push(path);
					await gate;
					return { data: new TextEncoder().encode("sandbox-file-bytes") };
				},
			},
		};
		const out = sandboxTool(deps).execute!(
			{ action: "export", from: "/work/result.bin", to: "sub/result.bin" },
			opts,
		);
		await new Promise((r) => setImmediate(r));
		expect(recorded.catFile).toEqual(["/work/result.bin"]);
		rmSync(join(ws, "sub"), { recursive: true });
		symlinkSync(outsideDir, join(ws, "sub"));
		release();
		const res = (await out) as Record<string, unknown>;
		expect(String(res.error)).toContain("outside the workspace");
		expect(existsSync(join(outsideDir, "result.bin"))).toBe(false);
	});

	test("an export cancelled while the container read is pending never writes the host file", async () => {
		const ws = workspace();
		const recorded = { cpIn: [] as string[][], catFile: [] as string[] };
		const controller = new AbortController();
		// Hold catFile open so the abort lands inside the wait.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const deps: SandboxToolDeps = {
			conversation: "dm:test",
			workspace: ws,
			sandboxes: {
				...fakeSandboxes(recorded),
				catFile: async (_conv, path) => {
					recorded.catFile.push(path);
					await gate;
					return { data: new TextEncoder().encode("sandbox-file-bytes") };
				},
			},
		};
		const out = sandboxTool(deps).execute!(
			{ action: "export", from: "/work/result.bin" },
			{ ...opts, abortSignal: controller.signal },
		);
		controller.abort();
		release();
		await expect(out).rejects.toThrow();
		expect(recorded.catFile).toEqual(["/work/result.bin"]);
		expect(existsSync(join(ws, "sandbox-out", "result.bin"))).toBe(false);
	});
});
