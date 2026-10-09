// Fork before launch settles so the app gets a stable destination; an
// unstarted launch is rolled back by its pin.

import { randomUUID } from "node:crypto";
import { appLink } from "./app-link.ts";
import type { DelegationPin } from "./agent/tools/delegate.ts";
import { paths } from "./config.ts";
import {
	channelOf,
	parseAddress,
	type Conversation,
	type ConversationStore,
	type ModelSettings,
} from "./conversation.ts";
import { log } from "./log.ts";
import { isRollingChat, projectRollText } from "./rolling.ts";

export interface SpinOffDeps {
	store: ConversationStore;
	/** Shared title model; null means no title should be set. */
	titleFor(text: string): Promise<string | null>;
	/** Deep-link host, read at launch; unset means no link. */
	publicUrl(): string | undefined;
	/** App settings snapshot, not the source conversation's settings. */
	appDefaults?(): ModelSettings;
}

export interface SpinOffResult {
	conv: Conversation;
	/** App deep link, or null when no public URL is configured. */
	link: string | null;
}

export function spinOff(deps: SpinOffDeps, from: Conversation, name: string): SpinOffResult {
	const appId = randomUUID();
	const conv = deps.store.forkToApp(from.id, appId, paths.workspace(), name, deps.appDefaults?.());
	log.info("spin-off", { from: from.id, to: conv.id, title: name });
	// Keep launch synchronous; a late model title may replace only the
	// implicit title.
	void retitle(deps, conv.id);
	const publicUrl = deps.publicUrl();
	return { conv, link: publicUrl === undefined ? null : appLink(publicUrl, appId) };
}

// Undo a fork only if no operator input landed after it was copied; a
// touched app conversation must survive a failed launch.
export function discardSpinOff(
	store: ConversationStore,
	conversationId: string,
	seqAtFork: number | null,
	reason: string,
): void {
	if (store.get(conversationId) === null || store.lastSeq(conversationId) === seqAtFork) {
		store.deleteConversation(conversationId);
		log.info("spin-off discarded", { conversation: conversationId, reason });
		return;
	}
	log.info("spin-off kept — operator wrote in it", { conversation: conversationId, reason });
}

// App conversations pin to themselves; only rolling private DMs fork.
// Other addresses remain Telegram-routed.
export function launchPin(deps: SpinOffDeps, conv: Conversation, name: string): DelegationPin {
	if (channelOf(conv.id) === "app") {
		return { address: { chatId: 0, threadId: null }, appConversation: conv.id };
	}
	const source = parseAddress(conv.id);
	if (source !== null && source.kind === "rolling" && isRollingChat(conv.chatId)) {
		const spun = spinOff(deps, conv, name);
		// Capture the fork watermark for conditional rollback.
		const seqAtFork = deps.store.lastSeq(spun.conv.id);
		return {
			address: { chatId: 0, threadId: null },
			appConversation: spun.conv.id,
			movedToApp: { title: name, link: spun.link },
			discard: (reason?: string) =>
				discardSpinOff(deps.store, spun.conv.id, seqAtFork, reason ?? "unspecified"),
		};
	}
	return { address: { chatId: conv.chatId, threadId: conv.threadId } };
}

async function retitle(deps: SpinOffDeps, conversationId: string): Promise<void> {
	try {
		const lastUser = deps.store.history(conversationId).findLast((m) => m.role === "user");
		const text = lastUser === undefined ? "" : projectRollText(lastUser.parts);
		if (text === "") return;
		const title = await deps.titleFor(text);
		if (title === null || title === "") return;
		// An explicit rename made while title generation was in flight wins.
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
