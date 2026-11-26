import { useCallback, useRef, useState, type RefObject } from "react";
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
	setBoxDraft,
	onSend,
	onSent,
}: {
	busy: boolean;
	onStop?: (() => void) | undefined;
	configSaving: boolean;
	draftScope: string;
	boxRef: RefObject<MessageBoxHandle | null>;
	setBoxDraft: (draft: Draft) => void;
	onSend: (
		parts: UIMessage["parts"],
		whenBusy?: "steer" | "followUp",
	) => void | boolean | Promise<boolean>;
	onSent?: (() => void) | undefined;
}) {
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const [sendNote, setSendNote] = useState<"uploading" | null>(null);
	const clearSendNote = useCallback(() => setSendNote(null), []);
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
			setSendNote("uploading");
			return;
		}
		const parts = draftToParts(draft);
		if (parts.length === 0) return;
		editedAfterSend.current = false;
		sendingRef.current = true;
		setSendError(null);
		setSendNote(null);
		void Promise.resolve()
			.then(() => onSend(parts, whenBusy) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				const remainder = unsentRemainder(boxRef.current?.getDraft() ?? draft, draft);
				try {
					const stored = loadComposerDraft(draftScope) ?? emptyDraft();
					saveComposerDraft(draftScope, unsentRemainder(stored, draft));
				} catch (e) {
					setSendError(
						`Sent, but the saved draft could not be updated: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				setBoxDraft(remainder);
				onSent?.();
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	return { send, sendError, sendNote, clearSendNote, editedAfterSend };
}
