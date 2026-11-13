// The composer's send path: assembling the parts from draft + staged
// chips, the busy/saving gates, and clearing only what a send actually
// sent — a declined send (failed lazy create) keeps everything
// composed so the operator can resend.

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { UIMessage } from "ai";
import { loadComposerDraft, saveComposerDraft } from "../composerDraft.ts";
import type { StagedNote, StagedSkill, StagedUpload } from "./Composer.tsx";

export function useSubmit({
	busy,
	onStop,
	configSaving,
	draftScope,
	draft,
	setDraft,
	staged,
	setStaged,
	stagedNotes,
	setStagedNotes,
	stagedSkills,
	setStagedSkills,
	onSend,
}: {
	busy: boolean;
	onStop?: (() => void) | undefined;
	configSaving: boolean;
	// Durable-draft key — one per composer home: the conversation id,
	// the project id, "new" for the empty start state.
	draftScope: string;
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	staged: StagedUpload[];
	setStaged: Dispatch<SetStateAction<StagedUpload[]>>;
	stagedNotes: StagedNote[];
	setStagedNotes: Dispatch<SetStateAction<StagedNote[]>>;
	stagedSkills: StagedSkill[];
	setStagedSkills: Dispatch<SetStateAction<StagedSkill[]>>;
	onSend: (parts: UIMessage["parts"]) => void | boolean | Promise<boolean>;
}) {
	const sendingRef = useRef(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const editedAfterSend = useRef(false);

	// An entry leaves the staged list (sent or removed) — its preview
	// URL goes with it. A composer unmount revokes nothing: staged
	// entries outlive any one composer, and an undropped thumb dies
	// with the document itself.
	const dropEntry = (e: StagedUpload) => {
		if (e.thumb !== undefined) URL.revokeObjectURL(e.thumb);
	};

	const send = () => {
		// A send while a turn runs steers it (onSend drops the stale
		// reader first) — but without a stop path there is no steer
		// lane, so a lazy create still refuses mid-flight: a second
		// send must not fork a second conversation.
		if ((busy && onStop === undefined) || configSaving || sendingRef.current) return;
		const text = draft.trim();
		const ready = staged.filter((e) => e.uploading !== true && e.failed !== true);
		if (text === "" && ready.length === 0 && stagedNotes.length === 0 && stagedSkills.length === 0)
			return;
		const parts: UIMessage["parts"] = [];
		if (text !== "") parts.push({ type: "text", text });
		for (const e of ready)
			parts.push({
				type: "data-attachment",
				data: e.speech === true ? { ...e.ref, speech: true } : e.ref,
			} as UIMessage["parts"][number]);
		// Intake expands the id into the authoritative snapshot; the
		// title rides along only so the just-sent chip isn't bare.
		for (const n of stagedNotes)
			parts.push({
				type: "data-note",
				data: { id: n.id, title: n.title },
			} as UIMessage["parts"][number]);
		// Explicit invocations ride their own part; the server injects
		// the body into the owning turn.
		for (const s of stagedSkills)
			parts.push({ type: "data-skill", data: s.ref } as UIMessage["parts"][number]);
		// Clear only once the send is accepted — a compose wiped before
		// a lazy-create failure leaves nothing to resend (blob URLs are
		// unrecoverable). Typing that lands mid-flight survives: only
		// the sent prefix comes off.
		sendingRef.current = true;
		setSendError(null);
		void Promise.resolve()
			.then(() => onSend(parts) ?? true)
			.then((accepted) => {
				if (accepted === false) return;
				// The accept continuation can outlive this composer — a lazy
				// create swaps the view before it runs, and an unmounted
				// composer's persist effect never fires. Write the post-send
				// remainder to storage directly, against the stored text.
				try {
					const stored = loadComposerDraft(draftScope) ?? "";
					saveComposerDraft(
						draftScope,
						stored === draft ? "" : stored.startsWith(draft) ? stored.slice(draft.length) : stored,
					);
				} catch {
					// Unreadable records stay put, and a mounted composer's
					// effect still reports its own save failures.
				}
				setDraft((d) => (d === draft ? "" : d.startsWith(draft) ? d.slice(draft.length) : d));
				// Entries that weren't sent — uploads still in flight, failed
				// chips — stay staged. Clearing them would drop files the
				// operator still sees in the composer.
				for (const e of ready) dropEntry(e);
				setStaged((p) => p.filter((e) => !ready.includes(e)));
				setStagedNotes((p) => p.filter((n) => !stagedNotes.includes(n)));
				setStagedSkills((p) => p.filter((s) => !stagedSkills.includes(s)));
			})
			.catch((err: unknown) => {
				setSendError(`Could not send: ${err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				sendingRef.current = false;
			});
	};

	return { send, sendError, editedAfterSend, dropEntry };
}
