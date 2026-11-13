import { useEffect, useRef, useState, type RefObject } from "react";
import { listNotes } from "../api.ts";
import type { AppNoteSummary } from "../../../src/http/app-wire.ts";

// The composer's note picker — a search over the whole notes pool
// (project "all"), debounced like the rail's.
export function NotePicker({
	token,
	onPick,
	onClose,
	pickRef,
}: {
	token: string | null;
	onPick: (n: AppNoteSummary) => void;
	onClose: () => void;
	pickRef: RefObject<HTMLDivElement | null>;
}) {
	const [query, setQuery] = useState("");
	const [notes, setNotes] = useState<AppNoteSummary[] | null>(null);
	// The wire's hit-the-bound bit — a capped list must say so, not
	// read as complete (same contract as the notes index).
	const [truncated, setTruncated] = useState(false);
	const [failed, setFailed] = useState(false);
	const seq = useRef(0);
	useEffect(() => {
		const n = ++seq.current;
		const t = setTimeout(() => {
			void listNotes(token, { project: "all", q: query }).then(
				(r) => {
					if (n === seq.current) {
						setNotes(r.notes);
						setTruncated(r.truncated);
						setFailed(false);
					}
				},
				() => {
					if (n === seq.current) setFailed(true);
				},
			);
		}, 200);
		return () => clearTimeout(t);
	}, [query, token]);
	return (
		<div className="note-pick composer-pick" ref={pickRef}>
			<input
				type="search"
				placeholder="Search notes"
				aria-label="Search notes"
				value={query}
				autoFocus
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					// The input lives inside the composer form — an
					// unguarded Enter would implicitly submit the draft.
					// Both keys stay picker-local.
					if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						onClose();
					}
				}}
			/>
			{failed && <p className="error">Couldn't list notes.</p>}
			<ul>
				{(notes ?? []).map((n) => (
					<li key={n.id}>
						<button
							type="button"
							onClick={() => {
								onPick(n);
								onClose();
							}}
						>
							{n.title}
							{n.projectId !== null && <span className="note-proj"> · project</span>}
						</button>
					</li>
				))}
				{notes !== null && notes.length === 0 && (
					<li className="empty">{query === "" ? "No notes yet." : "No matches."}</li>
				)}
			</ul>
			{truncated && notes !== null && notes.length > 0 && (
				<p className="empty" role="status">
					Showing the first {notes.length} matching notes — narrow the search to find the rest.
				</p>
			)}
		</div>
	);
}
