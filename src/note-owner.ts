export const LITTLE_GOBLIN_NOTE_OWNER = "little-goblin";

export type NoteOwner = { projectId: string } | { botId: string | null };

export type NoteBatchAction =
	| { action: "move"; owner: NoteOwner }
	| { action: "archive" | "restore" | "delete" };

export type NoteSelection = { id: string; stateRev: number };

export type NoteAccess = "write" | "read" | "none";

export function noteAccess(
	note: { projectId: string | null; botId: string | null },
	chatBot: string,
): NoteAccess {
	const owner = note.projectId === null ? note.botId : LITTLE_GOBLIN_NOTE_OWNER;
	if (owner === null || owner === chatBot) return "write";
	return chatBot === LITTLE_GOBLIN_NOTE_OWNER ? "read" : "none";
}
