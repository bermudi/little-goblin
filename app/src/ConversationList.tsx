import { useEffect, useRef, useState } from "react";
import type { AppConversationList } from "../../src/http/app-wire.ts";
import { patchConversation, suggestConversationTitle } from "./api.ts";
import {
	ArchiveGlyph,
	PencilGlyph,
	PinActionGlyph,
	PinGlyph,
	TrashGlyph,
	UnarchiveGlyph,
	UnpinGlyph,
} from "./glyphs.tsx";

// The Open WebUI chat-list relative-time format.
export function relTime(iso: string): string {
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "";
	const diffSec = Math.floor((Date.now() - ts) / 1000);
	if (diffSec < 60) return "now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d`;
	return new Date(ts).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

// Mirrors conversation.ts's flatLine — the client does its own pass
// because a running server may predate the store-side flattening and
// still hand over a fenced title.
export function flatLine(text: string): string {
	return text
		.replace(/```+[ \t]*[^\s`\n]*/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(\*|_)([^\s*_][^*_]*?[^\s*]|[^\s*_])\1/g, "$2")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

// An emptied title falls through to the preview — mirrors the server's
// `flatLine(r.title) || null` projection.
export function flatTitle(title: string | null): string | null {
	if (title === null) return null;
	return flatLine(title) || null;
}

// Archive and delete both skip the confirm: each raises an Undo toast
// instead (delete is held back for that window — see the App's
// deleteConversationHeld). Hover actions overlay the preview line so the
// title never trades width for them.
export function ConversationRow({
	conv,
	current,
	onOpen,
	onRenamed,
	onToggleArchived,
	onTogglePinned,
	onDelete,
	onError,
	token,
}: {
	conv: AppConversationList["conversations"][number];
	current: string | null;
	onOpen: (id: string) => void;
	onRenamed: () => void;
	onToggleArchived: (id: string, archived: boolean) => void;
	onTogglePinned: (id: string, pinned: boolean) => void;
	onDelete: (conv: AppConversationList["conversations"][number]) => void;
	onError: (message: string) => void;
	token: string | null;
}) {
	const title = flatTitle(conv.title);
	const preview = flatLine(conv.preview);
	const archived = conv.archivedAt !== null;
	const pinned = conv.pinnedAt !== null;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	const [suggesting, setSuggesting] = useState(false);
	// Enter commits and unmounts the input — its blur then fires
	// commitRename a second time (a duplicate PATCH with the same title).
	const committed = useRef(false);
	const editSession = useRef(0);
	const draftRevision = useRef(0);
	useEffect(() => {
		if (editing) {
			committed.current = false;
			editRef.current?.focus();
			editRef.current?.select();
		}
	}, [editing]);

	// A dropped rejection leaves the operator staring at a row that did
	// nothing — every mutation failure surfaces in the rail.
	const failed = (verb: string) => (err: unknown) =>
		onError(
			`Couldn't ${verb} "${title ?? (preview === "" ? "this conversation" : preview)}": ` +
				(err instanceof Error ? err.message : String(err)),
		);
	const commitRename = () => {
		if (committed.current) return;
		committed.current = true;
		editSession.current += 1;
		const t = draft.trim();
		setEditing(false);
		if (t === "" || t === title) return;
		void patchConversation(token, conv.id, { title: t }).then(onRenamed, failed("rename"));
	};
	// Suggest only: the result lands in the draft, and the usual
	// Enter/blur commit is still the one saver.
	// A suggestion belongs to the editing session and draft it started in:
	// cancel/commit/reopen bump the session, manual typing bumps the draft
	// revision, and a stale result is dropped.
	const suggestTitle = () => {
		if (suggesting) return;
		const session = editSession.current;
		const revision = draftRevision.current;
		setSuggesting(true);
		void suggestConversationTitle(token, conv.id)
			.then(
				(r) => {
					if (editSession.current !== session || draftRevision.current !== revision) return;
					setDraft(r.title);
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
	const toggleArchived = () => {
		void patchConversation(token, conv.id, { archived: !archived }).then(
			() => onToggleArchived(conv.id, !archived),
			failed(archived ? "unarchive" : "archive"),
		);
	};
	const togglePinned = () => {
		void patchConversation(token, conv.id, { pinned: !pinned }).then(
			() => onTogglePinned(conv.id, !pinned),
			failed(pinned ? "unpin" : "pin"),
		);
	};
	const startRename = () => {
		editSession.current += 1;
		setSuggesting(false);
		setDraft(title ?? "");
		setEditing(true);
	};
	const remove = () => onDelete(conv);

	if (editing) {
		return (
			<div className="conv editing">
				<div
					className="rename-field"
					onBlur={(e) => {
						// Focus moving between the input and the AI button stays
						// inside the editor; only leaving the whole field commits.
						const next = e.relatedTarget as Element | null;
						if (next !== null && e.currentTarget.contains(next)) return;
						commitRename();
					}}
					onKeyDown={(e) => {
						// Escape is a cancel, from the input or the button: mark
						// committed so the unmount's blur doesn't PATCH the draft.
						if (e.key === "Escape") {
							committed.current = true;
							editSession.current += 1;
							setEditing(false);
						}
					}}
				>
					<input
						ref={editRef}
						value={draft}
						onChange={(e) => {
							draftRevision.current += 1;
							setDraft(e.target.value);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
						}}
					/>
					{/* mousedown preventDefault keeps focus in the input, so the
					    click doesn't blur-commit and close the editor first. */}
					<button
						type="button"
						className="rename-ai"
						title="Rename with AI"
						aria-label="Rename with AI"
						aria-disabled={suggesting || undefined}
						data-busy={suggesting || undefined}
						onMouseDown={(e) => e.preventDefault()}
						onClick={suggestTitle}
					>
						✨
					</button>
				</div>
			</div>
		);
	}
	// A one-line row needs the head text out of the hover icons' way
	// (styles.css).
	const hasPreviewLine = title !== null && preview !== "";
	const rowClass = ["conv", conv.id === current ? "current" : null, hasPreviewLine ? null : "bare"]
		.filter((c): c is string => c !== null)
		.join(" ");
	return (
		<div className={rowClass}>
			<a
				className="conv-main"
				href={`/app/c/${conv.id.slice("app/".length)}`}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
					e.preventDefault();
					onOpen(conv.id);
				}}
			>
				<span className="conv-head">
					{pinned && <PinGlyph />}
					<span className="conv-title">
						{title ?? (preview === "" ? "new conversation" : preview)}
					</span>
					<span className="conv-time">{relTime(conv.updatedAt)}</span>
				</span>
				{hasPreviewLine && <span className="conv-preview">{preview}</span>}
			</a>
			<span className="conv-actions">
				{archived ? (
					<>
						<button type="button" onClick={startRename} title="Rename" aria-label="Rename">
							<PencilGlyph />
						</button>
						<button type="button" onClick={toggleArchived} title="Unarchive" aria-label="Unarchive">
							<UnarchiveGlyph />
						</button>
						<button type="button" onClick={remove} title="Delete" aria-label="Delete">
							<TrashGlyph />
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={togglePinned}
							title={pinned ? "Unpin" : "Pin"}
							aria-label={pinned ? "Unpin" : "Pin"}
						>
							{pinned ? <UnpinGlyph /> : <PinActionGlyph />}
						</button>
						<button type="button" onClick={startRename} title="Rename" aria-label="Rename">
							<PencilGlyph />
						</button>
						<button type="button" onClick={toggleArchived} title="Archive" aria-label="Archive">
							<ArchiveGlyph />
						</button>
					</>
				)}
			</span>
		</div>
	);
}
