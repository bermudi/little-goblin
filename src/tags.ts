// Typed constructors and predicates for the marker strings that ride
// conversation history. One module owns every spelling: a typo fails
// one schema instead of silently changing what reaches memory.

// Opens a program fire's machinery speech; the prefix is what
// isMachineryText matches on.
export function programFireTag(name: string, trigger: string): string {
	return `[program: ${name} · trigger: ${trigger}]`;
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

// Whether a user-role text is machinery speech, not operator memory.
export function isMachineryText(text: string): boolean {
	return text.startsWith("[program: ") || text.startsWith("[delegation: ");
}

// The id the compaction summary rides the model view under — readers
// treat it as carried context, never operator speech.
export function compactionSummaryId(boundarySeq: number): string {
	return `compact-${boundarySeq}`;
}

export function isCompactionSummaryId(messageId: string): boolean {
	return messageId.startsWith("compact-");
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
