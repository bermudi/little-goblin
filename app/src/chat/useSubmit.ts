// The composer's send path: assembling the parts from the message box's
// draft, the busy/saving gates, and clearing only what a send actually
// sent — a declined send (failed lazy create) keeps everything composed
// so the operator can resend.

import { useRef, useState, type RefObject } from "react";
import type { UIMessage } from "ai";
import { loadComposerDraft, saveComposerDraft } from "../composerDraft.ts";
import { draftToParts, emptyDraft, unsentRemainder, uploadState, type Draft } from "./draft.ts";
import type { MessageBoxHandle } from "./MessageBox.tsx";

export function useSubmit({
	busy,
	onStop,
	configSaving,
	draftScope,
	boxRef,
	onSend,
}: {
	busy: boolean;
	onStop?: (() => void) | undefined;
	configSaving: boolean;
	// Durable-draft key — one per composer home: the conversation id,
	// the project id, "new" for the empty start state.
	draftScope: string;
	// The mounted message box — the draft reads and the post-send
	// remainder land there.
	boxRef: RefObject<MessageBoxHandle | null>;
	onSend: (
		parts: UIMessage["parts"],
		whenBusy?: "steer" | "followUp",
	) => void | boolean | Promise<boolean>;
}) {
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	// Enter against a blocked send: the affordance the disabled buttons
	// can't give. role="status" — it informs, it never interrupts.
	const [sendNote, setSendNote] = useState<string | null>(null);
	const editedAfterSend = useRef(false);

	const send = (whenBusy: "steer" | "followUp" = "steer") => {
		// A send while a turn runs steers it (onSend drops the stale
		// reader first) — but without a stop path there is no steer
		// lane, so a lazy create still refuses mid-flight: a second
		// send must not fork a second conversation.
		if ((busy && onStop === undefined) || configSaving || sendingRef.current) return;
		const box = boxRef.current;
		if (box === null) return;
		const draft = box.getDraft();
		const uploads = uploadState(draft);
		if (uploads === "uploading") {
			setSendNote("Upload still running. Send when it finishes.");
			return;
		}
		if (uploads === "failed") {
			setSendNote("Retry or remove the failed upload.");
			return;
		}
		const parts = draftToParts(draft);
		if (parts.length === 0) return;
		// Clear only once the send is accepted — a compose wiped before
		// a lazy-create failure leaves nothing to resend. Typing that
		// lands mid-flight survives: only the sent prefix comes off.
		sendingRef.current = true;
		setSendError(null);
		setSendNote(null);
		void Promise.resolve()
			.then(() => onSend(parts, whenBusy) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				const remainder = unsentRemainder(boxRef.current?.getDraft() ?? draft, draft);
				// The accept continuation can outlive this composer — a lazy
				// create swaps the view before it runs, and an unmounted
				// composer's persist effect never fires. Write the post-send
				// remainder to storage directly, against the stored draft.
				try {
					const stored = loadComposerDraft(draftScope) ?? emptyDraft();
					saveComposerDraft(draftScope, unsentRemainder(stored, draft));
				} catch {
					// Unreadable records stay put, and a mounted composer's
					// effect still reports its own save failures.
				}
				boxRef.current?.setDraft(remainder);
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	return { send, sendError, sendNote, editedAfterSend };
}
