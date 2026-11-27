export const LITTLE_GOBLIN_NOTE_OWNER = "little-goblin";

export type NoteOwner = { projectId: string } | { botId: string | null };

export type NoteBatchAction =
	| { action: "move"; owner: NoteOwner }
	| { action: "archive" | "restore" | "delete" };

export type NoteSelection = { id: string; stateRev: number };
