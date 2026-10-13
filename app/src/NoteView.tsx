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
		void createNote(token, {
			title: "Untitled note",
			...(filter !== "all" && filter !== "loose" ? { projectId: filter } : {}),
		}).then(
			(n) => onOpen(n.id),
			(err) =>
				setError(`Couldn't create the note: ${err instanceof Error ? err.message : String(err)}`),
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
	onRestored,
}: {
	token: string | null;
	note: AppNote;
	// Restore swaps the doc wholesale — locked while local edits or a
	// conflict stand so it can't clobber an unsaved buffer.
	canRestore: boolean;
	onRestored: (note: AppNote) => void;
}) {
	const [versions, setVersions] = useState<AppNoteVersionMeta[] | null>(null);
	const [preview, setPreview] = useState<AppNoteVersion | null>(null);
	const [error, setError] = useState<string | null>(null);
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
		void restoreNoteVersion(token, note.id, rev).then(
			(n) => {
				setPreview(null);
				onRestored(n);
			},
			(err) => setError(`Couldn't restore: ${err instanceof Error ? err.message : String(err)}`),
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
							disabled={!canRestore}
							onClick={() => restore(preview.rev)}
						>
							Restore
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
	onDirtyChange,
}: {
	token: string | null;
	noteId: string;
	projects: AppProject[];
	// Starts a conversation carrying this note as an attachment —
	// bound to the note's project when it has one.
	onChat: (note: AppNote) => void;
	onDeleted: () => void;
	// Reports the leave-guard state: unsaved body or title edits, or a
	// standing conflict — anything navigation would silently destroy.
	onDirtyChange?: ((dirty: boolean) => void) | undefined;
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
	// A selection rewrite locks the editor — title, flags, restore and
	// the chat action lock with it so nothing races the apply PATCH.
	const [rewriteBusy, setRewriteBusy] = useState(false);
	// The apply PATCH itself is held — Keep mine/Load theirs must not
	// launch an ordinary save that races it.
	const [rewriteApplying, setRewriteApplying] = useState(false);
	const editorRef = useRef<NoteEditorHandle>(null);
	const dirtyRef = useRef(false);
	// Refs mirror what the focus check reads outside render: the loaded
	// note, and the title draft (an unsaved title is a local edit).
	const noteRef = useRef<AppNote | null>(null);
	const titleDraftRef = useRef("");
	noteRef.current = note;
	titleDraftRef.current = titleDraft;

	// Adopt remote state only forward — a delayed response must never
	// roll the page's rev (or flags) backwards.
	const adoptRemote = (data: AppNote) =>
		setNote((cur) =>
			cur === null ||
			data.rev > cur.rev ||
			(data.rev === cur.rev && data.updatedAt >= cur.updatedAt)
				? data
				: cur,
		);

	// The leave guard's truth: a dirty body, a dirty title, or a
	// standing conflict bar — all die silently with the component.
	const guardedDirty = note !== null && (conflict !== null || dirty || titleDraft !== note.title);
	useEffect(() => {
		onDirtyChange?.(guardedDirty);
	}, [onDirtyChange, guardedDirty]);
	// Unmount clears the parent's guard — a destroyed editor must not
	// leave the app refusing navigation forever.
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		let live = true;
		void getNote(token, noteId).then(
			({ data }) => {
				if (!live) return;
				setNote(data);
				setTitleDraft(data.title);
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
	// Refresh). A newer rev under a clean page loads silently; under a
	// dirty title or body it raises the conflict bar. Same-rev data
	// (flags, project) always lands on a clean page.
	useEffect(() => {
		let live = true;
		const check = () => {
			void getNote(token, noteId).then(
				({ data }) => {
					if (!live) return;
					const cur = noteRef.current;
					if (cur === null || data.rev < cur.rev) return;
					const titleDirty = titleDraftRef.current !== "" && titleDraftRef.current !== cur.title;
					const bodyDirty = dirtyRef.current || (editorRef.current?.dirty() ?? false);
					if (data.rev > cur.rev) {
						if (bodyDirty || titleDirty) {
							// Hand the block to the editor — autosave must stop,
							// not just show a bar. No editor (archived note) →
							// the bar alone.
							const h = editorRef.current;
							if (h === null) setConflict(data);
							else h.conflict(data);
						} else {
							editorRef.current?.reload(data);
							setTitleDraft(data.title);
						}
					} else if (!titleDirty) {
						setTitleDraft(data.title);
					}
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
				editorRef.current?.adoptRev(data);
			},
			(err) => {
				setBusy(false);
				setOpError(`Couldn't ${verb}: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};

	const saveTitle = () => {
		// A standing conflict needs an explicit Keep mine — a blur must
		// not send the local title over the adopted remote rev.
		if (conflict !== null) return;
		const t = titleDraft.trim();
		if (t === "" || t === note.title) {
			setTitleDraft(note.title);
			return;
		}
		void patchNote(token, note.id, { title: t }, { ifMatch: note.rev }).then(
			({ data }) => {
				adoptRemote(data);
				// The body didn't change — advance the If-Match rev only;
				// reload() would discard unsaved body edits.
				editorRef.current?.adoptRev(data);
			},
			(err) => {
				if (err instanceof NoteConflictError) {
					const h = editorRef.current;
					if (h === null) setConflict(err.note);
					else h.conflict(err.note);
				} else setOpError(`Couldn't rename: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};

	const remove = () => {
		if (!window.confirm(`Delete "${note.title}"? This removes the note and all its versions.`))
			return;
		void deleteNote(token, note.id).then(
			() => onDeleted(),
			(err) => setOpError(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`),
		);
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
							setNote(conflict);
							setTitleDraft(conflict.title);
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
					disabled={busy || rewriteBusy}
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
					disabled={busy || rewriteBusy}
					onClick={() => flag({ pinned: note.pinnedAt === null }, "pin the note")}
				>
					{note.pinnedAt === null ? "Pin" : "Unpin"}
				</button>
				<button
					type="button"
					className="ghost-inline"
					disabled={busy || rewriteBusy}
					onClick={() => flag({ archived: !archived }, "archive the note")}
				>
					{archived ? "Unarchive" : "Archive"}
				</button>
				{archived && (
					<button
						type="button"
						className="ghost-inline"
						disabled={busy || rewriteBusy}
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
					// Chat intake refuses archived attachments — unarchive first.
					disabled={archived || rewriteBusy}
					title={archived ? "Unarchive the note first" : undefined}
					onClick={() => onChat(note)}
				>
					Chat with this note
				</button>
			</div>
			{archived ? (
				<pre className="note-readonly">{note.body}</pre>
			) : (
				<Suspense fallback={<p className="loading">Loading editor…</p>}>
					<Editor
						ref={editorRef}
						token={token}
						noteId={note.id}
						initialBody={note.body}
						initialRev={note.rev}
						onSaved={(n) => {
							adoptRemote(n);
							// A landed write clears the bar unless a newer
							// remote was observed after this PATCH left — the
							// delayed response doesn't resolve that.
							setConflict((cur) => (cur !== null && cur.rev > n.rev ? cur : null));
						}}
						onConflict={(theirs) => setConflict(theirs)}
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
					canRestore={conflict === null && !dirty && !rewriteBusy}
					onRestored={(n) => {
						adoptRemote(n);
						setTitleDraft(n.title);
						editorRef.current?.reload(n);
					}}
				/>
			)}
		</div>
	);
}
