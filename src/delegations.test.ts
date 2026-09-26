// The delegation watcher's boundary contract: transitions fire on the
// herdr-reported state, done requires a seq advance past the prompt
// baseline, notifications land through wake exactly once, the report
// file beats the screen (capped at 16 KiB), and a fresh watcher over
// the same DB resumes where the dead one left off.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentNameFor,
	openDelegations,
	startDelegationWatcher,
	type Delegation,
	type DelegationWatcherDeps,
	type DelegationsStore,
} from "./delegations.ts";
import type { AgentInfo, Herdr } from "./herdr.ts";

let dirs: string[] = [];
function tmpdirPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-deleg-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function agent(name: string, status: string, seq: number): AgentInfo {
	return {
		agent: "codex",
		agent_status: status,
		name,
		pane_id: "w1:p1",
		workspace_id: "w1",
		state_change_seq: seq,
		cwd: "/w",
	};
}

interface Harness {
	deps: DelegationWatcherDeps;
	store: DelegationsStore;
	dbPath: string;
	agents: Map<string, AgentInfo | null>;
	screens: Map<string, string>;
	wakes: string[];
	delegationsDir: string;
}

function harness(): Harness {
	const dir = tmpdirPath();
	const dbPath = join(dir, "goblin.sqlite");
	const store = openDelegations(dbPath);
	const delegationsDir = join(dir, "delegations");
	const agents = new Map<string, AgentInfo | null>();
	const screens = new Map<string, string>();
	const wakes: string[] = [];
	const herdr: Herdr = {
		createWorkspace: () => Promise.reject(new Error("not used")),
		startAgent: () => Promise.reject(new Error("not used")),
		get: (name) => Promise.resolve(agents.get(name) ?? null),
		prompt: () => Promise.resolve(),
		readAgent: (name) =>
			Promise.resolve(screens.get(`agent:${name}`) ?? `agent screen ${name}`),
		readPane: (id) =>
			Promise.resolve(screens.get(`pane:${id}`) ?? `pane screen ${id}`),
		interrupt: () => Promise.resolve(),
		closeWorkspace: () => Promise.resolve(),
	};
	return {
		store,
		dbPath,
		agents,
		screens,
		wakes,
		delegationsDir,
		deps: {
			delegations: store,
			herdr,
			delegationsDir,
			wake: (_a, text) => {
				wakes.push(text);
				return true;
			},
		},
	};
}

// A row as the delegate tool leaves it: bound launch ids, baseline and
// prompt time recorded.
function runningRow(
	h: Harness,
	name = "fix the thing",
	seq = 1,
	promptedAgoMs = 0,
): Delegation {
	const d = h.store.create({
		name,
		harness: "codex",
		cwd: "/w",
		task: "do it",
		address: { chatId: 1, threadId: null },
	});
	h.store.bindLaunch(d.id, {
		agentName: agentNameFor(d.id, name),
		workspaceId: "w1",
		paneId: "w1:p1",
	});
	h.store.markPrompted(d.id, seq, new Date(Date.now() - promptedAgoMs));
	return h.store.get(d.id)!;
}

describe("delegation watcher", () => {
	test("idle at baseline stays running; done needs a seq advance", async () => {
		const h = harness();
		const d = runningRow(h, "fix it", 5);
		h.agents.set(d.agentName, agent(d.agentName, "idle", 5));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		expect(h.store.get(d.id)!.status).toBe("running");
		expect(h.wakes).toEqual([]);

		h.agents.set(d.agentName, agent(d.agentName, "idle", 6));
		await w.tick();
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("done");
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toContain("[delegation: fix it · done]");
	});

	test("blocked notifies needs_input exactly once across ticks", async () => {
		const h = harness();
		const d = runningRow(h, "stuck", 1);
		h.agents.set(d.agentName, agent(d.agentName, "blocked", 2));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		expect(h.store.get(d.id)!.status).toBe("needs_input");
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toContain("[delegation: stuck · needs input]");

		await w.tick(); // still blocked — the row status IS the once
		w.stop();
		expect(h.wakes).toHaveLength(1);
	});

	test("a needs_input row back at work flips to running silently", async () => {
		const h = harness();
		const d = runningRow(h, "resume", 1);
		h.agents.set(d.agentName, agent(d.agentName, "blocked", 2));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		h.agents.set(d.agentName, agent(d.agentName, "working", 3));
		await w.tick();
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("running");
		expect(h.wakes).toHaveLength(1); // only the first needs_input notice
	});

	test("a parked row whose agent finished reads done in one tick", async () => {
		const h = harness();
		const d = runningRow(h, "handed off", 1);
		h.agents.set(d.agentName, agent(d.agentName, "blocked", 2));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		expect(h.store.get(d.id)!.status).toBe("needs_input");
		expect(h.store.get(d.id)!.baselineSeq).toBe(2); // re-baselined at the park
		// The operator answered via herdr attach — the poll never saw
		// "working", but the seq moved past the park point.
		h.agents.set(d.agentName, agent(d.agentName, "idle", 5));
		await w.tick();
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("done");
		expect(h.wakes).toHaveLength(2);
		expect(h.wakes[1]).toContain("[delegation: handed off · done]");
	});

	test("idle at baseline with a report file is done, not stalled", async () => {
		const h = harness();
		// Prompted 1 s ago — inside the stall window, but the report
		// written after the prompt is fresh.
		const d = runningRow(h, "fast finisher", 3, 1_000);
		h.agents.set(d.agentName, agent(d.agentName, "idle", 3));
		mkdirSync(join(h.delegationsDir, String(d.id)), { recursive: true });
		writeFileSync(join(h.delegationsDir, String(d.id), "report.md"), "# done");
		const w = startDelegationWatcher(h.deps);
		await w.tick(); // well inside the 90 s stall window
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("done");
		expect(h.wakes[0]).toContain("[delegation: fast finisher · done]");
	});

	test("agent gone → failed, notice carries the pane tail", async () => {
		const h = harness();
		const d = runningRow(h, "died", 1);
		h.screens.set(`pane:${d.paneId}`, "codex exited: oom");
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("failed");
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toContain("[delegation: died · failed]");
		expect(h.wakes[0]).toContain("codex exited: oom");
	});

	test("the report file beats the screen and caps at 16 KiB", async () => {
		const h = harness();
		const d = runningRow(h, "big report", 1);
		h.agents.set(d.agentName, agent(d.agentName, "idle", 2));
		mkdirSync(join(h.delegationsDir, String(d.id)), { recursive: true });
		const reportPath = join(h.delegationsDir, String(d.id), "report.md");
		writeFileSync(reportPath, "x".repeat(20 * 1024));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		w.stop();
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toContain(`… full report at ${reportPath}`);
		expect(h.wakes[0]).not.toContain("agent screen");
		expect(h.wakes[0]!.length).toBeLessThan(17 * 1024);
	});

	test("a small report file is used whole, screen ignored", async () => {
		const h = harness();
		const d = runningRow(h, "report", 1);
		h.agents.set(d.agentName, agent(d.agentName, "done", 4));
		mkdirSync(join(h.delegationsDir, String(d.id)), { recursive: true });
		writeFileSync(join(h.delegationsDir, String(d.id), "report.md"), "# Done\nall good");
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		w.stop();
		expect(h.wakes[0]).toContain("# Done\nall good");
		expect(h.wakes[0]).not.toContain("agent screen");
	});

	test("idle with no seq advance 90s after prompting → needs_input", async () => {
		const h = harness();
		const d = runningRow(h, "asleep", 2, 91_000);
		h.agents.set(d.agentName, agent(d.agentName, "idle", 2));
		const w = startDelegationWatcher(h.deps);
		await w.tick();
		w.stop();
		expect(h.store.get(d.id)!.status).toBe("needs_input");
		expect(h.wakes[0]).toContain("startup dialog");
	});

	test("a second watcher over the same DB resumes a running row", async () => {
		const h = harness();
		const d = runningRow(h, "survivor", 1);
		h.agents.set(d.agentName, agent(d.agentName, "working", 2));
		const w1 = startDelegationWatcher(h.deps);
		await w1.tick();
		w1.stop();
		h.store.close();
		expect(h.wakes).toEqual([]);

		// Process "restarts": fresh connection, fresh watcher, same rows.
		const h2 = harness();
		const store2 = openDelegations(h.dbPath);
		h2.deps = { ...h2.deps, delegations: store2, delegationsDir: h.delegationsDir };
		h2.agents.set(d.agentName, agent(d.agentName, "done", 3));
		const w2 = startDelegationWatcher(h2.deps);
		await w2.tick();
		w2.stop();
		expect(store2.get(d.id)!.status).toBe("done");
		expect(h2.wakes[0]).toContain("[delegation: survivor · done]");
	});
});

describe("agentNameFor", () => {
	test("slugifies into herdr's name charset, capped at 32", () => {
		expect(agentNameFor(3, "Fix the THING!!")).toBe("g3-fix-the-thing");
		expect(agentNameFor(12, "résumé — unicode ✨")).toMatch(/^g12-[a-z0-9_-]+$/);
		expect(agentNameFor(9, "x".repeat(60)).length).toBeLessThanOrEqual(32);
		expect(agentNameFor(4, "!!!")).toBe("g4-delegation");
	});
});
