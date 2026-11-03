// What authorized a queued development, and whether it still holds when
// the wake that carries it is appended (design/programs.md → Queued
// authority; dsh-superagent re-checks the original permission before a
// held action resumes). An autonomous recorder — scheduler, observer,
// mail watcher — stamps the responsibility state it acted on; dispatch
// re-checks the stamp. A failed check never revokes the development:
// it is still a fact and still delivered, but marked superseded so the
// wake turn reads it as history, not as a grant to act.
//
// Operator-origin developments (handover, correction) carry no stamp:
// they are the authority.

import { z } from "zod";
import type { Attachment, Responsibility, ResponsibilityStore } from "./responsibilities.ts";

export const authorityStampSchema = z.strictObject({
	status: z.string(),
	revision: z.number(),
	attachmentId: z.number().optional(),
	attachmentGeneration: z.number().optional(),
});
export type AuthorityStamp = z.infer<typeof authorityStampSchema>;

export function authorityStamp(
	resp: Pick<Responsibility, "status" | "revision">,
	att?: Pick<Attachment, "attachmentId" | "generation">,
): AuthorityStamp {
	return {
		status: resp.status,
		revision: resp.revision,
		...(att === undefined
			? {}
			: { attachmentId: att.attachmentId, attachmentGeneration: att.generation }),
	};
}

/** null = the stamp still holds; otherwise why it no longer does. */
export function stillAuthorized(
	resp: Pick<Responsibility, "status" | "revision"> | null,
	att: Pick<Attachment, "generation" | "health"> | null,
	stamp: AuthorityStamp,
): string | null {
	if (resp === null) return "responsibility no longer exists";
	if (resp.status !== stamp.status)
		return `responsibility ${stamp.status} → ${resp.status} since recorded`;
	if (resp.revision !== stamp.revision)
		return `operator corrected the responsibility (rev ${stamp.revision} → ${resp.revision}) since recorded`;
	if (stamp.attachmentId !== undefined) {
		if (att === null || att.health === "detached")
			return `attachment ${stamp.attachmentId} detached since recorded`;
		if (att.generation !== stamp.attachmentGeneration)
			return `attachment ${stamp.attachmentId} re-bound (generation ${stamp.attachmentGeneration} → ${att.generation}) since recorded`;
	}
	return null;
}

/** The wake store's commit-time re-check, bound to the live store. An
 *  unstamped or unlinked event is not checked; a malformed stamp is
 *  corruption and throws — the commit rolls back, nothing is appended. */
export function makeAuthorityRecheck(
	resps: Pick<ResponsibilityStore, "get" | "getAttachment">,
): (ev: { eventId: number; responsibilityId: string | null; authority: unknown }) => string | null {
	return (ev) => {
		if (ev.responsibilityId === null || ev.authority === null || ev.authority === undefined)
			return null;
		const parsed = authorityStampSchema.safeParse(ev.authority);
		if (!parsed.success) throw new Error(`work event ${ev.eventId}: malformed authority stamp`);
		const stamp = parsed.data;
		const att = stamp.attachmentId === undefined ? null : resps.getAttachment(stamp.attachmentId);
		return stillAuthorized(resps.get(ev.responsibilityId), att, stamp);
	};
}
