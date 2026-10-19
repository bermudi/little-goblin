// Durable local draft for the note editor: same-origin localStorage,
// one record per note, markdown only.

import { z } from "zod";

const DRAFT_SCHEMA = z
	.object({
		version: z.literal(1),
		noteId: z.string().min(1),
		baseRev: z.number().int().positive(),
		baseBody: z.string(),
		body: z.string(),
	})
	.strict();

export type NoteDraft = z.infer<typeof DRAFT_SCHEMA>;

const key = (noteId: string): string => `goblin.note-draft.v1:${encodeURIComponent(noteId)}`;

// Missing is null; anything stored but unreadable fails loud and is
// left in place. Corrupt-record errors are FIXED strings — parser and
// validator messages can quote the stored payload, which is note
// content and never belongs in a diagnostic. The verbatim raw is
// returned as `snapshot` so a retire deletes exactly these bytes.
export function loadNoteDraft(noteId: string): { draft: NoteDraft; snapshot: string } | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(key(noteId));
	} catch (e) {
		throw new Error(`localStorage read failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`stored note draft for ${noteId} is not valid JSON`);
	}
	const res = DRAFT_SCHEMA.safeParse(parsed);
	if (!res.success) throw new Error(`stored note draft for ${noteId} fails the record shape`);
	if (res.data.noteId !== noteId)
		throw new Error(`stored note draft for ${noteId} belongs to a different note`);
	return { draft: res.data, snapshot: raw };
}

export function writeNoteDraft(draft: NoteDraft): string;
// With expectedSnapshot the write lands only while storage still
// holds that exact record — a detached component must not overwrite
// a newer editor's draft. Returns null (and writes nothing) on
// mismatch.
export function writeNoteDraft(draft: NoteDraft, expectedSnapshot: string): string | null;
export function writeNoteDraft(draft: NoteDraft, expectedSnapshot?: string): string | null {
	const k = key(draft.noteId);
	if (expectedSnapshot !== undefined) {
		let raw: string | null;
		try {
			raw = localStorage.getItem(k);
		} catch (e) {
			throw new Error(`localStorage read failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (raw !== expectedSnapshot) return null;
	}
	const serialized = JSON.stringify(DRAFT_SCHEMA.parse(draft));
	try {
		localStorage.setItem(k, serialized);
	} catch (e) {
		throw new Error(`localStorage write failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	return serialized;
}

// The two explicit paths over a record this module can't read: the
// verbatim bytes for the operator to salvage, and an unconditional
// delete for the discard control. Neither parses or compares — the
// point of preserving an unreadable record is that no code path
// understands it.
export function rawNoteDraft(noteId: string): string | null {
	try {
		return localStorage.getItem(key(noteId));
	} catch (e) {
		throw new Error(`localStorage read failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function discardNoteDraft(noteId: string): void {
	try {
		localStorage.removeItem(key(noteId));
	} catch (e) {
		throw new Error(`localStorage delete failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// Remove the draft only while the stored record still IS the given
// snapshot — a late ack must not delete a newer draft, and one tab
// must not delete another's.
export function clearNoteDraft(noteId: string, snapshot: string): void {
	let raw: string | null;
	try {
		raw = localStorage.getItem(key(noteId));
	} catch (e) {
		throw new Error(`localStorage read failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (raw !== snapshot) return;
	try {
		localStorage.removeItem(key(noteId));
	} catch (e) {
		throw new Error(`localStorage delete failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
