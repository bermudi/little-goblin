// The notes surfaces (design/projects.md → Notes): /app/notes index
// with search/filter/pinned/archived, and /app/n/<id> — title, the
// lazy Milkdown editor, project pin/archive/delete, versions, and
// "Chat with this note".

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
	AppNote,
	AppNoteSummary,
	AppNoteVersion,
	AppNoteVersionMeta,
	AppProject,
} from "../../src/http/app-wire.ts";
import {
	ApiError,
	NoteConflictError,
	createNote,
	deleteNote,
	getNote,
	getNoteVersion,
	listNoteVersions,
	listNotes,
	patchNote,
	restoreNoteVersion,
} from "./api.ts";
import type { NoteEditorHandle } from "./NoteEditor.tsx";
import { discardNoteDraft, loadNoteDraft, rawNoteDraft, type NoteDraft } from "./noteDraft.ts";

const Editor = lazy(() => import("./NoteEditor.tsx"));

// ---------- /app/notes ----------

function NoteIndexRow({
	note,
	projectName,
	onOpen,
}: {
	note: AppNoteSummary;
	projectName: string | null;
	onOpen: (id: string) => void;
}) {
	return (
		<button type="button" className="idx" onClick={() => onOpen(note.id)}>
			<span className="ilabel">
				{note.title}
				<small>
					{projectName ?? "loose"} · rev {note.rev}
					{note.preview !== "" ? ` — ${note.preview}` : ""}
				</small>
			</span>
			{note.pinnedAt !== null && <span className="pill">pinned</span>}
			<span className="chev">›</span>
		</button>
	);
}

export function NotesIndex({
	token,
	projects,
	onOpen,
}: {
	token: string | null;
	projects: AppProject[];
	onOpen: (id: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<string>("all");
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	const [archived, setArchived] = useState<AppNoteSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const seq = useRef(0);
	const mounted = useRef(true);
	const createSeq = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			createSeq.current += 1;
			seq.current += 1;
		};
	}, []);

	const projectName = (id: string | null): string | null =>
		id === null ? null : (projects.find((p) => p.id === id)?.name ?? "project");

	useEffect(() => {
		const run = () => {
			const n = ++seq.current;
			const scope =
				filter === "all"
					? { project: "all" }
					: filter === "loose"
						? { project: "loose" }
						: { project: filter };
			void Promise.all([
				listNotes(token, { ...scope, q: query }),
				listNotes(token, { ...scope, q: query, archived: true }),
			]).then(
				([active, gone]) => {
					if (n !== seq.current) return;
					setNotes(active.notes);
					setArchived(gone.notes);
					setError(null);
				},
				(err) => {
					if (n !== seq.current) return;
					setError(`Couldn't list notes: ${err instanceof Error ? err.message : String(err)}`);
				},
			);
		};
		// Debounced on input; immediate on window focus — refresh
		// without push (design → Refresh).
		const t = setTimeout(run, 200);
		const onFocus = () => {
			clearTimeout(t);
			run();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearTimeout(t);
			window.removeEventListener("focus", onFocus);
		};
	}, [query, filter, token]);

	const newNote = () => {
		const req = ++createSeq.current;
		void createNote(token, {
			title: "Untitled note",
			...(filter !== "all" && filter !== "loose" ? { projectId: filter } : {}),
		}).then(
			(n) => {
				if (!mounted.current || req !== createSeq.current) return;
				onOpen(n.id);
			},
			(err) => {
				if (!mounted.current || req !== createSeq.current) return;
				setError(`Couldn't create the note: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};

	return (
		<div className="ops">
			<h2 className="ops-h2">Notes</h2>
			<div className="row note-filters">
				<input
					type="search"
					placeholder="Search notes"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<select value={filter} onChange={(e) => setFilter(e.target.value)}>
					<option value="all">All</option>
					<option value="loose">Loose</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
				<button type="button" className="ghost" onClick={newNote}>
					New note
				</button>
			</div>
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{notes === null ? (
				<p className="loading">…</p>
			) : notes.length === 0 ? (
				<p className="empty">{query === "" ? "No notes yet." : "No matches."}</p>
			) : (
				<div className="card">
					{notes.map((n) => (
						<NoteIndexRow
							key={n.id}
							note={n}
							projectName={projectName(n.projectId)}
							onOpen={onOpen}
						/>
					))}
				</div>
			)}
			{archived !== null && archived.length > 0 && (
				<details className="tuning">
					<summary>Archived notes ({archived.length})</summary>
					<div className="inner card">
						{archived.map((n) => (
							<NoteIndexRow
								key={n.id}
								note={n}
								projectName={projectName(n.projectId)}
								onOpen={onOpen}
							/>
						))}
					</div>
				</details>
			)}
		</div>
	);
}

// ---------- /app/n/<id> ----------

function VersionsPanel({
	token,
	note,
	canRestore,
	canRestoreNow,
	onRestored,
	onConflict,
}: {
	token: string | null;
	note: AppNote;
	// Restore swaps the doc wholesale — locked while local edits or a
	// conflict stand so it can't clobber an unsaved buffer.
	canRestore: boolean;
	// Click-time recheck — the rendered flag can lag a dirty flip
	// that landed between render and the tap.
	canRestoreNow: () => boolean;
	onRestored: (note: AppNote) => void;
	// A stale-panel 409 hands back the live note — route it into the
	// same conflict path a remote write would raise.
	onConflict: (theirs: AppNote) => void;
}) {
	const [versions, setVersions] = useState<AppNoteVersionMeta[] | null>(null);
	const [preview, setPreview] = useState<AppNoteVersion | null>(null);
	const [error, setError] = useState<string | null>(null);
	// One restore in flight — a double-tap must not launch two swaps.
	const [restoring, setRestoring] = useState(false);
	useEffect(() => {
		void listNoteVersions(token, note.id).then(
			(v) => setVersions(v.versions),
			(err) =>
				setError(`Couldn't list versions: ${err instanceof Error ? err.message : String(err)}`),
		);
	}, [token, note.id, note.rev]);
	const openVersion = (rev: number) => {
		void getNoteVersion(token, note.id, rev).then(
			(v) => setPreview(v),
			(err) =>
				setError(`Couldn't load the version: ${err instanceof Error ? err.message : String(err)}`),
		);
	};
	const restore = (rev: number) => {
		if (restoring || !canRestoreNow()) return;
		setRestoring(true);
		// If-Match = the rev the panel is looking at — the server
		// refuses to roll back over a newer write.
		void restoreNoteVersion(token, note.id, rev, note.rev).then(
			(n) => {
				setRestoring(false);
				setPreview(null);
				onRestored(n);
			},
			(err) => {
				setRestoring(false);
				if (err instanceof NoteConflictError) {
					onConflict(err.note);
					return;
				}
				setError(`Couldn't restore: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};
	return (
		<div className="note-versions">
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{versions === null ? (
				<p className="loading">…</p>
			) : versions.length === 0 ? (
				<p className="empty">No versions yet.</p>
			) : (
				<ul>
					{versions.map((v) => (
						<li key={v.rev}>
							<button type="button" className="link" onClick={() => openVersion(v.rev)}>
								rev {v.rev} — {v.source}
								{v.conversation !== null ? " (chat)" : ""}
							</button>
							<small>
								{v.at} · {v.bytes} B
							</small>
						</li>
					))}
				</ul>
			)}
			{preview !== null && (
				<div className="note-version-preview">
					<div className="row">
						<strong>
							rev {preview.rev}: {preview.title}
						</strong>
						<button
							type="button"
							className="ghost-inline"
							disabled={!canRestore || restoring}
							onClick={() => restore(preview.rev)}
						>
							{restoring ? "Restoring…" : "Restore"}
						</button>
						{!canRestore && <small className="hint">Save or resolve edits before restoring</small>}
						<button type="button" className="ghost-inline" onClick={() => setPreview(null)}>
							Close
						</button>
					</div>
					<pre>{preview.body}</pre>
				</div>
			)}
		</div>
	);
}

// An archived note renders the server body read-only and never mounts
// the editor — without this disclosure a stored draft sits invisible
// until someone unarchives on faith. The bar names it and offers the
// explicit paths only: view/download the text, or discard the record.
// An unreadable record keeps the editor's hold-until-explicit rule —
// nothing here auto-deletes it.
function ArchivedDraft({ noteId }: { noteId: string }) {
	const [draft, setDraft] = useState<NoteDraft | "unreadable" | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		try {
			setDraft(loadNoteDraft(noteId)?.draft ?? null);
		} catch {
			setDraft("unreadable");
		}
	}, [noteId]);

	const discard = () => {
		try {
			discardNoteDraft(noteId);
		} catch (e) {
			setError(`Couldn't discard the draft: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		setDraft(null);
		setOpen(false);
	};
	const download = (text: string, ext: string) => {
		if (typeof URL.createObjectURL !== "function") return;
		const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `goblin-note-draft-${noteId}.${ext}`;
		a.click();
		URL.revokeObjectURL(url);
	};

	if (draft === null) {
		return error === null ? null : (
			<p className="error" role="alert">
				{error}
			</p>
		);
	}
	return (
		<div className="note-draft-error" role="alert">
			{draft === "unreadable" ? (
				<span>A stored draft for this note couldn't be read — it stays put until you act.</span>
			) : (
				<span>Unsaved local edits exist for this note — drafted against rev {draft.baseRev}.</span>
			)}
			<span className="row note-draft-actions">
				{draft !== "unreadable" && (
					<button type="button" className="ghost-inline" onClick={() => setOpen((v) => !v)}>
						{open ? "Hide draft" : "Show draft"}
					</button>
				)}
				<button
					type="button"
					className="ghost-inline"
					onClick={() => {
						try {
							const raw = draft === "unreadable" ? rawNoteDraft(noteId) : draft.body;
							if (raw !== null) download(raw, draft === "unreadable" ? "txt" : "md");
						} catch (e) {
							setError(`Couldn't read the draft: ${e instanceof Error ? e.message : String(e)}`);
						}
					}}
				>
					Download draft
				</button>
				<button type="button" className="ghost-inline" onClick={discard}>
					Discard draft
				</button>
			</span>
			{open && draft !== "unreadable" && <pre className="note-readonly">{draft.body}</pre>}
			{error !== null && <span className="error">{error}</span>}
		</div>
	);
}

// /app/n/<id> — one note. The editor autosaves on a debounce with
// If-Match; this page owns the flags (pin/archive/move/delete), the
// title, versions, and the conflict bar when the server-side rev moved
// under the editor.
export function NoteView({
	token,
	noteId,
	projects,
	onChat,
	onDeleted,
}: {
	token: string | null;
	noteId: string;
	projects: AppProject[];
	// Starts a conversation carrying this note as an attachment —
	// bound to the note's project when it has one.
	onChat: (note: AppNote) => Promise<void>;
	onDeleted: () => void;
}) {
	const [note, setNote] = useState<AppNote | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// Errors from a loaded page's operations render inline — a fatal
	// return would unmount the editor and drop unsaved buffers.
	const [opError, setOpError] = useState<string | null>(null);
	const [titleDraft, setTitleDraft] = useState("");
	const [conflict, setConflict] = useState<AppNote | null>(null);
	// Mirrors dirtyRef for rendering (the versions restore button).
	const [dirty, setDirty] = useState(false);
	const [versionsOpen, setVersionsOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [chatBusy, setChatBusy] = useState(false);
	// A selection rewrite locks the editor — title, flags, restore and
	// the chat action lock with it so nothing races the apply PATCH.
	const [rewriteBusy, setRewriteBusy] = useState(false);
	// The apply PATCH itself is held — Keep mine/Load theirs must not
	// launch an ordinary save that races it.
	const [rewriteApplying, setRewriteApplying] = useState(false);
	const editorRef = useRef<NoteEditorHandle>(null);
	const dirtyRef = useRef(false);
	// Refs mirror what the focus check and the async restore guard
	// read outside render — including the title draft, itself an
	// unsaved local edit.
	const noteRef = useRef<AppNote | null>(null);
	const titleDraftRef = useRef("");
	const conflictRef = useRef<AppNote | null>(null);
	const rewriteBusyRef = useRef(false);
	const chatBusyRef = useRef(false);
	// One title PATCH at a time — Enter and blur both commit, and a
	// second write on the same stale If-Match rev lands after the
	// first and 409s into a false conflict that blocks body autosave.
	// A commit arriving mid-flight just re-arms: the settle re-runs it
	// against the landed rev.
	const titleSavingRef = useRef(false);
	const titlePendingRef = useRef(false);
	// The in-flight title PATCH — chat() joins it before flushing the
	// body, or the body's stale If-Match lands behind the rename and
	// 409s into a conflict over the operator's own edit.
	const titleFlightRef = useRef<Promise<void> | null>(null);
	// What the field held when the in-flight title write left — an
	// ack's server-trimmed echo may sync the draft only while the
	// field still carries exactly that; edits typed over the flight
	// (a retype, a revert) are dirty work, not whitespace.
	const titleSentFieldRef = useRef<string | null>(null);
	noteRef.current = note;
	titleDraftRef.current = titleDraft;
	conflictRef.current = conflict;
	rewriteBusyRef.current = rewriteBusy;

	// A conflict note behind state the page already accepted — or
	// strictly older than the bar already standing — is a late reply,
	// not new information: it can neither raise nor move the bar. An
	// equal token is the same state (the editor's own conflict()
	// echoes the very note that just raised the bar here).
	const staleConflict = (theirs: AppNote): boolean => {
		const cur = noteRef.current;
		if (cur !== null && theirs.id === cur.id && theirs.stateRev < cur.stateRev) return true;
		const standing = conflictRef.current;
		return standing !== null && theirs.stateRev < standing.stateRev;
	};

	// Raise the conflict bar: the editor's own conflict() keeps its
	// autosave blocked and echoes through onConflict — which mirrors
	// conflict state/ref without re-entering the handle.
	const raiseConflict = (theirs: AppNote): void => {
		if (staleConflict(theirs)) return;
		conflictRef.current = theirs;
		const h = editorRef.current;
		if (h === null) setConflict(theirs);
		else h.conflict(theirs);
	};

	// Forward-only adoption of a server note — the single reconcile
	// path for focus refreshes, flag acks, restore acks, and own-save
	// acks (own = true: our own write's answer never reads as a remote
	// conflict). Equal-state own acks may resolve a conflict raised by
	// a refresh that observed the write before its response arrived.
	// Before the row moves, the title draft reconciles: a clean draft
	// takes the landed title, a dirty draft meeting a remote rename
	// keeps its text behind the conflict bar, and a dirty draft that
	// trim-matches the acked title syncs — leftover whitespace isn't
	// an unsaved edit.
	const adoptRemote = (data: AppNote, own = false): void => {
		const cur = noteRef.current;
		if (cur !== null && data.id === cur.id) {
			if (data.stateRev < cur.stateRev) return;
			if (data.stateRev === cur.stateRev) {
				if (own && conflictRef.current !== null && data.stateRev >= conflictRef.current.stateRev) {
					conflictRef.current = null;
					setConflict(null);
				}
				return;
			}
		}
		const standing = conflictRef.current;
		if (standing !== null && data.id === standing.id && data.stateRev < standing.stateRev) return;
		const draft = titleDraftRef.current;
		const titleDirty = cur !== null && draft !== cur.title;
		// While a title write is in flight, "untouched" is judged
		// against what the field held at dispatch — an edit typed over
		// the flight (retype or revert) must not be stamped over by the
		// ack's trimmed echo.
		const flightEdited = titleSentFieldRef.current !== null && draft !== titleSentFieldRef.current;
		const bodyDirty = dirtyRef.current || (editorRef.current?.dirty() ?? false);
		// Moves a local buffer must answer for: a content write, an
		// archive flip, or a rename while the title draft is dirty.
		const diverged =
			cur !== null &&
			(data.rev !== cur.rev ||
				data.archivedAt !== cur.archivedAt ||
				(titleDirty && data.title !== cur.title && draft.trim() !== data.title));
		if (!own && diverged && (bodyDirty || titleDirty)) {
			noteRef.current = data;
			setNote(data);
			raiseConflict(data);
			return;
		}
		if (
			cur === null ||
			(data.title !== draft && (draft.trim() === data.title || (!titleDirty && !flightEdited)))
		) {
			// A clean draft adopts a remote rename; an acked own title
			// syncs the draft to the server's trimmed store. The ref
			// moves now — the state mirror lands next render, and the
			// same-tick focus/title checks must already see it.
			titleDraftRef.current = data.title;
			setTitleDraft(data.title);
		}
		noteRef.current = data;
		setNote(data);
		if (standing !== null) {
			if (own && data.stateRev >= standing.stateRev) {
				// Our write landed on (or past) the conflicted state —
				// Keep mine's forced save resolves the bar.
				conflictRef.current = null;
				setConflict(null);
			} else if (data.stateRev > standing.stateRev) {
				// The bar stands, but "theirs" names the newest remote.
				conflictRef.current = data;
				setConflict(data);
			}
		}
		const h = editorRef.current;
		if (h !== null && !h.dirty()) h.adoptRev(data);
	};

	useEffect(() => {
		let live = true;
		void getNote(token, noteId).then(
			({ data }) => {
				if (!live) return;
				adoptRemote(data);
			},
			(err) => {
				if (!live) return;
				setLoadError(
					err instanceof ApiError && err.status === 404
						? "That note doesn't exist."
						: `Couldn't load the note: ${err instanceof Error ? err.message : String(err)}`,
				);
			},
		);
		return () => {
			live = false;
		};
	}, [token, noteId]);

	// Refetch on window focus — refresh without push (design →
	// Refresh). stateRev orders the check: a flag flip moves it without
	// touching rev/updatedAt, so an archive arriving under a dirty
	// buffer raises the same conflict a remote write does, and a clean
	// page swaps to the readonly view — while a delayed same-state
	// response is ignored entirely.
	useEffect(() => {
		let live = true;
		const check = () => {
			void getNote(token, noteId).then(
				({ data }) => {
					if (!live) return;
					adoptRemote(data);
				},
				(err) => {
					if (!live) return;
					setOpError(`Couldn't refresh: ${err instanceof Error ? err.message : String(err)}`);
				},
			);
		};
		window.addEventListener("focus", check);
		return () => {
			live = false;
			window.removeEventListener("focus", check);
		};
	}, [token, noteId]);

	if (loadError !== null) return <div className="error">{loadError}</div>;
	if (note === null) return <div className="loading">…</div>;

	const flag = (
		patch: { projectId?: string | null; pinned?: boolean; archived?: boolean },
		verb: string,
	) => {
		setBusy(true);
		void patchNote(token, note.id, patch).then(
			({ data }) => {
				setBusy(false);
				adoptRemote(data);
			},
			(err) => {
				setBusy(false);
				setOpError(`Couldn't ${verb}: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};

	const saveTitle = () => {
		const cur = noteRef.current;
		// A standing conflict needs an explicit Keep mine — a blur must
		// not send the local title over the adopted remote rev.
		if (cur === null || conflictRef.current !== null) return;
		if (titleSavingRef.current) {
			titlePendingRef.current = true;
			return;
		}
		const t = titleDraftRef.current.trim();
		if (t === "" || t === cur.title) {
			titleDraftRef.current = cur.title;
			setTitleDraft(cur.title);
			return;
		}
		const h = editorRef.current;
		if (h === null) {
			// The editor is still creating — the draft stays in the
			// field and the failure is visible, never a silent drop.
			setOpError("The editor isn't ready yet — your title edit is still in the field.");
			return;
		}
		// Title writes ride the editor's own save loop — one lane for
		// title AND body, so a title PATCH can never overtake or land
		// under an in-flight body write on the same rev.
		titleSavingRef.current = true;
		titleSentFieldRef.current = titleDraftRef.current;
		const settle = (ok: boolean, err?: unknown) => {
			titleSavingRef.current = false;
			titleSentFieldRef.current = null;
			titleFlightRef.current = null;
			if (!ok && conflictRef.current === null) {
				// A thrown save carries its cause; a false verdict is
				// only "the write didn't land" — either way the draft
				// stays in the field.
				setOpError(
					err !== undefined
						? `Couldn't save the title: ${err instanceof Error ? err.message : String(err)}`
						: "Couldn't save the title — your edit is still in the field.",
				);
			}
			if (titlePendingRef.current) {
				titlePendingRef.current = false;
				saveTitle();
			}
		};
		titleFlightRef.current = h.saveTitle(t).then(settle, (err: unknown) => settle(false, err));
	};

	const remove = () => {
		if (!window.confirm(`Delete "${note.title}"? This removes the note and all its versions.`))
			return;
		void deleteNote(token, note.id).then(
			() => onDeleted(),
			(err) => setOpError(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`),
		);
	};

	const chat = async (): Promise<void> => {
		const cur = noteRef.current;
		if (
			cur === null ||
			cur.archivedAt !== null ||
			busy ||
			chatBusyRef.current ||
			conflictRef.current !== null ||
			rewriteBusyRef.current
		) {
			return;
		}
		chatBusyRef.current = true;
		setChatBusy(true);
		try {
			const h = editorRef.current;
			if (h === null) {
				setOpError("The editor isn't ready yet — try again in a moment.");
				return;
			}
			// The click's blur may have committed a title PATCH that's
			// still in flight — it bumps the rev, so a body flush on the
			// stale If-Match 409s over the operator's own rename. Join it
			// (and any pending re-run it chains) before flushing.
			while (titleSavingRef.current && titleFlightRef.current !== null) {
				await titleFlightRef.current;
			}
			if (conflictRef.current !== null) return;
			const ok = await h.flushAndWait();
			if (!ok) {
				setOpError("Couldn't save pending edits — resolve or retry before starting the chat.");
				return;
			}
			const now = noteRef.current;
			if (
				now === null ||
				now.archivedAt !== null ||
				conflictRef.current !== null ||
				rewriteBusyRef.current
			) {
				return;
			}
			await onChat(now);
		} catch (err) {
			setOpError(
				`Couldn't prepare this note for chat: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			chatBusyRef.current = false;
			setChatBusy(false);
		}
	};

	const archived = note.archivedAt !== null;
	return (
		<div className="ops notepage">
			{opError !== null && (
				<p className="error" role="alert">
					{opError}
				</p>
			)}
			{conflict !== null && (
				<div className="note-conflict" role="alert">
					<span>This note changed elsewhere (rev {conflict.rev}) — your edits are unsaved.</span>
					<button
						type="button"
						className="ghost-inline"
						disabled={rewriteApplying}
						onClick={() => {
							editorRef.current?.resolve("theirs", conflict);
							noteRef.current = conflict;
							setNote(conflict);
							titleDraftRef.current = conflict.title;
							setTitleDraft(conflict.title);
							conflictRef.current = null;
							setConflict(null);
						}}
					>
						Load theirs
					</button>
					<button
						type="button"
						className="ghost-inline"
						disabled={rewriteApplying}
						onClick={() => {
							const t = titleDraft.trim();
							editorRef.current?.resolve("mine", conflict, t === "" ? conflict.title : t);
						}}
					>
						Keep mine
					</button>
				</div>
			)}
			<div className="row note-head">
				<input
					className="note-title"
					value={titleDraft}
					onChange={(e) => setTitleDraft(e.target.value)}
					onBlur={saveTitle}
					onKeyDown={(e) => {
						if (e.key === "Enter") saveTitle();
					}}
					disabled={archived || rewriteBusy}
				/>
				{note.pinnedAt !== null && <span className="pill">pinned</span>}
				{archived && <span className="pill">archived</span>}
			</div>
			<div className="row note-flags">
				<select
					value={note.projectId ?? ""}
					disabled={busy || rewriteBusy || chatBusy}
					onChange={(e) =>
						flag({ projectId: e.target.value === "" ? null : e.target.value }, "move the note")
					}
				>
					<option value="">Loose</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
				<button
					type="button"
					className="ghost-inline"
					disabled={busy || rewriteBusy || chatBusy}
					onClick={() => flag({ pinned: note.pinnedAt === null }, "pin the note")}
				>
					{note.pinnedAt === null ? "Pin" : "Unpin"}
				</button>
				<button
					type="button"
					className="ghost-inline"
					disabled={busy || rewriteBusy || chatBusy}
					onClick={() => flag({ archived: !archived }, "archive the note")}
				>
					{archived ? "Unarchive" : "Archive"}
				</button>
				{archived && (
					<button
						type="button"
						className="ghost-inline"
						disabled={busy || rewriteBusy || chatBusy}
						onClick={remove}
					>
						Delete
					</button>
				)}
				<button type="button" className="ghost-inline" onClick={() => setVersionsOpen((v) => !v)}>
					Versions
				</button>
				<button
					type="button"
					className="ghost"
					disabled={busy || rewriteBusy || chatBusy || archived || conflict !== null}
					title={archived ? "Unarchive this note to chat with it." : undefined}
					onClick={() => void chat()}
				>
					Chat with this note
				</button>
			</div>
			{/* While a conflict stands the editor stays mounted even on
			    an archived note — unmounting would drop the dirty buffer
			    the bar is asking about, and Keep mine needs the handle. */}
			{archived && conflict === null ? (
				<>
					<ArchivedDraft noteId={note.id} />
					<pre className="note-readonly">{note.body}</pre>
				</>
			) : (
				<Suspense fallback={<p className="loading">Loading editor…</p>}>
					<Editor
						ref={editorRef}
						token={token}
						noteId={note.id}
						initialNote={note}
						// Own save acks reconcile through the same forward
						// guard — they can resolve the bar (Keep mine's write
						// landing on the conflicted state) but can never read
						// as a fresh remote conflict.
						onSaved={(n) => adoptRemote(n, true)}
						onConflict={(theirs) => {
							// Same fence as raiseConflict — a late 409 must
							// not roll a newer bar (or accepted state) back.
							if (staleConflict(theirs)) return;
							conflictRef.current = theirs;
							setConflict(theirs);
						}}
						onDirty={(d) => {
							dirtyRef.current = d;
							setDirty(d);
						}}
						onRewriteBusy={setRewriteBusy}
						onRewriteApplying={setRewriteApplying}
					/>
				</Suspense>
			)}
			{versionsOpen && (
				<VersionsPanel
					token={token}
					note={note}
					canRestore={conflict === null && !dirty && !rewriteBusy && titleDraft === note.title}
					canRestoreNow={() => {
						const cur = noteRef.current;
						return (
							cur !== null &&
							conflictRef.current === null &&
							!rewriteBusyRef.current &&
							titleDraftRef.current === cur.title &&
							!(dirtyRef.current || (editorRef.current?.dirty() ?? false))
						);
					}}
					// A landed restore rides the same forward guard as a
					// focus refresh — a delayed or already-adopted ack is
					// ignored, edits that landed mid-flight get the bar.
					onRestored={(n) => adoptRemote(n)}
					// The restore 409 carries the live note — the same
					// conflict path as a remote write.
					onConflict={raiseConflict}
				/>
			)}
		</div>
	);
}
