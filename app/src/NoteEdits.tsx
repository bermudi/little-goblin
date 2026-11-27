import { useEffect, useRef, useState } from "react";
import { LITTLE_GOBLIN_NOTE_OWNER } from "../../src/note-owner.ts";
import type { NoteEdit, NoteEditMeta, NoteEditPage, NoteTextChange } from "../../src/note-edit.ts";
import { getNoteEdit, listNoteEdits } from "./api.ts";

function authorName(author: NoteEditMeta["author"]): string {
	if (author === "operator") return "Operator";
	return author.botId === LITTLE_GOBLIN_NOTE_OWNER ? "Little Goblin" : author.botId;
}

function TextChange({ label, change }: { label: string; change: NoteTextChange }) {
	return (
		<div className="note-edit-diff">
			<strong>{label}</strong>
			<dl>
				<dt>Removed</dt>
				<dd><pre>{change.before === "" ? "(empty)" : change.before}</pre></dd>
				<dt>Added</dt>
				<dd><pre>{change.after === "" ? "(empty)" : change.after}</pre></dd>
			</dl>
		</div>
	);
}

export default function NoteEdits({
	token, id, rev, formatTime,
}: {
	token: string | null;
	id: string;
	rev: number;
	formatTime: (at: string) => string;
}) {
	const [page, setPage] = useState<NoteEditPage | null>(null);
	const [older, setOlder] = useState(false);
	const [preview, setPreview] = useState<NoteEdit | null>(null);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<{ active: boolean } | null>(null);
	const detail = useRef({ sequence: 0 });
	useEffect(() => {
		const current = { active: true };
		request.current = current;
		setOlder(false);
		void listNoteEdits(token, id).then((next) => {
			if (!current.active) return;
			setPage(next);
			setError(null);
		}, () => {
			if (current.active) setError("Couldn't list edits.");
		});
		return () => { current.active = false; };
	}, [token, id, rev]);
	useEffect(() => {
		const scope = detail.current;
		return () => { scope.sequence++; };
	}, [token, id]);

	async function showOlder() {
		const current = request.current;
		if (current === null || older || page === null || page.before === null) return;
		setOlder(true);
		try {
			const next = await listNoteEdits(token, id, page.before);
			if (!current.active) return;
			setPage({ edits: [...page.edits, ...next.edits], before: next.before });
			setError(null);
		} catch {
			if (current.active) setError("Couldn't load earlier edits.");
		} finally {
			if (current.active) setOlder(false);
		}
	}

	async function openDiff(revision: number) {
		const scope = detail.current;
		const current = ++scope.sequence;
		try {
			const edit = await getNoteEdit(token, id, revision);
			if (scope.sequence !== current) return;
			setPreview(edit);
			setError(null);
		} catch {
			if (scope.sequence === current) setError("Couldn't load the diff.");
		}
	}

	return (
		<section className="note-edits" aria-label="Edit history">
			<strong>Edit history</strong>
			{error !== null && <p className="error" role="alert">{error}</p>}
			{preview !== null && (
				<div className="note-version-preview" aria-label={`Diff for revision ${preview.rev}`}>
					<div className="row">
						<strong>Revision {preview.rev} · {authorName(preview.author)}</strong>
						<button type="button" className="ghost-inline" onClick={() => {
							detail.current.sequence++;
							setPreview(null);
						}}>Close diff</button>
					</div>
					{preview.title !== null && <TextChange label="Title" change={preview.title} />}
					{preview.body !== null && <TextChange label="Body" change={preview.body} />}
				</div>
			)}
			{page === null && error === null && <p className="loading">Loading edits…</p>}
			{page?.edits.length === 0 && <p className="empty">No recorded edits yet.</p>}
			{page && page.edits.length > 0 && (
				<ul>
					{page.edits.map((edit) => (
						<li key={edit.rev}>
							<div className="row">
								<button type="button" className="link" onClick={() => void openDiff(edit.rev)}>
									View diff · rev {edit.rev}
								</button>
								<span>{authorName(edit.author)}</span>
								<small><time dateTime={edit.at}>{formatTime(edit.at)}</time></small>
							</div>
							{edit.what !== null && <span>{edit.what}</span>}
							{edit.reason !== null && <span className="note-edit-why">{edit.reason}</span>}
						</li>
					))}
				</ul>
			)}
			{page !== null && page.before !== null && (
				<button type="button" className="link" disabled={older} onClick={() => void showOlder()}>
					{older ? "Loading…" : "Earlier edits"}
				</button>
			)}
		</section>
	);
}
