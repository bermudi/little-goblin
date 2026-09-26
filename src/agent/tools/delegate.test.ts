// The delegate tool's boundary contract: only configured harnesses run,
// the concurrency cap and cwd checks reject before any herdr call, and
// a successful start leaves a pinned, bound row herdr knows about.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDelegations, type DelegationsStore } from "../../delegations.ts";
import { HerdrError, type AgentInfo, type Herdr } from "../../herdr.ts";
import { delegateTool, type DelegateToolDeps } from "./delegate.ts";

let dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function agent(name: string): AgentInfo {
	return {
		agent: "codex",
		agent_status: "working",
		name,
		pane_id: "w1:p1",
		workspace_id: "w1",
		state_change_seq: 7,
		cwd: "/w",
	};
}

interface Harness {
	tool: ReturnType<typeof delegateTool>;
	store: DelegationsStore;
	prompts: string[];
	closed: string[];
	herdr: Herdr;
	workspaceDir: string;
}

function harness(maxRunning = 3, startError?: string): Harness {
	const dir = mkdtempSync(join(tmpdir(), "goblin-delegtool-"));
	dirs.push(dir);
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	const store = openDelegations(join(dir, "goblin.sqlite"));
	const prompts: string[] = [];
	const closed: string[] = [];
	const herdr: Herdr = {
		createWorkspace: (cwd, label) =>
			Promise.resolve({ workspaceId: "w1", paneId: "w1:p1" }),
		startAgent: (name) =>
			startError
				? Promise.reject(new HerdrError("agent start", "agent_not_ready", startError))
				: Promise.resolve(agent(name)),
		get: (name) => Promise.resolve(agent(name)),
		prompt: (_name, text) => {
			prompts.push(text);
			return Promise.resolve();
		},
		readAgent: () => Promise.resolve("agent screen"),
		readPane: () => Promise.resolve("pane screen"),
		interrupt: () => Promise.resolve(),
		closeWorkspace: (id) => {
			closed.push(id);
			return Promise.resolve();
		},
	};
	const deps: DelegateToolDeps = {
		delegations: store,
		herdr,
		config: {
			session: "goblin",
			maxRunning,
			harnesses: {
				codex: { kind: "codex", args: ["--sandbox", "workspace-write"] },
				pi: { kind: "pi" },
			},
		},
		chatId: -100,
		threadId: 7,
		workspaceDir,
		delegationsDir: join(dir, "delegations"),
	};
	return { tool: delegateTool(deps), store, prompts, closed, herdr, workspaceDir };
}

const exec = (t: ReturnType<typeof delegateTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("delegate tool", () => {
	test("an unknown harness is rejected listing the configured ones", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "claude",
			task: "do it",
		})) as { error: string };
		expect(out.error).toContain('unknown harness "claude"');
		expect(out.error).toContain("codex");
		expect(out.error).toContain("pi");
	});

	test("the running cap refuses, naming what's running", async () => {
		const h = harness(1);
		const d = h.store.create({
			name: "occupant",
			harness: "codex",
			cwd: "/w",
			task: "t",
			address: { chatId: -100, threadId: 7 },
		});
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
		})) as { error: string };
		expect(out.error).toContain("cap reached");
		expect(out.error).toContain("occupant");
	});

	test("a bad cwd is rejected before any herdr call", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
			cwd: "no-such-dir",
		})) as { error: string };
		expect(out.error).toContain("does not exist");
		expect(h.prompts).toEqual([]);
	});

	test("start launches, prompts with the report instruction, and binds the row", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "refactor the parser",
			name: "parser work",
		})) as { id: number; agent_name: string; attach: string };
		expect(out.id).toBeGreaterThan(0);
		expect(out.agent_name).toBe("g1-parser-work");
		expect(out.attach).toBe("herdr session attach goblin");
		expect(h.prompts).toHaveLength(1);
		expect(h.prompts[0]).toContain("refactor the parser");
		expect(h.prompts[0]).toContain("final report");
		expect(h.prompts[0]).toContain(`delegations/${out.id}/report.md`);
		const row = h.store.get(out.id)!;
		expect(row.status).toBe("running");
		expect(row.chatId).toBe(-100);
		expect(row.threadId).toBe(7);
		expect(row.baselineSeq).toBe(7); // from the post-prompt get
		expect(row.agentName).toBe("g1-parser-work");
	});

	test("a blocked start fails the row, closes the workspace, and returns the screen", async () => {
		const h = harness(3, "agent g1-x is blocked during startup and is not ready");
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
			name: "x",
		})) as { error: string };
		expect(out.error).toContain("blocked during startup");
		expect(out.error).toContain("pane screen");
		expect(h.closed).toEqual(["w1"]);
		expect(h.store.get(1)!.status).toBe("failed");
	});

	test("send re-prompts, resets the baseline, and flips needs_input back to running", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
			name: "x",
		})) as { id: number };
		h.store.setStatus(out.id, "needs_input");
		const sent = (await exec(h.tool, {
			action: "send",
			id: out.id,
			text: "yes, proceed",
		})) as { sent: number; status: string };
		expect(sent.status).toBe("running");
		expect(h.prompts[1]).toBe("yes, proceed");
		expect(h.store.get(out.id)!.status).toBe("running");
	});

	test("send re-prompts a finished delegation; stopped refuses", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
			name: "x",
		})) as { id: number };
		h.store.setStatus(out.id, "done");
		expect(h.store.get(out.id)!.finishedAt).not.toBeNull();
		const sent = (await exec(h.tool, {
			action: "send",
			id: out.id,
			text: "also fix the tests",
		})) as { sent: number; status: string };
		expect(sent.status).toBe("running");
		expect(h.prompts[1]).toBe("also fix the tests");
		const row = h.store.get(out.id)!;
		expect(row.status).toBe("running");
		expect(row.finishedAt).toBeNull(); // setStatus cleared it

		h.store.setStatus(out.id, "stopped");
		const refused = (await exec(h.tool, {
			action: "send",
			id: out.id,
			text: "hi",
		})) as { error: string };
		expect(refused.error).toContain("stopped");
		expect(h.prompts).toHaveLength(2);
	});

	test("stop interrupts a live agent and closes its workspace", async () => {
		const h = harness();
		const out = (await exec(h.tool, {
			action: "start",
			harness: "codex",
			task: "do it",
			name: "x",
		})) as { id: number };
		const stopped = (await exec(h.tool, { action: "stop", id: out.id })) as {
			stopped: number;
		};
		expect(stopped.stopped).toBe(out.id);
		expect(h.closed).toEqual(["w1"]);
		expect(h.store.get(out.id)!.status).toBe("stopped");
	});
});
