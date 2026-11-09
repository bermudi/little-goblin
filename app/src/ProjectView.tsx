import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { AppConversationList, AppNoteSummary, AppProject } from "../../src/http/app-wire.ts";
import { ApiError, createNote, createProject, listNotes, patchProject } from "./api.ts";
import { useConfirm } from "./confirm.tsx";
import { relTime } from "./memoryShared.tsx";
import { ResponsibilityFeed } from "./ResponsibilityFeed.tsx";

type Summary = AppConversationList["conversations"][number];

// The slug is minted server-side — nothing here precomputes it; a
// refused path comes back 422 and shows inline.
export function NewProjectDialog({
	token,
	onClose,
	onCreated,
}: {
	token: string | null;
	onClose: () => void;
	onCreated: (project: AppProject) => void;
}) {
	const [name, setName] = useState("");
	const [instructions, setInstructions] = useState("");
	const [home, setHome] = useState<"managed" | "linked">("managed");
	const [dir, setDir] = useState("");
	const [memory, setMemory] = useState<"shared" | "off">("shared");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A dismissed dialog's in-flight create still lands server-side,
	// but its completion must not run: a late onCreated would navigate
	// away from (or confirm over) whatever the operator opened next.
	// `live` drops synchronously in dismiss — before the unmount's
	// effect cleanup — so a reply already queued can't slip through
	// the gap; the request id fences a superseded submit the same way.
	// Setup rearms because StrictMode replays mount effects — the
	// replayed cleanup would leave it false for the real lifetime.
	const live = useRef(true);
	const reqSeq = useRef(0);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const dismiss = () => {
		live.current = false;
		onClose();
	};
	const canSubmit = !busy && name.trim() !== "" && (home === "managed" || dir.trim() !== "");
	const submit = async () => {
		const req = ++reqSeq.current;
		setBusy(true);
		setError(null);
		try {
			const created = await createProject(token, {
				name: name.trim(),
				...(instructions.trim() === "" ? {} : { instructions }),
				...(memory === "off" ? { memory } : {}),
				...(home === "linked" ? { dir: dir.trim() } : {}),
			});
			if (!live.current || req !== reqSeq.current) return;
			onCreated(created);
		} catch (err) {
			if (!live.current || req !== reqSeq.current) return;
			setError(
				err instanceof ApiError && err.status === 422
					? err.message
					: `Couldn't create the project: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			if (live.current && req === reqSeq.current) setBusy(false);
		}
	};
	return (
		<div className="veil" onClick={dismiss}>
			<div
				className="msheet"
				role="dialog"
				aria-label="New project"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="msheet-head">
					<h3>New project</h3>
					<button type="button" aria-label="Close" title="Close" onClick={dismiss}>
						×
					</button>
				</header>
				<form
					className="msheet-body projform"
					onSubmit={(e) => {
						e.preventDefault();
						if (canSubmit) void submit();
					}}
				>
					<label className="frow">
						<span className="flabel">Name</span>
						<input
							value={name}
							aria-label="Name"
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</label>
					<label className="frow">
						<span className="flabel">Instructions</span>
						<textarea
							rows={4}
							value={instructions}
							aria-label="Instructions"
							onChange={(e) => setInstructions(e.target.value)}
							placeholder="What should goblin know or do in this project?"
						/>
					</label>
					<div className="frow">
						<span className="flabel">Home</span>
						<label className="radio">
							<input
								type="radio"
								name="proj-home"
								checked={home === "managed"}
								onChange={() => setHome("managed")}
							/>
							<span>
								Managed by goblin
								<small className="cap">
									a folder under goblin's projects/ directory, named after the project
								</small>
							</span>
						</label>
						<label className="radio">
							<input
								type="radio"
								name="proj-home"
								checked={home === "linked"}
								onChange={() => setHome("linked")}
							/>
							<span>Existing folder</span>
						</label>
						{home === "linked" && (
							<input
								className="mono"
								value={dir}
								aria-label="Directory path"
								onChange={(e) => setDir(e.target.value)}
								placeholder="/absolute/path or ~/path"
							/>
						)}
					</div>
					<label className="frow">
						<span className="flabel">Memory</span>
						<select
							value={memory}
							aria-label="Memory mode"
							onChange={(e) => setMemory(e.target.value === "off" ? "off" : "shared")}
						>
							<option value="shared">
								Shared memory — this project uses goblin's long-term memory like any chat
							</option>
							<option value="off">
								Memory off — chats in this project neither send nor recall memories
							</option>
						</select>
					</label>
					{error !== null && (
						<p className="err-inline" role="alert">
							{error}
						</p>
					)}
					<button type="submit" className="addbtn" disabled={!canSubmit}>
						Create project
					</button>
				</form>
			</div>
		</div>
	);
}

const PROJECT_COLS = {
	"--dt-cols": "minmax(10rem, 1.6fr) minmax(12rem, 3fr) 6rem 6.5rem 5.5rem",
} as CSSProperties;

// A table of like things (design/app.md → Non-chat page layout): the
// row is the open action; "kind" is the status-pill column.
function ProjectTable({
	projects,
	onOpen,
}: {
	projects: AppProject[];
	onOpen: (id: string) => void;
}) {
	return (
		<div className="dtable" style={PROJECT_COLS}>
			<div className="dt-head" aria-hidden="true">
				<span>Project</span>
				<span>Directory</span>
				<span>Memory</span>
				<span>Created</span>
				<span>Kind</span>
			</div>
			{projects.map((p) => (
				<button type="button" className="dt-row" key={p.id} onClick={() => onOpen(p.id)}>
					<span className="dt-cell dt-main">{p.name}</span>
					<span className="dt-cell dt-mono" data-label="Directory">
						{p.dir}
					</span>
					<span className="dt-cell" data-label="Memory">
						{p.memory === "off" ? "off" : "shared"}
					</span>
					<span className="dt-cell dt-hide-m">
						{new Date(p.createdAt).toLocaleDateString(undefined, {
							month: "short",
							day: "numeric",
							year: "numeric",
						})}
					</span>
					<span className="dt-cell dt-status">
						<span className="pill">{p.managed ? "managed" : "linked"}</span>
					</span>
				</button>
			))}
		</div>
	);
}

// Archived projects wait behind the same collapsed-section pattern the
// rail's archived chats use.
export function ProjectsIndex({
	projects,
	onOpen,
	onNew,
}: {
	projects: AppProject[];
	onOpen: (id: string) => void;
	onNew: () => void;
}) {
	const active = projects
		.filter((p) => p.archivedAt === null)
		.sort((a, b) => a.name.localeCompare(b.name));
	const archived = projects
		.filter((p) => p.archivedAt !== null)
		.sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));
	return (
		<div className="ops">
			<h2 className="ops-h2">Projects</h2>
			{active.length === 0 ? (
				<p className="empty">
					No projects yet — a project gives related chats their own directory and instructions.
				</p>
			) : (
				<ProjectTable projects={active} onOpen={onOpen} />
			)}
			<button type="button" className="ghost" onClick={onNew}>
				New project
			</button>
			{archived.length > 0 && (
				<details className="tuning">
					<summary>Archived projects ({archived.length})</summary>
					<div className="inner">
						<ProjectTable projects={archived} onOpen={onOpen} />
					</div>
				</details>
			)}
		</div>
	);
}

// Notes and chats share one shape: name | preview | updated | pinned.
const ITEM_COLS = {
	"--dt-cols": "minmax(10rem, 1.4fr) minmax(12rem, 3fr) 6.5rem 5rem",
} as CSSProperties;

// The table cell is one line; a chat's newest text may span many.
const flatPreview = (text: string): string => text.replace(/\s+/g, " ").trim();

// A page section: the heading and its action sit on one line, the
// count beside the heading (design/app.md → Non-chat page layout).
function ProjectSection({
	title,
	count,
	action,
	children,
}: {
	title: string;
	count?: number | undefined;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="proj-sec">
			<div className="proj-sec-head">
				<h2 className="ops-h2">
					{title}
					{count !== undefined && <span className="pill">{count}</span>}
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

// The project's notes — fetched per page visit; a new note is bound
// here from birth.
function ProjectNotes({
	token,
	project,
	onOpenNote,
	onChanged,
}: {
	token: string | null;
	project: AppProject;
	onOpenNote: (id: string) => void;
	onChanged: () => void;
}) {
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const creatingRef = useRef(false);
	// A create finishing after the page unmounted must not navigate —
	// the operator already left; the note itself still exists. Setup
	// rearms because StrictMode replays mount effects.
	const mounted = useRef(true);
	const createSeq = useRef(0);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		let live = true;
		const run = () => {
			void listNotes(token, { project: project.id }).then(
				(r) => {
					if (!live) return;
					setNotes(r.notes);
					setTruncated(r.truncated);
					setError(null);
				},
				(err) =>
					live &&
					setError(`Couldn't list notes: ${err instanceof Error ? err.message : String(err)}`),
			);
		};
		run();
		// Refetch on focus — refresh without push, same as the notes
		// index.
		window.addEventListener("focus", run);
		return () => {
			live = false;
			window.removeEventListener("focus", run);
		};
	}, [token, project.id]);
	const newNote = () => {
		if (creatingRef.current) return;
		creatingRef.current = true;
		setCreating(true);
		const seq = ++createSeq.current;
		void createNote(token, {
			title: "Untitled note",
			projectId: project.id,
		}).then(
			(n) => {
				onChanged();
				if (!mounted.current || seq !== createSeq.current) return;
				creatingRef.current = false;
				setCreating(false);
				onOpenNote(n.id);
			},
			(err) => {
				if (!mounted.current || seq !== createSeq.current) return;
				creatingRef.current = false;
				setCreating(false);
				setError(`Couldn't create the note: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};
	return (
		<ProjectSection
			title="Notes"
			count={notes?.length}
			action={
				<button type="button" className="addbtn proj-btn" disabled={creating} onClick={newNote}>
					New note
				</button>
			}
		>
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			{truncated && (
				<p className="cap" role="status">
					Showing the first {notes?.length} notes. Use the Notes search to find other notes.
				</p>
			)}
			{notes === null ? (
				<p className="loading">…</p>
			) : notes.length === 0 ? (
				<p className="empty">No notes here yet.</p>
			) : (
				<div className="dtable" style={ITEM_COLS}>
					<div className="dt-head" aria-hidden="true">
						<span>Note</span>
						<span>Preview</span>
						<span>Updated</span>
						<span />
					</div>
					{notes.map((n) => (
						<button key={n.id} type="button" className="dt-row" onClick={() => onOpenNote(n.id)}>
							<span className="dt-cell dt-main">{n.title}</span>
							<span className="dt-cell">{n.preview !== "" ? n.preview : `rev ${n.rev}`}</span>
							<span className="dt-cell" data-label="Updated">
								{relTime(n.updatedAt)}
							</span>
							<span className="dt-cell dt-status">
								{n.pinnedAt !== null && <span className="pill">pinned</span>}
							</span>
						</button>
					))}
				</div>
			)}
		</ProjectSection>
	);
}

// The composer starts a bound conversation through the same create →
// seed → select flow the empty state uses.
export function ProjectView({
	token,
	project,
	conversations,
	renderRow,
	onChanged,
	onOpenNote,
	onConversation,
}: {
	token: string | null;
	project: AppProject;
	conversations: Summary[];
	renderRow: (conv: Summary) => ReactNode;
	onChanged: () => void;
	onOpenNote: (id: string) => void;
	onConversation?: ((conversationId: string) => void) | undefined;
}) {
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	const [instructions, setInstructions] = useState(project.instructions);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	// Same double-commit guard as ConversationRow's rename — Enter
	// unmounts the input, whose blur would PATCH a second time.
	const committed = useRef(false);
	const confirm = useConfirm();
	useEffect(() => {
		if (renaming) {
			committed.current = false;
			nameRef.current?.focus();
			nameRef.current?.select();
		}
	}, [renaming]);

	const patch = (body: Parameters<typeof patchProject>[2], verb: string) => {
		setBusy(true);
		setError(null);
		void patchProject(token, project.id, body).then(
			() => {
				setBusy(false);
				onChanged();
			},
			(err) => {
				setBusy(false);
				setError(`Couldn't ${verb}: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	};

	const commitRename = () => {
		if (committed.current) return;
		committed.current = true;
		const t = nameDraft.trim();
		setRenaming(false);
		if (t === "" || t === project.name) return;
		patch({ name: t }, "rename the project");
	};
	const saveInstructions = () => patch({ instructions }, "save instructions");
	const changeMemory = async (next: "shared" | "off") => {
		if (next === project.memory) return;
		if (
			next === "off" &&
			!(await confirm.ask({
				message: `Turn memory off for "${project.name}"? Its existing chats will stop sending and recalling memories.`,
				confirmLabel: "Turn off",
			}))
		) {
			return;
		}
		patch({ memory: next }, "change memory");
	};
	const toggleArchived = async () => {
		const archiving = project.archivedAt === null;
		if (
			archiving &&
			!(await confirm.ask({
				message: `Archive "${project.name}"? It moves to Archived projects and its composer closes. Chats and notes are kept.`,
				confirmLabel: "Archive",
			}))
		) {
			return;
		}
		patch({ archived: archiving }, archiving ? "archive the project" : "unarchive the project");
	};

	// The page shows every chat bound here — archived ones in their own
	// collapsed section (an archived project's chats only live here).
	const chats = conversations.filter((c) => c.projectId === project.id);
	const activeChats = chats.filter((c) => c.archivedAt === null);
	const archivedChats = chats
		.filter((c) => c.archivedAt !== null)
		.sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));
	const instrDirty = instructions !== project.instructions;

	const memoryNote =
		project.memory === "shared"
			? "This project uses goblin's long-term memory like any chat."
			: "Chats in this project neither send nor recall memories.";

	return (
		<div className="ops projfields">
			{renaming ? (
				<div className="conv editing proj-rename">
					<input
						ref={nameRef}
						value={nameDraft}
						aria-label="Project name"
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							// Escape cancels — without committed the
							// unmount's blur would PATCH the draft anyway.
							if (e.key === "Escape") {
								committed.current = true;
								setRenaming(false);
							}
						}}
					/>
				</div>
			) : (
				<div className="proj-head">
					<h2 className="proj-name">{project.name}</h2>
					<button
						type="button"
						className="ghost proj-btn"
						aria-label="Rename project"
						title="Rename"
						onClick={() => {
							setNameDraft(project.name);
							setRenaming(true);
						}}
					>
						Rename
					</button>
				</div>
			)}
			<div className="proj-dir">
				<span className="proj-dir-k">Directory</span>
				<code className="mono proj-dir-v" title={project.dir}>
					{project.dir}
				</code>
				<span className="pill">{project.managed ? "managed" : "linked"}</span>
				{project.archivedAt !== null && <span className="pill">archived</span>}
			</div>
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}

			<ProjectSection
				title="Instructions"
				action={
					<button
						type="button"
						className="addbtn proj-btn"
						disabled={!instrDirty || busy}
						onClick={saveInstructions}
					>
						Save
					</button>
				}
			>
				<div className="frow">
					<textarea
						rows={6}
						value={instructions}
						aria-label="Instructions"
						onChange={(e) => setInstructions(e.target.value)}
						placeholder="What should goblin know or do in this project?"
					/>
					<span className="cap">
						Edits apply to new chats — a running chat keeps the prompt it started with.
					</span>
				</div>
			</ProjectSection>

			<ProjectSection title="Memory">
				<div className="frow">
					<div className="seg proj-seg" role="radiogroup" aria-label="Memory mode">
						{(["shared", "off"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								role="radio"
								aria-checked={project.memory === mode}
								className={project.memory === mode ? "seg-btn on" : "seg-btn"}
								disabled={busy}
								onClick={() => void changeMemory(mode)}
							>
								{mode === "shared" ? "Shared" : "Off"}
							</button>
						))}
					</div>
					<span className="cap">{memoryNote} Switching off reaches existing chats too.</span>
				</div>
			</ProjectSection>

			<ProjectNotes token={token} project={project} onOpenNote={onOpenNote} onChanged={onChanged} />

			<ResponsibilityFeed token={token} projectId={project.id} onConversation={onConversation} />

			<ProjectSection title="Chats" count={activeChats.length}>
				{activeChats.length === 0 ? (
					<p className="empty">No chats here yet — write below to start one.</p>
				) : (
					<div className="dtable" style={ITEM_COLS}>
						<div className="dt-head" aria-hidden="true">
							<span>Chat</span>
							<span>Last message</span>
							<span>Updated</span>
							<span />
						</div>
						{activeChats.map((c) => {
							const preview = flatPreview(c.preview);
							return (
								<button
									key={c.id}
									type="button"
									className="dt-row"
									onClick={() => onConversation?.(c.id)}
								>
									<span className="dt-cell dt-main">
										{c.title ?? (preview === "" ? "new conversation" : preview)}
									</span>
									<span
										className={c.title !== null && preview !== "" ? "dt-cell" : "dt-cell dt-hide-m"}
									>
										{c.title !== null && preview !== "" ? preview : "—"}
									</span>
									<span className="dt-cell" data-label="Updated">
										{relTime(c.updatedAt)}
									</span>
									<span className="dt-cell dt-status">
										{c.pinnedAt !== null && <span className="pill">pinned</span>}
									</span>
								</button>
							);
						})}
					</div>
				)}
				{archivedChats.length > 0 && (
					<details className="tuning">
						<summary>Archived chats ({archivedChats.length})</summary>
						<div className="inner">
							<ul className="convlist">{archivedChats.map((c) => renderRow(c))}</ul>
						</div>
					</details>
				)}
			</ProjectSection>

			<section className={project.archivedAt === null ? "proj-foot danger-zone" : "proj-foot"}>
				<div className="proj-foot-text">
					<b>{project.archivedAt === null ? "Archive this project" : "This project is archived"}</b>
					<span className="cap">
						{project.archivedAt === null
							? "Moves it to Archived projects and closes its composer. Chats and notes are kept; you can unarchive it later."
							: "Unarchive it to start new chats here."}
					</span>
				</div>
				<button
					type="button"
					className={project.archivedAt === null ? "danger proj-btn" : "ghost proj-btn"}
					disabled={busy}
					onClick={() => void toggleArchived()}
				>
					{project.archivedAt === null ? "Archive project" : "Unarchive project"}
				</button>
			</section>
			{confirm.view}
		</div>
	);
}
