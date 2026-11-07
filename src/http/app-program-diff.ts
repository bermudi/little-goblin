// What an update proposal changes versus the program it was staged
// against — the operator's answer to "what am I approving?". Pure: the
// owner supplies the immutable base and the candidate.

import { diffLines } from "../line-diff.ts";
import type { AppProgramCandidate, AppProgramChange } from "./app-wire.ts";

const CONTEXT_LINES = 2;

const LABEL: Record<AppProgramChange["field"], string> = {
	name: "Name",
	charter: "Instructions",
	cron: "Schedule",
	maxLatenessMinutes: "Allowed lateness",
	hook: "Webhook",
	mailFilter: "Mail filter",
};

function show(field: AppProgramChange["field"], c: AppProgramCandidate): string {
	switch (field) {
		case "name":
			return c.name;
		case "charter":
			return c.charter;
		case "cron":
			return c.cron ?? "none";
		case "maxLatenessMinutes":
			return c.maxLatenessMinutes === null ? "no limit" : `${c.maxLatenessMinutes} min`;
		case "hook":
			return c.hook ? "on" : "off";
		case "mailFilter":
			return c.mailFilter ?? "none";
	}
}

export function programChanges(
	base: AppProgramCandidate,
	candidate: AppProgramCandidate,
): AppProgramChange[] {
	const out: AppProgramChange[] = [];
	for (const field of Object.keys(LABEL) as AppProgramChange["field"][]) {
		if (base[field] === candidate[field]) continue;
		const before = show(field, base);
		const after = show(field, candidate);
		out.push({
			field,
			label: LABEL[field],
			before,
			after,
			lines: field === "charter" ? diffLines(before, after, CONTEXT_LINES) : null,
		});
	}
	return out;
}

/** One-line summary for the Attention card: "changes schedule, instructions". */
export function changesSummary(changes: AppProgramChange[]): string {
	return changes.length === 0
		? "no field changes"
		: `changes ${changes.map((c) => c.label.toLowerCase()).join(", ")}`;
}
