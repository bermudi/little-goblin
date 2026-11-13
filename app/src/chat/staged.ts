// The staged-chip shapes the composer sends: attachments, notes and
// skills lifted above any one composer instance (App owns the lists),
// so an upload resolving after the empty-state composer unmounts
// writes into the lifted list, not the discarded component.

import type { AttachmentRef } from "../../../src/agent/attachments.ts";

// One staged attachment. Entries carry a client key — pasted images
// all arrive named "image.png", so filename can't pick which staging
// row an upload resolves. `speech` marks a voice note staged while a
// turn was running — send() re-applies the flag so intake still
// transcribes.
export interface StagedUpload {
	key: string;
	ref: AttachmentRef;
	uploading?: boolean;
	failed?: boolean;
	speech?: boolean;
	// Object URL for a local image preview — created at stage time,
	// revoked when the entry leaves the staged list.
	thumb?: string;
}

// A note picked for the next send — id only; the server expands it at
// intake. Lifted beside `staged` for the same reason: chips must
// outlive the empty-state composer.
export interface StagedNote {
	key: string;
	id: string;
	title: string;
}

// An explicit skill invocation (ruling 2026-10-21) — staged from the
// picker, sent as a data-skill part. Catalog refs resolve at
// admission; temp refs pin a fetched, verdict-stamped copy.
export interface StagedSkill {
	key: string;
	name: string;
	ref: { name: string } | { url: string; path: string };
}
