// The grant boundary's durable half: proposals are never active rows,
// approval is one atomic transaction bound to an immutable base
// fingerprint, and history is append-only. These tests drive the real
// store — trusted create() seeds fixtures exactly like production's
// grandfathered rows, never the tool.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { setLogFile, setLogWriter } from "./log.ts";
import {
	openProgramProposals,
	type ProgramDraft,
	type ProgramProposalsDeps,
} from "./program-proposals.ts";
import { openPrograms, ProgramRuleError, type ProgramsStore } from "./programs.ts";
import { tmpDb } from "./testkit.ts";

setLogWriter(() => {});
setLogFile(null);

const ADDRESS = { chatId: -100, threadId: 7 };
const NOW = new Date("2026-09-20T10:00:00");

function store(path = tmpDb("goblin-proposals-")): ProgramsStore {
	return openPrograms(path);
}

function draft(overrides: Partial<ProgramDraft> = {}): ProgramDraft {
	return {
		name: "reports",
		charter: "Own the weekly report: draft it, send it, escalate when blocked.",
		cron: "0 9 * * 1",
		maxLatenessMinutes: 60,
		hook: false,
		mailFilter: null,
		...overrides,
	};
}

describe("program proposals — create", () => {
	test("a proposed create writes no programs row and is invisible to every trigger path", () => {
		const programs = store();
		const proposal = programs.proposals.proposeCreate(
			draft({ hook: true, mailFilter: "from:bank" }),
			ADDRESS,
			NOW,
		);

		expect(proposal.state).toBe("pending");
		expect(programs.list()).toEqual([]);
		// No cron fire, no mail watch, no webhook reverse-lookup — the
		// candidate exists only as a proposal row.
		expect(programs.due(new Date("2030-01-01T00:00:00"))).toEqual([]);
		expect(programs.withMailFilter()).toEqual([]);
		expect(programs.findByHook("whatever")).toBeNull();
		expect(programs.proposals.pending().map((p) => p.id)).toEqual([proposal.id]);
		programs.close();
	});

	test("approval creates exactly the full candidate at the pinned address", () => {
		const programs = store();
		const proposal = programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
		const outcome = programs.proposals.approve(proposal.id, 42, {
			now: new Date("2026-09-21T08:00:00"),
		});

		expect(outcome.kind).toBe("activated");
		if (outcome.kind !== "activated") throw new Error("unreachable");
		const program = outcome.program;
		expect(program.name).toBe("reports");
		expect(program.charter).toBe(draft().charter);
		expect(program.cron).toBe("0 9 * * 1");
		expect(program.maxLatenessMinutes).toBe(60);
		expect(program.hookHash).toBeNull();
		expect(program.mailFilter).toBeNull();
		expect(program.chatId).toBe(ADDRESS.chatId);
		expect(program.threadId).toBe(ADDRESS.threadId);
		expect(program.enabled).toBe(true);
		expect(program.nextRun).not.toBeNull();
		// Scheduled but not yet owed — next_run is in the future.
		expect(programs.due(NOW)).toEqual([]);
		expect(programs.get(program.id)).not.toBeNull();
		expect(outcome.proposal.state).toBe("approved");
		expect(outcome.proposal.decidedBy).toBe(42);
		expect(outcome.proposal.activatedId).toBe(program.id);
		programs.close();
	});

	test("a repeated approval tap can never activate twice", () => {
		const programs = store();
		const proposal = programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
		expect(programs.proposals.approve(proposal.id, 42).kind).toBe("activated");
		const again = programs.proposals.approve(proposal.id, 42);
		expect(again.kind).toBe("refused");
		if (again.kind !== "refused") throw new Error("unreachable");
		expect(again.refusal).toBe("decided");
		expect(programs.list()).toHaveLength(1);
		programs.close();
	});

	test("rejection creates nothing and stamps the decision", () => {
		const programs = store();
		const proposal = programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
		const outcome = programs.proposals.reject(proposal.id, 7, new Date("2026-09-20T11:00:00"));
		expect(outcome.kind).toBe("rejected");
		expect(programs.list()).toEqual([]);
		expect(programs.proposals.get(proposal.id)!.state).toBe("rejected");
		expect(programs.proposals.get(proposal.id)!.decidedBy).toBe(7);
		expect(programs.proposals.approve(proposal.id, 7).kind).toBe("refused");
		programs.close();
	});

	test("a proposal survives close/reopen and approves once afterwards", () => {
		const path = tmpDb("goblin-proposals-");
		const first = openPrograms(path);
		const proposal = first.proposals.proposeCreate(draft(), ADDRESS, NOW);
		first.close();

		const reopened = openPrograms(path);
		const pending = reopened.proposals.pending();
		expect(pending.map((p) => p.id)).toEqual([proposal.id]);
		expect(pending[0]!.draft).toEqual(draft());
		expect(reopened.proposals.approve(proposal.id, 42).kind).toBe("activated");
		expect(reopened.list()).toHaveLength(1);
		expect(reopened.proposals.approve(proposal.id, 42).kind).toBe("refused");
		reopened.close();
	});

	test("an invalid candidate fails before any row lands — nothing to approve", () => {
		const programs = store();
		expect(() => programs.proposals.proposeCreate(draft({ cron: null }), ADDRESS)).toThrow(
			ProgramRuleError,
		);
		expect(() =>
			programs.proposals.proposeCreate(draft({ cron: "not a cron" }), ADDRESS),
		).toThrow();
		expect(() =>
			programs.proposals.proposeCreate(
				draft({ cron: null, mailFilter: "f", maxLatenessMinutes: 5 }),
				ADDRESS,
			),
		).toThrow(ProgramRuleError);
		expect(programs.proposals.pending()).toEqual([]);
		expect(programs.list()).toEqual([]);
		programs.close();
	});

	test("a hook request without the minted hash refuses — pending and unactivated", () => {
		const programs = store();
		const proposal = programs.proposals.proposeCreate(
			draft({ cron: null, maxLatenessMinutes: null, hook: true }),
			ADDRESS,
			NOW,
		);
		const outcome = programs.proposals.approve(proposal.id, 42);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.refusal).toBe("hook-unsatisfied");
		expect(programs.proposals.get(proposal.id)!.state).toBe("pending");
		expect(programs.list()).toEqual([]);

		const granted = programs.proposals.approve(proposal.id, 42, { hookHash: "hash-1" });
		expect(granted.kind).toBe("activated");
		expect(programs.findByHook("hash-1")).not.toBeNull();
		programs.close();
	});
});

describe("program proposals — update", () => {
	test("a charter patch stays a proposal — the live row is untouched until approved", () => {
		const programs = store();
		const program = programs.create(
			{
				name: "old",
				charter: "old charter",
				cron: "0 9 * * *",
				address: ADDRESS,
			},
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(
			program.id,
			{ charter: "new charter", name: "renamed" },
			ADDRESS,
		);
		expect(proposal.kind).toBe("update");
		expect(proposal.targetId).toBe(program.id);
		expect(programs.get(program.id)!.charter).toBe("old charter");
		expect(programs.get(program.id)!.name).toBe("old");

		const outcome = programs.proposals.approve(proposal.id, 42);
		expect(outcome.kind).toBe("activated");
		expect(programs.get(program.id)!.charter).toBe("new charter");
		expect(programs.get(program.id)!.name).toBe("renamed");
		programs.close();
	});

	test("the whole requested patch lands atomically — including direct-safe fields", () => {
		const programs = store();
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const before = program.nextRun;
		// Mixed patch: a grant-shaped charter change plus a reschedule
		// and a name edit — all stage together, all land together.
		const proposal = programs.proposals.proposeUpdate(
			program.id,
			{ charter: "wider charter", cron: "30 10 * * *", name: "p2" },
			ADDRESS,
		);
		expect(programs.get(program.id)!.cron).toBe("0 9 * * *");
		expect(programs.get(program.id)!.nextRun).toBe(before);

		expect(programs.proposals.approve(proposal.id, 42).kind).toBe("activated");
		const after = programs.get(program.id)!;
		expect(after.charter).toBe("wider charter");
		expect(after.cron).toBe("30 10 * * *");
		expect(after.name).toBe("p2");
		expect(after.nextRun).not.toBe(before);
		programs.close();
	});

	test("a direct edit between proposal and approval stales it — nothing applies", () => {
		const programs = store();
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		programs.update(program.id, { name: "edited" });
		const outcome = programs.proposals.approve(proposal.id, 42);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.refusal).toBe("stale");
		expect(programs.get(program.id)!.charter).toBe("c");
		expect(programs.get(program.id)!.name).toBe("edited");
		expect(programs.proposals.get(proposal.id)!.state).toBe("pending");
		programs.close();
	});

	test("a deleted target refuses — the proposal stays pending, nothing applied", () => {
		const programs = store();
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		programs.remove(program.id);
		const outcome = programs.proposals.approve(proposal.id, 42);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.refusal).toBe("target-gone");
		expect(programs.proposals.get(proposal.id)!.state).toBe("pending");
		programs.close();
	});

	test("a newer pending update supersedes the older one — only the newest can activate", () => {
		const programs = store();
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const first = programs.proposals.proposeUpdate(program.id, { charter: "v2" }, ADDRESS);
		const second = programs.proposals.proposeUpdate(program.id, { charter: "v3" }, ADDRESS);
		expect(programs.proposals.get(first.id)!.state).toBe("superseded");
		expect(programs.proposals.get(second.id)!.state).toBe("pending");

		const stale = programs.proposals.approve(first.id, 42);
		expect(stale.kind).toBe("refused");
		if (stale.kind !== "refused") throw new Error("unreachable");
		expect(stale.refusal).toBe("superseded");
		expect(programs.get(program.id)!.charter).toBe("c");

		expect(programs.proposals.approve(second.id, 42).kind).toBe("activated");
		expect(programs.get(program.id)!.charter).toBe("v3");
		programs.close();
	});

	test("run and cursor accounting never stales a proposal", () => {
		const programs = store();
		const program = programs.create(
			{
				name: "p",
				charter: "c",
				cron: "0 9 * * *",
				mailFilter: "from:bank",
				address: ADDRESS,
			},
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		programs.markRan(program.id, new Date("2026-09-20T10:30:00"));
		programs.markFired(program.id, new Date("2026-09-20T10:31:00"));
		expect(
			programs.setMailHistory(program.id, "history-99", programs.get(program.id)!.mailRevision),
		).toBe(true);
		expect(programs.proposals.approve(proposal.id, 42).kind).toBe("activated");
		programs.close();
	});

	test("proposing on a vanished target throws before any row lands", () => {
		const programs = store();
		expect(() => programs.proposals.proposeUpdate(999, { charter: "x" }, ADDRESS)).toThrow();
		expect(programs.proposals.pending()).toEqual([]);
		programs.close();
	});

	test("a patch that would remove the last trigger fails at proposal time", () => {
		const programs = store();
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		expect(() =>
			programs.proposals.proposeUpdate(program.id, { charter: "wider", cron: null }, ADDRESS),
		).toThrow(ProgramRuleError);
		expect(programs.proposals.pending()).toEqual([]);
		programs.close();
	});

	test("a malformed stored payload fails loud at read", () => {
		const path = tmpDb("goblin-proposals-");
		const programs = openPrograms(path);
		const proposal = programs.proposals.proposeCreate(draft(), ADDRESS, NOW);
		const db = new Database(path);
		db.query("UPDATE program_proposals SET payload = '{nope' WHERE id = ?").run(proposal.id);
		db.close();
		expect(() => programs.proposals.get(proposal.id)).toThrow(/corrupt payload/);
		programs.close();
	});

	test("an update proposal stores its renderable base snapshot — the immutable render survives reopen", () => {
		const path = tmpDb("goblin-proposals-");
		const programs = openPrograms(path);
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		expect(proposal.baseSnapshot).toEqual({
			name: "p",
			charter: "c",
			cron: "0 9 * * *",
			maxLatenessMinutes: null,
			hook: false,
			mailFilter: null,
		});
		// The live row moving never rewrites the stored snapshot.
		programs.update(program.id, { cron: "0 10 * * *" });
		expect(programs.proposals.get(proposal.id)!.baseSnapshot?.cron).toBe("0 9 * * *");
		programs.close();
		const reopened = openPrograms(path);
		expect(reopened.proposals.get(proposal.id)!.baseSnapshot?.cron).toBe("0 9 * * *");
		reopened.close();
	});

	test("a pre-snapshot schema migrates in place — legacy rows read null and stay decidable", () => {
		const path = tmpDb("goblin-proposals-");
		const first = openPrograms(path);
		const program = first.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = first.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		first.close();
		// Rewind to the pre-snapshot schema, then reopen: the ALTER runs
		// and the legacy row reads a null snapshot without breaking reads.
		const db = new Database(path);
		db.run("ALTER TABLE program_proposals DROP COLUMN base_snapshot");
		db.close();
		const reopened = openPrograms(path);
		const legacy = reopened.proposals.get(proposal.id)!;
		expect(legacy.baseSnapshot).toBeNull();
		expect(reopened.proposals.approve(legacy.id, 42).kind).toBe("activated");
		reopened.close();
	});

	test("a corrupt stored snapshot fails loud at read", () => {
		const path = tmpDb("goblin-proposals-");
		const programs = openPrograms(path);
		const program = programs.create(
			{ name: "p", charter: "c", cron: "0 9 * * *", address: ADDRESS },
			NOW,
		);
		const proposal = programs.proposals.proposeUpdate(program.id, { charter: "wider" }, ADDRESS);
		const db = new Database(path);
		db.query("UPDATE program_proposals SET base_snapshot = '{nope' WHERE id = ?").run(proposal.id);
		db.close();
		expect(() => programs.proposals.get(proposal.id)).toThrow(/corrupt base snapshot/);
		programs.close();
	});
});

describe("program proposals — atomicity", () => {
	test("a write failure inside approval rolls activation and the decision back together", () => {
		// Drive the helper directly so the failing write lands inside
		// its own transaction — the production path can't inject this.
		const db = new Database(":memory:");
		const deps: ProgramProposalsDeps = {
			core: {
				get: () => null,
				create() {
					throw new Error("injected sqlite write failure");
				},
				update: () => null,
			},
			validateCreate: () => {},
			validateUpdate: () => {},
		};
		const proposals = openProgramProposals(db, deps);
		const proposal = proposals.proposeCreate(draft(), ADDRESS, NOW);
		expect(() => proposals.approve(proposal.id, 42)).toThrow("injected sqlite write failure");
		expect(proposals.get(proposal.id)!.state).toBe("pending");
		db.close();
	});

	test("existing active programs survive opening the schema unchanged", () => {
		const path = tmpDb("goblin-proposals-");
		const first = openPrograms(path);
		const program = first.create(
			{
				name: "grandfathered",
				charter: "already standing",
				cron: "0 9 * * *",
				hookHash: "h",
				mailFilter: "f",
				address: ADDRESS,
			},
			NOW,
		);
		first.close();
		const reopened = openPrograms(path);
		const same = reopened.get(program.id)!;
		expect(same.charter).toBe("already standing");
		expect(same.hookHash).toBe("h");
		expect(same.mailFilter).toBe("f");
		expect(same.nextRun).toBe(program.nextRun);
		// Grandfathered rows were never proposals — no approval asks
		// about them, no rows reference them.
		expect(reopened.proposals.list()).toEqual([]);
		reopened.close();
	});
});
