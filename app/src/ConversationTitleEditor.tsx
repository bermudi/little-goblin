"use client";

import { useEffect, useRef, useState } from "react";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { suggestConversationTitle, patchConversation } from "./api.ts";
import { conversationActionName } from "./conversationActions.ts";
import { flatTitle } from "./flatText.ts";

type Conversation = AppConversationList["conversations"][number];

export function ConversationTitleEditor({
	conv,
	token,
	onRenamed,
	onError,
	onClose,
}: {
	conv: Conversation;
	token: string | null;
	onRenamed: () => void;
	onError: (message: string) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(() => (conv.title === null ? "" : flatTitle(conv.title) ?? ""));
	const [suggesting, setSuggesting] = useState(false);
	const editRef = useRef<HTMLInputElement>(null);
	const committed = useRef(false);
	const editSession = useRef(0);
	const draftRevision = useRef(0);
	const title = conv.title === null ? null : flatTitle(conv.title);

	useEffect(() => {
		committed.current = false;
		editRef.current?.focus();
		editRef.current?.select();
	}, []);

	const failed = (verb: string) => (err: unknown) =>
		onError(
			`Couldn't ${verb} "${conversationActionName(conv)}": ` +
				(err instanceof Error ? err.message : String(err)),
		);
	const commitRename = () => {
		if (committed.current) return;
		committed.current = true;
		editSession.current += 1;
		const nextTitle = draft.trim();
		onClose();
		if (nextTitle === "" || nextTitle === title) return;
		void patchConversation(token, conv.id, { title: nextTitle }).then(onRenamed, failed("rename"));
	};
	const suggestTitle = () => {
		if (suggesting) return;
		const session = editSession.current;
		const revision = draftRevision.current;
		setSuggesting(true);
		void suggestConversationTitle(token, conv.id)
			.then(
				(result) => {
					if (editSession.current !== session || draftRevision.current !== revision) return;
					setDraft(result.title);
					editRef.current?.focus();
				},
				(err: unknown) => {
					if (editSession.current !== session) return;
					failed("suggest a title for")(err);
				},
			)
			.finally(() => {
				if (editSession.current === session) setSuggesting(false);
			});
	};

	return (
		<div
			className="rename-field"
			onBlur={(event) => {
				const next = event.relatedTarget as Element | null;
				if (next !== null && event.currentTarget.contains(next)) return;
				commitRename();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					committed.current = true;
					editSession.current += 1;
					onClose();
				}
			}}
		>
			<input
				ref={editRef}
				value={draft}
				onChange={(event) => {
					draftRevision.current += 1;
					setDraft(event.target.value);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") commitRename();
				}}
			/>
			<button
				type="button"
				className="rename-ai"
				title="Rename with AI"
				aria-label="Rename with AI"
				aria-disabled={suggesting || undefined}
				data-busy={suggesting || undefined}
				onMouseDown={(event) => event.preventDefault()}
				onClick={suggestTitle}
			>
				✨
			</button>
		</div>
	);
}
