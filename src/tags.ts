// One module owns every marker spelling: a typo fails one schema
// instead of silently changing what reaches memory.

// Opens a program fire's machinery speech; the prefix is what
// isMachineryText matches on. #493-L18 — the occurrence names the
// schedule occurrence a late catch-up stands in for (absent on
// non-schedule triggers), and a coalesced count >1 says how many
// missed occurrences this one fire covers.
export function programFireTag(
	name: string,
	trigger: string,
	opts?: { occurrence?: Date | undefined; missed?: number | undefined },
): string {
	const extra =
		(opts?.occurrence !== undefined ? ` · occurrence: ${opts.occurrence.toISOString()}` : "") +
		(opts !== undefined && (opts.missed ?? 0) > 1 ? ` · coalesced: ${opts.missed}` : "");
	return `[program: ${name} · trigger: ${trigger}${extra}]`;
}

// Opens a delegation notice, same machinery-speech prefix rule; extra
// rides after the verdict, space-separated.
export function delegationNoticeTag(
	id: number,
	name: string,
	verdict: string,
	extra?: string,
): string {
	return `[delegation: #${id} ${name} · ${verdict}]${extra ? ` ${extra}` : ""}`;
}

// Opens a subagent notice, same machinery-speech prefix rule and the
// same "#id subject · verdict" shape as a delegation notice.
export function subagentNoticeTag(id: number, kind: string, status: string): string {
	return `[subagent: #${id} ${kind} · ${status.replaceAll("_", " ")}]`;
}

// Whether a user-role text is machinery speech, not operator memory.
export function isMachineryText(text: string): boolean {
	return (
		text.startsWith("[program: ") ||
		text.startsWith("[delegation: ") ||
		text.startsWith("[subagent: ")
	);
}

// The id the compaction summary rides the model view under — a legibility
// label only, never a classification key: readers recognize the summary by
// its store-assigned boundary seq (#206), because client message ids are
// neither unique nor trusted and a client-chosen `compact-`-prefixed id is
// an ordinary client message.
export function compactionSummaryId(boundarySeq: number): string {
	return `compact-${boundarySeq}`;
}

// A recall block's id. Model-view fusion keys on positions, so the id
// only needs to be unique and legible.
export function memoryBlockId(anchorSeq: number): string {
	return `memory-${anchorSeq}`;
}

// The placeholder a corrupt history row degrades to — a note where a
// message was, never parsed back.
export function corruptRowId(seq: number): string {
	return `corrupt-${seq}`;
}
