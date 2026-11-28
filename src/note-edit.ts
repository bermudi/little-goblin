export const NOTE_EDIT_MESSAGE_MAX = 500;

export interface NoteEditMessage {
	what?: string | undefined;
	reason?: string | undefined;
}

export interface NoteEditMeta {
	rev: number;
	at: string;
	author: { botId: string; name: string } | "operator";
	what: string | null;
	reason: string | null;
}

export interface NoteTextChange {
	before: string;
	after: string;
}

export interface NoteEdit extends NoteEditMeta {
	title: NoteTextChange | null;
	body: (NoteTextChange & { offset: number }) | null;
}

export interface NoteEditPage {
	edits: NoteEditMeta[];
	before: number | null;
}

export function noteBodyChange(before: string, after: string): NoteEdit["body"] {
	if (before === after) return null;
	let offset = 0;
	const max = Math.min(before.length, after.length);
	while (offset < max && before[offset] === after[offset]) offset++;
	const prior = before.charCodeAt(offset - 1);
	if (prior >= 0xd800 && prior <= 0xdbff) offset--;
	let suffix = 0;
	while (suffix < max - offset && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
	const following = before.charCodeAt(before.length - suffix);
	if (following >= 0xdc00 && following <= 0xdfff) suffix--;
	return {
		offset,
		before: before.slice(offset, before.length - suffix),
		after: after.slice(offset, after.length - suffix),
	};
}
