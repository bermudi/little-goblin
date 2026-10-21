// Durable local draft for the chat composer: same-origin localStorage,
// one record per composer scope (a conversation, a project page, the
// empty start state), text only — staged chips are uploads, not prose.
// The mounted composer is the single writer: no snapshot compare (the
// note editor's CAS exists for detached-editor races this one-shot
// composer doesn't have), so a second window typing later simply wins
// the key back.

import { z } from "zod";

const DRAFT_SCHEMA = z
	.object({
		version: z.literal(1),
		scope: z.string().min(1),
		text: z.string(),
	})
	.strict();

const key = (scope: string): string => `goblin.composer-draft.v1:${encodeURIComponent(scope)}`;

// Missing is null; anything stored but unreadable fails loud and is
// left in place. Corrupt-record errors are FIXED strings — parser and
// validator messages can quote the stored payload, which is draft
// prose and never belongs in a diagnostic.
export function loadComposerDraft(scope: string): string | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(key(scope));
	} catch (e) {
		throw new Error(`localStorage read failed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("stored composer draft is not valid JSON");
	}
	const res = DRAFT_SCHEMA.safeParse(parsed);
	if (!res.success) throw new Error("stored composer draft fails the record shape");
	if (res.data.scope !== scope)
		throw new Error("stored composer draft belongs to a different composer");
	return res.data.text;
}

// Empty text removes the record — a sent draft leaves no residue.
export function saveComposerDraft(scope: string, text: string): void {
	const k = key(scope);
	if (text === "") {
		try {
			localStorage.removeItem(k);
		} catch (e) {
			throw new Error(`localStorage delete failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		return;
	}
	const serialized = JSON.stringify(DRAFT_SCHEMA.parse({ version: 1, scope, text }));
	try {
		localStorage.setItem(k, serialized);
	} catch (e) {
		throw new Error(`localStorage write failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
