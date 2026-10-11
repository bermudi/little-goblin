// The project surfaces (design/projects.md): the rail's create dialog,
// the /app/projects index, and the /app/p/<id> page — rename,
// instructions, memory, archive, and the project's chat list with its
// own new-chat composer.

import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
	AppConversationList,
	AppNoteSummary,
	AppProject,
} from "../../src/http/app-wire.ts";
import { ApiError, createNote, createProject, listNotes, patchProject } from "./api.ts";

type Summary = AppConversationList["conversations"][number];

// The rail's modal. The slug is minted server-side — nothing here
// precomputes it; a refused path comes back 422 and shows inline.
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
	const canSubmit = !busy && name.trim() !== "" && (home === "managed" || dir.trim() !== "");
	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const created = await createProject(token, {
				name: name.trim(),
				...(instructions.trim() === "" ? {} : { instructions }),
				...(memory === "off" ? { memory } : {}),
				...(home === "linked" ? { dir: dir.trim() } : {}),
			});
			onCreated(created);
		} catch (err) {
			setError(
				err instanceof ApiError && err.status === 422
					? err.message
					: `Couldn't create the project: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="veil" onClick={onClose}>
			<div
				className="msheet"
				role="dialog"
				aria-label="New project"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="msheet-head">
					<h3>New project</h3>
					<button type="button" aria-label="Close" onClick={onClose}>
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
						<input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
					</label>
					<label className="frow">
						<span className="flabel">Instructions</span>
						<textarea
							rows={4}
							value={instructions}
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
								onChange={(e) => setDir(e.target.value)}
								placeholder="/absolute/path or ~/path"
							/>
						)}
					</div>
					<label className="frow">
						<span className="flabel">Memory</span>
						<select
							value={memory}
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

// One project row — name over its directory, the managed/linked badge.
function ProjectIndexRow({
	project,
	onOpen,
}: {
	project: AppProject;
	onOpen: (id: string) => void;
}) {
	return (
		<button type="button" className="idx" onClick={() => onOpen(project.id)}>
			<span className="ilabel">
				{project.name}
				<small>{project.dir}</small>
			</span>
			<span className="pill">{project.managed ? "managed" : "linked"}</span>
			<span className="chev">›</span>
		</button>
	);
}

// /app/projects — every project; archived ones wait behind the same
// collapsed-section pattern the rail's archived chats use.
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
				<div className="card">
					{active.map((p) => (
						<ProjectIndexRow key={p.id} project={p} onOpen={onOpen} />
					))}
				</div>
			)}
			<button type="button" className="ghost" onClick={onNew}>
				New project
			</button>
			{archived.length > 0 && (
				<details className="tuning">
					<summary>Archived projects ({archived.length})</summary>
					<div className="inner card">
						{archived.map((p) => (
							<ProjectIndexRow key={p.id} project={p} onOpen={onOpen} />
						))}
					</div>
				</details>
			)}
		</div>
	);
}

// The project's notes — fetched per page visit; "New note" is bound
// here from birth (design/projects.md → Notes).
function ProjectNotes({
	token,
	project,
	onOpenNote,
}: {
	token: string | null;
	project: AppProject;
	onOpenNote: (id: string) => void;
}) {
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		const run = () => {
			void listNotes(token, { project: project.id }).then(
				(r) => {
					if (!live) return;
					setNotes(r.notes);
					setError(null);
				},
				(err) =>
					live &&
					setError(`Couldn't list notes: ${err instanceof Error ? err.message : String(err)}`),
			);
		};
		run();
		// Refresh without push — same as the notes index (design →
		// Refresh).
		window.addEventListener("focus", run);
		return () => {
			live = false;
			window.removeEventListener("focus", run);
		};
	}, [token, project.id]);
	const newNote = () => {
		void createNote(token, { title: "Untitled note", projectId: project.id }).then(
			(n) => onOpenNote(n.id),
			(err) =>
				setError(`Couldn't create the note: ${err instanceof Error ? err.message : String(err)}`),
		);
	};
	return (
		<>
			<div className="row">
				<h2 className="ops-h2">Notes</h2>
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
				<p className="empty">No notes here yet.</p>
			) : (
				<div className="card">
					{notes.map((n) => (
						<button key={n.id} type="button" className="idx" onClick={() => onOpenNote(n.id)}>
							<span className="ilabel">
								{n.title}
								<small>{n.preview !== "" ? n.preview : `rev ${n.rev}`}</small>
							</span>
							{n.pinnedAt !== null && <span className="pill">pinned</span>}
							<span className="chev">›</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}

// /app/p/<id> — the project's own page: settings up top, then its chats
// (archived collapsed), then a composer that starts a bound
// conversation through the same createConversation → seed → select
// flow the empty state uses.
export function ProjectView({
	token,
	project,
	conversations,
	renderRow,
	onChanged,
	onOpenNote,
}: {
	token: string | null;
	project: AppProject;
	conversations: Summary[];
	renderRow: (conv: Summary) => ReactNode;
	onChanged: () => void;
	onOpenNote: (id: string) => void;
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
	const changeMemory = (next: "shared" | "off") => {
		if (next === project.memory) return;
		if (
			next === "off" &&
			!window.confirm(
				`Turn memory off for "${project.name}"? Its existing chats will stop sending and recalling memories.`,
			)
		) {
			return;
		}
		patch({ memory: next }, "change memory");
	};
	const toggleArchived = () =>
		patch(
			{ archived: project.archivedAt === null },
			project.archivedAt === null ? "archive the project" : "unarchive the project",
		);

	// The page shows every chat bound here — archived ones in their own
	// collapsed section (an archived project's chats only live here).
	const chats = conversations.filter((c) => c.projectId === project.id);
	const activeChats = chats.filter((c) => c.archivedAt === null);
	const archivedChats = chats
		.filter((c) => c.archivedAt !== null)
		.sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));
	const instrDirty = instructions !== project.instructions;

	return (
		<div className="ops projfields">
			{renaming ? (
				<div className="conv editing proj-rename">
					<input
						ref={nameRef}
						value={nameDraft}
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") setRenaming(false);
						}}
					/>
				</div>
			) : (
				<div className="row proj-head">
					<h2 className="proj-name">{project.name}</h2>
					<button
						type="button"
						className="ghost-inline"
						aria-label="Rename project"
						title="Rename"
						onClick={() => {
							setNameDraft(project.name);
							setRenaming(true);
						}}
					>
						rename
					</button>
				</div>
			)}
			<div className="kv">
				<span className="kv-k">Directory</span>
				<span className="kv-v">
					<code className="mono">{project.dir}</code>{" "}
					<span className="pill">{project.managed ? "managed" : "linked"}</span>{" "}
					{project.archivedAt !== null && <span className="pill">archived</span>}
				</span>
			</div>

			<h2 className="ops-h2">Instructions</h2>
			<div className="frow">
				<textarea
					rows={5}
					value={instructions}
					onChange={(e) => setInstructions(e.target.value)}
					placeholder="What should goblin know or do in this project?"
				/>
				<div className="row">
					<button
						type="button"
						className="addbtn"
						disabled={!instrDirty || busy}
						onClick={saveInstructions}
					>
						Save
					</button>
					<span className="cap">
						Edits apply to new chats — a running chat keeps the prompt it started with.
					</span>
				</div>
			</div>

			<h2 className="ops-h2">Memory</h2>
			<div className="frow">
				<select
					value={project.memory}
					disabled={busy}
					onChange={(e) => changeMemory(e.target.value === "off" ? "off" : "shared")}
				>
					<option value="shared">
						Shared memory — this project uses goblin's long-term memory like any chat
					</option>
					<option value="off">
						Memory off — chats in this project neither send nor recall memories
					</option>
				</select>
				<span className="cap">
					Switching off reaches existing chats too — they stop sending and recalling memories.
				</span>
			</div>

			<button type="button" className="ghost" disabled={busy} onClick={toggleArchived}>
				{project.archivedAt === null ? "Archive project" : "Unarchive project"}
			</button>
			{error !== null && (
				<p className="error" role="alert">
					{error}
				</p>
			)}

			<ProjectNotes token={token} project={project} onOpenNote={onOpenNote} />

			<h2 className="ops-h2">Chats</h2>
			{activeChats.length === 0 ? (
				<p className="empty">No chats here yet — write below to start one.</p>
			) : (
				<ul className="convlist">{activeChats.map((c) => renderRow(c))}</ul>
			)}
			{archivedChats.length > 0 && (
				<details className="tuning">
					<summary>Archived chats ({archivedChats.length})</summary>
					<div className="inner">
						<ul className="convlist">{archivedChats.map((c) => renderRow(c))}</ul>
					</div>
				</details>
			)}
		</div>
	);
}
