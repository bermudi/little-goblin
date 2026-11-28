import { useEffect, useRef, useState } from "react";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import {
	AlertDialog,
	AlertDialogBackdrop,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui-sdk/react/alert-dialog";
import {
	Dialog,
	DialogBackdrop,
	DialogClose,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@ui-sdk/react/dialog";
import type { AppBot, AppNoteList, AppNoteSummary, AppProject } from "../../src/http/app-wire.ts";
import { LITTLE_GOBLIN_NOTE_OWNER, type NoteBatchAction } from "../../src/note-owner.ts";
import { batchNotes, createNote, listNotes } from "./api.ts";
import { relTime } from "./memoryShared.tsx";
import { useLiveVersion } from "./useLive.tsx";

function OwnerOptions({ projects, bots }: { projects: AppProject[]; bots: AppBot[] }) {
	return (
		<>
			<option value="global">Global</option>
			<option value={LITTLE_GOBLIN_NOTE_OWNER}>Little Goblin</option>
			{bots.length > 0 && (
				<optgroup label="Bots">
					{bots.map((bot) => (
						<option key={bot.id} value={bot.id}>
							{bot.name}
						</option>
					))}
				</optgroup>
			)}
			{projects.length > 0 && (
				<optgroup label="Projects">
					{projects.map((project) => (
						<option key={project.id} value={project.id}>
							{project.name}
						</option>
					))}
				</optgroup>
			)}
		</>
	);
}

const actions = { move: "Moved", archive: "Archived", restore: "Restored", delete: "Deleted" };

export function NotesIndex({
	token,
	projects,
	bots = [],
	onOpen,
	onChanged,
	onSettings,
}: {
	token: string | null;
	projects: AppProject[];
	bots?: AppBot[];
	onOpen: (id: string) => void;
	onChanged?: () => void;
	onSettings?: () => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [archived, setArchived] = useState(false);
	const [list, setList] = useState<AppNoteList | null>(null);
	const [selected, setSelected] = useState(() => new Map<string, number>());
	const [destination, setDestination] = useState("");
	const [moveOpen, setMoveOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	const [reload, refresh] = useState(0);
	const mounted = useRef(true);
	const operation = useRef(false);
	const notesVersion = useLiveVersion("notes");
	const rows = list?.notes ?? [];
	const selection = Array.from(selected, ([id, stateRev]) => ({ id, stateRev }));
	const selectedShown = rows.filter(({ id }) => selected.has(id)).length;
	const count = selection.length;
	const botOwner = (id: string) => bots.find((bot) => bot.id === id);
	const ownerName = (note: AppNoteSummary) =>
		note.projectId === null
			? note.botId === null
				? "Global"
				: note.botId === undefined || note.botId === LITTLE_GOBLIN_NOTE_OWNER
					? "Little Goblin"
					: (botOwner(note.botId)?.name ?? "Bot")
			: (projects.find((project) => project.id === note.projectId)?.name ?? "Project");
	const destinationBot = botOwner(destination);
	const filterIsOwner = filter === "global" || filter === LITTLE_GOBLIN_NOTE_OWNER || botOwner(filter) !== undefined;

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(() => {
			const scope = filterIsOwner ? { owner: filter } : { project: filter };
			void listNotes(token, { ...scope, q: query, archived }).then(
				(next) => {
					if (cancelled) return;
					setList(next);
					setListError(null);
				},
				(err: unknown) => {
					if (cancelled) return;
					setListError(
						`Couldn't list notes. ${err instanceof Error ? err.message : String(err)}`,
					);
				},
			);
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, filter, filterIsOwner, archived, token, notesVersion, reload]);

	function resetFilters() {
		setList(null);
		setSelected(new Map());
		setError(null);
		setListError(null);
		setStatus("");
	}

	async function mutate(change: NoteBatchAction) {
		if (operation.current || selection.length === 0) return;
		operation.current = true;
		setBusy(true);
		setError(null);
		setStatus("");
		try {
			await batchNotes(token, { selection, change });
			onChanged?.();
			if (!mounted.current) return;
			setList(null);
			setStatus(`${actions[change.action]} ${count} ${count === 1 ? "note" : "notes"}.`);
		} catch (err) {
			if (!mounted.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			operation.current = false;
			if (mounted.current) {
				setSelected(new Map());
				refresh((value) => value + 1);
				setBusy(false);
			}
		}
	}

	async function newNote() {
		if (operation.current) return;
		operation.current = true;
		setBusy(true);
		setError(null);
		try {
			const project = projects.find(
				(entry) => entry.id === filter && entry.archivedAt === null,
			);
			const note = await createNote(token, {
				title: "Untitled note",
				...(project === undefined ? {} : { projectId: project.id }),
			});
			onChanged?.();
			if (mounted.current) onOpen(note.id);
		} catch (err) {
			if (mounted.current) {
				setError(
					`Couldn't create the note. ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} finally {
			operation.current = false;
			if (mounted.current) setBusy(false);
		}
	}

	return (
		<div className="ops notes-manager">
			{onSettings !== undefined && (
				<div className="ops-back">
					<button type="button" className="ghost" onClick={onSettings}>
						‹ Settings
					</button>
				</div>
			)}
			<div className="proj-sec-head">
				<h2 className="ops-h2">Notes</h2>
				<button type="button" className="addbtn proj-btn" disabled={busy} onClick={newNote}>
					New note
				</button>
			</div>
			<div className="note-filters">
				<input
					type="search"
					placeholder="Search notes"
					aria-label="Search notes"
					value={query}
					disabled={busy}
					onChange={(event) => {
						resetFilters();
						setQuery(event.target.value);
					}}
				/>
				<select
					aria-label="Filter notes by owner"
					value={filter}
					disabled={busy}
					onChange={(event) => {
						resetFilters();
						setFilter(event.target.value);
					}}
				>
					<option value="all">All owners</option>
					<OwnerOptions projects={projects} bots={bots} />
				</select>
				<select
					aria-label="Filter notes by status"
					value={archived ? "archived" : "active"}
					disabled={busy}
					onChange={(event) => {
						resetFilters();
						setArchived(event.target.value === "archived");
					}}
				>
					<option value="active">Active</option>
					<option value="archived">Archived</option>
				</select>
			</div>
			{count > 0 && (
				<div className="note-batch">
					<strong aria-live="polite">{count} selected</strong>
					<Dialog
						open={moveOpen}
						onOpenChange={(open) => {
							setMoveOpen(open);
							setDestination("");
						}}
					>
						<DialogTrigger className="ghost proj-btn" disabled={busy}>
							Move to…
						</DialogTrigger>
						<DialogBackdrop className="veil" />
						<DialogContent className="note-batch-dialog">
							<DialogTitle>
								Move {count} {count === 1 ? "note" : "notes"}
							</DialogTitle>
							<label className="note-filters">
								<span>Owner</span>
								<select
									value={destination}
									onChange={(event) => setDestination(event.target.value)}
								>
									<option value="">Choose an owner</option>
									<OwnerOptions
										projects={projects.filter(
											(project) => project.archivedAt === null,
										)}
										bots={bots}
									/>
								</select>
							</label>
							{destination === "global" && (
								<p>Every bot can read and edit Global notes.</p>
							)}
							{destinationBot !== undefined && (
								<p>
									Only {destinationBot.name} can edit {count === 1 ? "it" : "them"}. Little
									Goblin can still read {count === 1 ? "it" : "them"}. {destinationBot.name}{" "}
									can't be moved back to Little Goblin while it owns notes.
								</p>
							)}
							<div className="confirm-actions">
								<DialogClose className="ghost proj-btn">Cancel</DialogClose>
								<DialogClose
									className="addbtn proj-btn"
									disabled={destination === ""}
									onClick={() => {
										const owner =
											destination === "global"
												? { botId: null }
												: destination === LITTLE_GOBLIN_NOTE_OWNER || destinationBot !== undefined
													? { botId: destination }
													: { projectId: destination };
										void mutate({ action: "move", owner });
									}}
								>
									Move
								</DialogClose>
							</div>
						</DialogContent>
					</Dialog>
					<button
						type="button"
						className="ghost proj-btn"
						disabled={busy}
						onClick={() => void mutate({ action: archived ? "restore" : "archive" })}
					>
						{archived ? "Restore" : "Archive"}
					</button>
					{archived && (
						<AlertDialog>
							<AlertDialogTrigger className="ghost proj-btn" disabled={busy}>
								Delete…
							</AlertDialogTrigger>
							<AlertDialogBackdrop className="veil" />
							<AlertDialogContent className="note-batch-dialog">
								<AlertDialogTitle>
									Permanently delete {count} {count === 1 ? "note" : "notes"}?
								</AlertDialogTitle>
								<AlertDialogDescription>
									This deletes the notes and all their versions. Copies already
									sent in chats stay in chat history.
								</AlertDialogDescription>
								<div className="confirm-actions">
									<AlertDialogClose className="ghost proj-btn">
										Cancel
									</AlertDialogClose>
									<AlertDialogClose
										className="danger proj-btn"
										value="confirm"
										onClick={() => void mutate({ action: "delete" })}
									>
										Delete permanently
									</AlertDialogClose>
								</div>
							</AlertDialogContent>
						</AlertDialog>
					)}
				</div>
			)}
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{listError !== null && (
				<p className="error" role="alert">
					{listError}
				</p>
			)}
			{status !== "" && (
				<p className="empty" role="status">
					{status}
				</p>
			)}
			{list === null && error === null && listError === null && <p className="loading">Loading notes…</p>}
			{list !== null && rows.length === 0 && (
				<p className="empty">
					{query === ""
						? archived
							? "No archived notes."
							: "No notes here yet."
						: "No matching notes."}
				</p>
			)}
			{rows.length > 0 && (
				<div className="dtable notes-table">
					<table>
						<thead>
							<tr>
								<th scope="col">
									<Checkbox
										className="note-select"
										aria-label="Select all shown notes"
										disabled={busy}
										checked={
											selectedShown === rows.length
												? true
												: selectedShown > 0
													? "indeterminate"
													: false
										}
										onCheckedChange={(checked) =>
											setSelected(
												checked === true
													? new Map(
															rows.map(({ id, stateRev }) => [
																id,
																selected.get(id) ?? stateRev,
															]),
														)
													: new Map(),
											)
										}
									>
										<CheckboxIndicator aria-hidden="true">
											{(state) => (state.indeterminate ? "−" : "✓")}
										</CheckboxIndicator>
									</Checkbox>
								</th>
								<th scope="col">Note</th>
								<th scope="col">Owner</th>
								<th scope="col" className="note-updated">
									Updated
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((note) => (
								<tr
									key={note.id}
									data-selected={selected.has(note.id) || undefined}
								>
									<td>
										<Checkbox
											className="note-select"
											aria-label={`Select ${note.title}`}
											checked={selected.has(note.id)}
											disabled={busy}
											onCheckedChange={(checked) => {
												setSelected((current) => {
													const next = new Map(current);
													if (checked === true)
														next.set(note.id, note.stateRev);
													else next.delete(note.id);
													return next;
												});
											}}
										>
											<CheckboxIndicator aria-hidden="true">
												✓
											</CheckboxIndicator>
										</Checkbox>
									</td>
									<td>
										<button
											type="button"
											className="note-list-title"
											disabled={busy}
											onClick={() => onOpen(note.id)}
										>
											{note.title}
										</button>
										{note.pinnedAt !== null && (
											<span className="pill">pinned</span>
										)}
										{note.preview !== "" && <small>{note.preview}</small>}
									</td>
									<td>{ownerName(note)}</td>
									<td className="note-updated">{relTime(note.updatedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{list?.truncated === true && (
				<p className="empty" role="status">
					Showing the first {rows.length} matching notes. Search or filter by owner to
					find more.
				</p>
			)}
		</div>
	);
}
