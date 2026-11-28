import { useEffect, useState } from "react";
import {
	Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger,
} from "@ui-sdk/react/drawer";
import {
	Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger,
} from "@ui-sdk/react/popover";
import type { ChatNotePinsView } from "../../../src/http/app-wire.ts";
import { listChatNotePins, setChatNotePin } from "../api.ts";
import { useLiveVersion } from "../useLive.tsx";

export function ChatNotePins({
	token, conversationId, phone, rolling, onOpenNote,
}: {
	token: string | null;
	conversationId: string;
	phone: boolean;
	rolling: boolean;
	onOpenNote: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [view, setView] = useState<ChatNotePinsView | null>(null);
	const [matchedQuery, setMatchedQuery] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const notesVersion = useLiveVersion("notes");
	const conversationsVersion = useLiveVersion("conversations");
	useEffect(() => {
		const onFocus = () => setRefresh((previous) => previous + 1);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);
	useEffect(() => {
		if (busy) return;
		let active = true;
		const load = () => void listChatNotePins(token, conversationId, open ? query : null).then(
			(next) => {
				if (!active) return;
				setView(next);
				setMatchedQuery(open ? query : null);
				setLoadFailed(false);
			},
			() => { if (active) setLoadFailed(true); },
		);
		const timer = setTimeout(load, open && query !== "" ? 180 : 0);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [token, conversationId, open, query, refresh, busy, notesVersion, conversationsVersion]);

	async function change(id: string, pinned: boolean) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const next = await setChatNotePin(token, conversationId, id, pinned);
			setView((previous) => previous === null ? next : { ...previous, pins: next.pins });
		} catch {
			setError(pinned ? "Couldn't pin this note." : "Couldn't unpin this note.");
		} finally {
			setBusy(false);
		}
	}

	const pins = view?.pins ?? [];
	const count = pins.length;
	const pinnedIds = new Set(pins.map((n) => n.id));
	const matches = matchedQuery === query ? view?.matches.filter((n) => !pinnedIds.has(n.id)) ?? [] : [];
	const trigger = <><span className="chat-notes-label">Notes</span>{count > 0 && (
		<span className="chat-notes-count" aria-label={`${count} pinned`}>{count}</span>
	)}</>;
	const contents = (
		<div className="chat-notes-body">
			{rolling && <p className="chat-notes-help">Pins clear when Little Goblin starts a new topic.</p>}
			{loadFailed && <p className="error" role="alert">Couldn't load notes for this chat.</p>}
			{error !== null && <p className="error" role="alert">{error}</p>}
			{view === null && !loadFailed && <p role="status">Loading notes…</p>}
			{view !== null && pins.length === 0 && <p className="chat-notes-help">No notes pinned.</p>}
			{pins.length > 0 && (
				<ul className="chat-notes-list" aria-label="Pinned notes">
					{pins.map((note) => (
						<li key={note.id}>
							<div>
								<button type="button" className="chat-notes-title link" onClick={() => onOpenNote(note.id)}>{note.title}</button>
								<span className="chat-notes-owner">{note.owner}</span>
								{note.changes.length > 0 && (
									<details>
										<summary>Updated by {note.changes[0]!.actor}</summary>
										<ul className="chat-notes-changes">
											{note.changes.map((edit) => (
												<li key={edit.rev}>
													<strong>{edit.actor}</strong> · {edit.what}
													{edit.reason !== null && <span className="chat-notes-owner">{edit.reason}</span>}
												</li>
											))}
										</ul>
									</details>
								)}
							</div>
							<button type="button" className="ghost-inline" disabled={busy}
								aria-label={`Unpin ${note.title}`} onClick={() => void change(note.id, false)}>Unpin</button>
						</li>
					))}
				</ul>
			)}
			<label className="chat-notes-search">
				Find a note to pin
				<input type="search" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} />
			</label>
			{matches.length > 0 && (
				<ul className="chat-notes-list" aria-label="Notes to pin">
					{matches.map((note) => (
						<li key={note.id}>
							<div><strong>{note.title}</strong><span className="chat-notes-owner">{note.owner}</span></div>
							<button type="button" className="ghost-inline" disabled={busy}
								aria-label={`Pin ${note.title}`} onClick={() => void change(note.id, true)}>Pin</button>
						</li>
					))}
				</ul>
			)}
			{matchedQuery === query && query.trim() !== "" && matches.length === 0 && <p className="chat-notes-help">No matching notes to pin.</p>}
			{matchedQuery === query && view?.truncated === true && <p className="chat-notes-help">Narrow the search to find more notes.</p>}
		</div>
	);
	const label = count === 0 ? "Notes" : `Notes, ${count} pinned`;
	return phone ? (
		<Drawer open={open} onOpenChange={setOpen} modal side="bottom">
			<DrawerTrigger className="header-action chat-notes-trigger" aria-label={label}>{trigger}</DrawerTrigger>
			<DrawerBackdrop className="row-sheet-backdrop" />
			<DrawerContent className="goblin-sheet chat-notes-sheet">
				<div className="chat-notes-head">
					<DrawerTitle>Notes for this chat</DrawerTitle>
					<DrawerClose className="ghost-inline" aria-label="Close Notes">×</DrawerClose>
				</div>
				{contents}
			</DrawerContent>
		</Drawer>
	) : (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger className="header-action chat-notes-trigger" aria-label={label}>{trigger}</PopoverTrigger>
			<PopoverContent className="chat-notes-popover" align="end" sideOffset={8}>
				<div className="chat-notes-head">
					<PopoverTitle>Notes for this chat</PopoverTitle>
					<PopoverClose className="ghost-inline" aria-label="Close Notes">×</PopoverClose>
				</div>
				{contents}
			</PopoverContent>
		</Popover>
	);
}
