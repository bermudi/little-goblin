// Spin-off (design/app.md → Spin-off ruling 2026-10-03): a delegation
// launched from a rolling DM gets a durable, named app conversation —
// a copy of the DM's model state, never a move. The DM stays the
// quick lane; the app conversation owns the delegation's notices and
// background turns. Called per launch by the delegate tool's pin —
// the fork happens before the launch is known to start, and the
// pin's discard undoes it when it doesn't (a failed launch must not
// leave an orphaned conversation).

import { randomUUID } from "node:crypto";
import { appLink } from "./app-link.ts";
import { paths } from "./config.ts";
import type { Conversation, ConversationStore, ModelSettings } from "./conversation.ts";
import { log } from "./log.ts";
import { projectRollText } from "./rolling.ts";

export interface SpinOffDeps {
	store: ConversationStore;
	/** The shared titleModel titler — same closure topic titling and
	 *  the app channel's first-turn naming use. null = no title. */
	titleFor(text: string): Promise<string | null>;
	/** The deep-link host — live read; unset = no link to render. */
	publicUrl(): string | undefined;
	/** New app home snapshots app defaults, never the source DM's model. */
	appDefaults?(): ModelSettings;
}

export interface SpinOffResult {
	conv: Conversation;
	/** {publicUrl}/app/c/<appId>, or null when publicUrl is unset. */
	link: string | null;
}

export function spinOff(deps: SpinOffDeps, from: Conversation, name: string): SpinOffResult {
	const appId = randomUUID();
	const conv = deps.store.forkToApp(from.id, appId, paths.workspace(), name, deps.appDefaults?.());
	log.info("spin-off", { from: from.id, to: conv.id, title: name });
	// The delegation's name titles the fork immediately; the model
	// retitle lands whenever it resolves — fire-and-forget like the
	// topic titler, and still titleImplicit so an operator rename in
	// the app always wins.
	void retitle(deps, conv.id);
	const publicUrl = deps.publicUrl();
	return { conv, link: publicUrl === undefined ? null : appLink(publicUrl, appId) };
}

// Undo a spin-off whose launch never started — but only while the
// fork still holds exactly what it copied. The fork is visible in the
// app before the async launch settles: input the operator wrote into
// it meanwhile is theirs, so a touched fork stays instead of being
// deleted out from under them. seqAtFork is the fork's lastSeq
// captured right after forkToApp — the pin owns the capture, this
// owns the compare.
export function discardSpinOff(
	store: ConversationStore,
	conversationId: string,
	seqAtFork: number | null,
	reason: string,
): void {
	// An already-deleted fork and an untouched one are the same
	// outcome: nothing of the operator's rides it anymore.
	if (store.get(conversationId) === null || store.lastSeq(conversationId) === seqAtFork) {
		store.deleteConversation(conversationId);
		log.info("spin-off discarded", { conversation: conversationId, reason });
		return;
	}
	log.info("spin-off kept — operator wrote in it", { conversation: conversationId, reason });
}

async function retitle(deps: SpinOffDeps, conversationId: string): Promise<void> {
	try {
		const lastUser = deps.store.history(conversationId).findLast((m) => m.role === "user");
		const text = lastUser === undefined ? "" : projectRollText(lastUser.parts);
		if (text === "") return;
		const title = await deps.titleFor(text);
		if (title === null || title === "") return;
		// Only an implicit title is still owed — a concurrent explicit
		// rename (or a racing retitle that already landed) stands.
		const row = deps.store.get(conversationId);
		if (row === null || !row.titleImplicit) return;
		deps.store.setMeta(conversationId, { title, titleImplicit: true });
		log.info("app conversation titled", { conversation: conversationId, title });
	} catch (err) {
		log.warn("app conversation titling failed", err, {
			conversation: conversationId,
		});
	}
}
