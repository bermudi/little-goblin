// Message tags — the typed constructors and predicates for the marker
// strings that ride conversation history: the headers that open a
// user-role message of machinery speech (program fires, delegation
// notices) and the synthetic message ids the store's own projections
// mint (compaction summaries, memory recall blocks, corrupt-row
// placeholders). One module owns every spelling, so a typo fails one
// schema instead of silently changing what reaches memory
// (REFACTOR-PLAN.md → W2.1).

// The header a program fire opens with (scheduler → wake → history).
// Retention reads it back through isMachineryText.
export function programFireTag(name: string, trigger: string): string {
	return `[program: ${name} · trigger: ${trigger}]`;
}

// The header a delegation notice opens with (delegation-lifecycle →
// wake → history). extra rides after the verdict, space-separated.
export function delegationNoticeTag(
	id: number,
	name: string,
	verdict: string,
	extra?: string,
): string {
	return `[delegation: #${id} ${name} · ${verdict}]${extra ? ` ${extra}` : ""}`;
}

// Whether a user-role text is machinery speech, not operator memory:
// program fires and delegation notices.
export function isMachineryText(text: string): boolean {
	return text.startsWith("[program: ") || text.startsWith("[delegation: ");
}

// The compaction summary rides the model view as a user-role message
// with this id (conversation.ts → summaryMessage): readers use it to
// treat the summary as carried context, never operator speech.
export function compactionSummaryId(boundarySeq: number): string {
	return `compact-${boundarySeq}`;
}

export function isCompactionSummaryId(messageId: string): boolean {
	return messageId.startsWith("compact-");
}

// A memory recall block's id (memory.ts → withMemoryBlocks). The
// model-view fusion of a block with its anchored user message keys on
// positions, so the id only needs to be unique and legible.
export function memoryBlockId(anchorSeq: number): string {
	return `memory-${anchorSeq}`;
}

// The placeholder id a corrupt history row degrades to
// (conversation.ts → corruptPlaceholder) — a note where a message was,
// never parsed back.
export function corruptRowId(seq: number): string {
	return `corrupt-${seq}`;
}
