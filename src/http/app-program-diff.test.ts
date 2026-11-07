import { expect, test } from "bun:test";
import { changesSummary, programChanges } from "./app-program-diff.ts";
import type { AppProgramCandidate } from "./app-wire.ts";

const BASE: AppProgramCandidate = {
	name: "digest",
	charter: "Summarise the inbox.\nNever send mail.\nKeep it short.",
	cron: "0 9 * * *",
	maxLatenessMinutes: 30,
	hook: false,
	mailFilter: null,
};

test("unchanged fields are omitted; changed ones read old and new", () => {
	const changes = programChanges(BASE, {
		...BASE,
		cron: "0 7 * * *",
		maxLatenessMinutes: null,
		charter: `${BASE.charter}\nYou may also send mail.`,
	});
	expect(changes.map((c) => [c.field, c.before, c.after])).toEqual([
		["charter", BASE.charter, `${BASE.charter}\nYou may also send mail.`],
		["cron", "0 9 * * *", "0 7 * * *"],
		["maxLatenessMinutes", "30 min", "no limit"],
	]);
	const charter = changes.find((c) => c.field === "charter")!;
	expect(charter.lines).toEqual([
		{ op: "gap", skipped: 1 },
		{ op: "ctx", text: "Never send mail." },
		{ op: "ctx", text: "Keep it short." },
		{ op: "add", text: "You may also send mail." },
	]);
	expect(changes.find((c) => c.field === "cron")!.lines).toBeNull();
	expect(changesSummary(changes)).toBe("changes instructions, schedule, allowed lateness");
});

test("an identical candidate has no changes", () => {
	expect(programChanges(BASE, { ...BASE })).toEqual([]);
});
