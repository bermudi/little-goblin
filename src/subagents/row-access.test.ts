import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSubagentRuns, type SubagentRun, type SubagentRuns } from "../subagent-runs.ts";
import { SubagentError } from "./errors.ts";
import { makeRowAccess } from "./row-access.ts";

const dirs: string[] = [];
const stores: SubagentRuns[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function rig() {
	const dir = mkdtempSync(join(tmpdir(), "goblin-ra-"));
	dirs.push(dir);
	const runs = openSubagentRuns(join(dir, "runs.sqlite"));
	stores.push(runs);
	const flags = { closing: false, harnessClosed: false };
	const access = makeRowAccess({
		runs,
		isClosing: () => flags.closing,
		isHarnessClosed: () => flags.harnessClosed,
	});
	const run = (patch: Partial<SubagentRun> = {}): SubagentRun => {
		const row = runs.create({
			kind: "worker",
			conversationId: "dm:1",
			workspace: "/w",
			task: "t",
		});
		return runs.update(row.id, { status: "running", ...patch });
	};
	return { runs, flags, access, run };
}

describe("rowForConversation", () => {
	test("maps the persisted pi id back to its row; unknown ids answer null", () => {
		const { access, run } = rig();
		const r = run({ piConversationId: "42" });
		expect(access.rowForConversation("42")?.id).toBe(r.id);
		expect(access.rowForConversation("nope")).toBeNull();
	});
});

describe("requireLive", () => {
	test("a running row passes; closing, harness-closed, stop intent and parked rows refuse", () => {
		const { access, run } = rig();
		const live = run();
		expect(() => access.requireLive(live)).not.toThrow();
		const stopped = run({ status: "stopped", stopRequested: true });
		expect(() => access.requireLive(stopped)).toThrow(SubagentError);
		const done = run({ status: "done" });
		expect(() => access.requireLive(done)).toThrow(/is done — not executing/);
	});
	test("the owner-level flags refuse even a live row", () => {
		const { access, run, flags } = rig();
		const r = run();
		flags.closing = true;
		expect(() => access.requireLive(r)).toThrow(/harness is closed/);
		flags.closing = false;
		flags.harnessClosed = true;
		expect(() => access.requireLive(r)).toThrow(/harness is closed/);
	});
});

describe("throwIfHalted", () => {
	test("closing owner, vanished row, and stopped rows each name their refusal", () => {
		const { access, run, runs } = rig();
		const live = run();
		expect(() => access.throwIfHalted(live.id)).not.toThrow();
		expect(() => access.throwIfHalted(99999)).toThrow(/run row vanished/);
		const stopped = run({ status: "stopped", stopRequested: true });
		expect(() => access.throwIfHalted(stopped.id)).toThrow(/stopped/);
		const halted = rig();
		const r2 = halted.runs.create({
			kind: "worker",
			conversationId: "dm:1",
			workspace: "/w",
			task: "t",
		});
		halted.flags.closing = true;
		expect(() => halted.access.throwIfHalted(r2.id)).toThrow(/owner closing/);
	});
});

describe("persistClaimNote", () => {
	test("empty notes, missing rows and stopped rows never write; a live row takes the note", () => {
		const { access, run, runs } = rig();
		const live = run();
		access.persistClaimNote(live.id, "desktop recreated");
		expect(runs.get(live.id)?.lifecycleNote).toBe("desktop recreated");
		access.persistClaimNote(live.id, "");
		expect(runs.get(live.id)?.lifecycleNote).toBe("desktop recreated");
		access.persistClaimNote(99999, "orphan");
		const stopped = run({ status: "stopped", stopRequested: true });
		access.persistClaimNote(stopped.id, "too late");
		expect(runs.get(stopped.id)?.lifecycleNote).toBeNull();
	});
});

describe("holderFor", () => {
	test("the lease holder names the run by id", () => {
		const { access } = rig();
		expect(access.holderFor(7)).toEqual({ kind: "run", id: "7" });
	});
});
