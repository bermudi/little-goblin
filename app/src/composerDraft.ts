import { z } from "zod";
import { draftSchema, isEmptyDraft, sameDraft, textDraft, type Draft } from "./chat/draft.ts";

const DRAFT_SCHEMA = z
	.object({
		version: z.literal(2),
		scope: z.string().min(1),
		draft: draftSchema,
	})
	.strict();

const LEGACY_SCHEMA = z
	.object({
		version: z.literal(1),
		scope: z.string().min(1),
		text: z.string(),
	})
	.strict();

const PREFIX = "goblin.composer-draft.v1:";
const key = (scope: string): string => `${PREFIX}${encodeURIComponent(scope)}`;

// Missing is null; anything stored but unreadable fails loud and is
// left in place. Corrupt-record errors are FIXED strings — parser and
// validator messages can quote the stored payload, which is draft
// prose and never belongs in a diagnostic.
export function loadComposerDraft(scope: string): Draft | null {
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
	if (res.success) {
		if (res.data.scope !== scope)
			throw new Error("stored composer draft belongs to a different composer");
		return res.data.draft;
	}
	const legacy = LEGACY_SCHEMA.safeParse(parsed);
	if (legacy.success) {
		if (legacy.data.scope !== scope)
			throw new Error("stored composer draft belongs to a different composer");
		return textDraft(legacy.data.text);
	}
	throw new Error("stored composer draft fails the record shape");
}

export function saveComposerDraft(scope: string, draft: Draft): void {
	const k = key(scope);
	if (isEmptyDraft(draft)) {
		try {
			localStorage.removeItem(k);
		} catch (e) {
			throw new Error(`localStorage delete failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		return;
	}
	const serialized = JSON.stringify(DRAFT_SCHEMA.parse({ version: 2, scope, draft }));
	try {
		localStorage.setItem(k, serialized);
	} catch (e) {
		throw new Error(`localStorage write failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export function rewriteComposerDrafts(map: (draft: Draft) => Draft): void {
	let keys: string[];
	try {
		keys = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k === null) continue;
			keys.push(k);
		}
	} catch {
		return;
	}
	for (const k of keys) {
		if (!k.startsWith(PREFIX)) continue;
		const scope = decodeURIComponent(k.slice(PREFIX.length));
		let draft: Draft | null;
		try {
			draft = loadComposerDraft(scope);
		} catch {
			continue;
		}
		if (draft === null) continue;
		const next = map(draft);
		if (sameDraft(next, draft)) continue;
		try {
			saveComposerDraft(scope, next);
		} catch {
			continue;
		}
	}
}
