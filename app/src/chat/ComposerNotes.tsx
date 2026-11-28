import { useEffect, useState, type ReactNode } from "react";
import {
	Command, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList,
} from "@ui-sdk/react/command";
import {
	Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle,
} from "@ui-sdk/react/drawer";
import {
	Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger,
} from "@ui-sdk/react/popover";
import type { ChatNotePinsView } from "../../../src/http/app-wire.ts";
import { listChatNotePins, listNotePinCandidates, setChatNotePin } from "../api.ts";
import { useLiveVersionIfLive } from "../useLive.tsx";

export interface StagedPin {
	id: string;
	title: string;
	owner: string;
}

export type NotesTarget =
	| { kind: "chat"; conversationId: string; rolling: boolean }
	| {
		kind: "staged";
		pins: StagedPin[];
		onPinsChange: (pins: StagedPin[]) => void;
	};

type PinnedRow = ChatNotePinsView["pins"][number];

export interface NotePins {
	pins: PinnedRow[];
	matches: StagedPin[];
	truncated: boolean;
	loaded: boolean;
	loadFailed: boolean;
	error: string | null;
	busy: boolean;
	toggle: (note: StagedPin, pinned: boolean) => void;
}

const MATCH_DELAY_MS = 180;

export function useNotePins(
	token: string | null,
	target: NotesTarget | null,
	open: boolean,
	query: string,
): NotePins {
	const [view, setView] = useState<{ pins: PinnedRow[] | null; matches: StagedPin[]; truncated: boolean; query: string | null } | null>(null);
	const [busy, setBusy] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const notesVersion = useLiveVersionIfLive("notes");
	const conversationsVersion = useLiveVersionIfLive("conversations");
	const conversationId = target?.kind === "chat" ? target.conversationId : null;
	const staged = target?.kind === "staged";
	useEffect(() => {
		const onFocus = () => setRefresh((previous) => previous + 1);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);
	useEffect(() => {
		if (busy) return;
		if (conversationId === null && (!staged || !open)) return;
		let active = true;
		const asked = open ? query : null;
		const load = async () => {
			try {
				if (conversationId !== null) {
					const next = await listChatNotePins(token, conversationId, asked);
					if (!active) return;
					setView({ pins: next.pins, matches: next.matches, truncated: next.truncated, query: asked });
				} else {
					const next = await listNotePinCandidates(token, query);
					if (!active) return;
					setView({ pins: null, matches: next.matches, truncated: next.truncated, query: asked });
				}
				setLoadFailed(false);
			} catch {
				if (active) setLoadFailed(true);
			}
		};
		const timer = setTimeout(() => void load(), open && query !== "" ? MATCH_DELAY_MS : 0);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [token, conversationId, staged, open, query, refresh, busy, notesVersion, conversationsVersion]);

	const pins: PinnedRow[] = target?.kind === "staged"
		? target.pins.map((pin) => ({ ...pin, rev: 0, changes: [] }))
		: view?.pins ?? [];
	const pinnedIds = new Set(pins.map((pin) => pin.id));
	const fresh = view !== null && view.query === (open ? query : null);
	const matches = open && fresh ? view.matches.filter((note) => !pinnedIds.has(note.id)) : [];

	const toggle = (note: StagedPin, pinned: boolean) => {
		if (target === null || busy) return;
		setError(null);
		if (target.kind === "staged") {
			target.onPinsChange(pinned
				? [...target.pins.filter((pin) => pin.id !== note.id), { id: note.id, title: note.title, owner: note.owner }]
				: target.pins.filter((pin) => pin.id !== note.id));
			return;
		}
		setBusy(true);
		void setChatNotePin(token, target.conversationId, note.id, pinned).then(
			(next) => setView((previous) => ({
				pins: next.pins,
				matches: previous?.matches ?? [],
				truncated: previous?.truncated ?? false,
				query: previous?.query ?? null,
			})),
			() => setError(pinned ? "Couldn't pin this note." : "Couldn't unpin this note."),
		).finally(() => setBusy(false));
	};

	return {
		pins,
		matches,
		truncated: open && fresh && view.truncated,
		loaded: fresh || (target?.kind === "staged" && !open),
		loadFailed,
		error,
		busy,
		toggle,
	};
}

export function notesLabel(count: number): string {
	return count === 0 ? "Notes" : `Notes, ${count} pinned`;
}

export function notesTooltip(pins: { title: string }[]): string {
	if (pins.length === 0) return "Pin a note";
	const shown = pins.slice(0, 5).map((pin) => `• ${pin.title}`);
	if (pins.length > 5) shown.push(`+${pins.length - 5} more`);
	return ["Pinned notes", ...shown].join("\n");
}

function NoteRow({
	note, pinned, detail, history, onOpenNote,
}: {
	note: StagedPin;
	pinned: boolean;
	detail: string | null;
	history?: string | undefined;
	onOpenNote: (id: string) => void;
}) {
	return (
		<CommandItem value={note.id} data-value={note.id} className="notes-row">
			<button type="button" className="notes-row-main" aria-label={`${pinned ? "Unpin" : "Pin"} ${note.title}`}>
				<span className="notes-row-text">
					<span className="notes-row-title">{note.title}</span>
					<span className="notes-row-meta" title={history}>{detail === null ? note.owner : `${note.owner} · ${detail}`}</span>
				</span>
				<span className="notes-row-act">{pinned ? "Unpin" : "Pin"}</span>
			</button>
			<button
				type="button"
				className="notes-row-open"
				aria-label={`Open ${note.title}`}
				title="Open note"
				ref={(el) => {
					if (el === null) return;
					const onClick = (event: MouseEvent) => {
						event.stopPropagation();
						onOpenNote(note.id);
					};
					el.addEventListener("click", onClick);
					return () => el.removeEventListener("click", onClick);
				}}
			>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
				</svg>
			</button>
		</CommandItem>
	);
}

function changeHistory(pin: PinnedRow): string | undefined {
	if (pin.changes.length === 0) return undefined;
	return pin.changes
		.map((edit) => `${edit.actor} · ${edit.what}${edit.reason === null ? "" : ` (${edit.reason})`}`)
		.join("\n");
}

function latestChange(pin: PinnedRow): string | null {
	const last = pin.changes[pin.changes.length - 1];
	return last === undefined ? null : `edited by ${last.actor}`;
}

export function NotesPanel({
	notes, query, onQueryChange, rolling, onOpenNote, onClose,
}: {
	notes: NotePins;
	query: string;
	onQueryChange: (query: string) => void;
	rolling: boolean;
	onOpenNote: (id: string) => void;
	onClose: () => void;
}) {
	const byId = new Map<string, { note: StagedPin; pinned: boolean }>([
		...notes.pins.map((note) => [note.id, { note, pinned: true }] as const),
		...notes.matches.map((note) => [note.id, { note, pinned: false }] as const),
	]);
	const run = (id: string | null | undefined) => {
		const row = id == null ? undefined : byId.get(id);
		if (row !== undefined) notes.toggle(row.note, !row.pinned);
	};
	const open = (id: string) => {
		onClose();
		onOpenNote(id);
	};
	return (
		<Command
			className="notes-command"
			query={query}
			onQueryChange={onQueryChange}
			filter={false}
			autoHighlight={query.trim() !== ""}
			onAction={run}
			onKeyDownCapture={(event) => {
				if ((event.target as HTMLElement | null)?.tagName !== "INPUT") return;
				if (event.key === "Enter") {
					event.preventDefault();
					event.stopPropagation();
					run((event.currentTarget as HTMLElement).querySelector("[data-highlighted]")?.getAttribute("data-value"));
				} else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<CommandInput className="notes-search" placeholder="Search notes to pin" aria-label="Search notes" autoFocus maxLength={500} />
			{notes.loadFailed && <p className="error" role="alert">Couldn't load notes for this chat.</p>}
			{notes.error !== null && <p className="error" role="alert">{notes.error}</p>}
			<CommandList className="notes-list" aria-busy={notes.busy}>
				{notes.pins.length > 0 && (
					<CommandGroup>
						<CommandGroupLabel className="notes-group">Pinned</CommandGroupLabel>
						{notes.pins.map((pin) => (
							<NoteRow key={pin.id} note={pin} pinned detail={latestChange(pin)} history={changeHistory(pin)} onOpenNote={open} />
						))}
					</CommandGroup>
				)}
				{notes.matches.length > 0 && (
					<CommandGroup>
						<CommandGroupLabel className="notes-group">{query.trim() === "" ? "Recent notes" : "Matches"}</CommandGroupLabel>
						{notes.matches.map((note) => (
							<NoteRow key={note.id} note={note} pinned={false} detail={null} onOpenNote={open} />
						))}
					</CommandGroup>
				)}
			</CommandList>
			{!notes.loaded && !notes.loadFailed && <p className="notes-help" role="status">Loading notes…</p>}
			{notes.loaded && query.trim() !== "" && notes.matches.length === 0 && (
				<p className="notes-help">No matching notes to pin.</p>
			)}
			{notes.loaded && query.trim() === "" && notes.pins.length === 0 && notes.matches.length === 0 && (
				<p className="notes-help">No notes to pin yet.</p>
			)}
			{notes.truncated && <p className="notes-help">Narrow the search to find more notes.</p>}
			{rolling && <p className="notes-help">Pins clear when Little Goblin starts a new topic.</p>}
		</Command>
	);
}

function PanelHead({ title, close }: { title: ReactNode; close: ReactNode }) {
	return <div className="notes-head">{title}{close}</div>;
}

export function NotesPopover({
	notes, open, onOpenChange, children,
}: {
	notes: NotePins;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}) {
	const count = notes.pins.length;
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				className={`icon-btn notes-trigger${count > 0 ? " has-pins" : ""}`}
				aria-label={notesLabel(count)}
				title={notesTooltip(notes.pins)}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<polyline points="14 2 14 8 20 8" />
					<line x1="9" y1="13" x2="15" y2="13" />
					<line x1="9" y1="17" x2="13" y2="17" />
				</svg>
				{count > 0 && <span className="notes-count" aria-hidden="true">{count}</span>}
			</PopoverTrigger>
			<PopoverContent className="notes-pop" side="top" align="start" sideOffset={8}>
				<PanelHead
					title={<PopoverTitle>Notes for this chat</PopoverTitle>}
					close={<PopoverClose className="ghost-inline" aria-label="Close Notes">×</PopoverClose>}
				/>
				{children}
			</PopoverContent>
		</Popover>
	);
}

export function NotesSheet({
	open, onOpenChange, children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<Drawer open={open} onOpenChange={onOpenChange} modal side="bottom">
			<DrawerBackdrop className="row-sheet-backdrop" />
			<DrawerContent className="goblin-sheet notes-sheet">
				<PanelHead
					title={<DrawerTitle>Notes for this chat</DrawerTitle>}
					close={<DrawerClose className="ghost-inline" aria-label="Close Notes">×</DrawerClose>}
				/>
				{children}
			</DrawerContent>
		</Drawer>
	);
}
