import { useEffect, useRef, useState, type RefObject } from "react";
import { Command, CommandInput, CommandItem, CommandList } from "@ui-sdk/react/command";
import { listNotes } from "../api.ts";
import type { AppNoteSummary } from "../../../src/http/app-wire.ts";

// The composer's note picker — a search over the whole notes pool
// (project "all"), debounced like the rail's. The list mechanics
// (arrow-key highlight, Enter-to-run, listbox ARIA) come from
// @ui-sdk/react's `command` primitive, with `filter={false}` because the
// wire narrows the rows; the debounce, the truncation notice, and the
// picker-local keys stay here.
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
	const byId = new Map((notes ?? []).map((n) => [n.id, n]));
	return (
		<div className="note-pick composer-pick" ref={pickRef}>
			<Command
				className="note-pick-command"
				query={query}
				onQueryChange={setQuery}
				filter={false}
				onAction={(id) => {
					const n = byId.get(id);
					if (n !== undefined) {
						onPick(n);
						onClose();
					}
				}}
				onKeyDownCapture={(e) => {
					// The input lives inside the composer form — an
					// unguarded Enter would implicitly submit the draft,
					// so the picker owns both keys before the command sees
					// them (its Enter runs rows, its Escape clears the
					// query; here Enter picks the highlighted note and
					// Escape closes). The highlighted row is read from the
					// DOM: the command places auto-highlights silently, so
					// onValueChange alone misses them. tagName, not
					// instanceof: happy-dom realms have their own classes.
					if ((e.target as HTMLElement | null)?.tagName !== "INPUT") return;
					if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
						if (query.trim() === "") return;
						const id =
							(e.currentTarget as HTMLElement).querySelector("[data-highlighted]")
								?.getAttribute("data-value") ?? null;
						const n = id !== null ? byId.get(id) : undefined;
						if (n !== undefined) {
							onPick(n);
							onClose();
						}
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						onClose();
					}
				}}
			>
				<CommandInput placeholder="Search notes" aria-label="Search notes" autoFocus />
				{failed && <p className="error">Couldn't list notes.</p>}
				<CommandList className="note-pick-list">
					{(notes ?? []).map((n) => (
						<CommandItem key={n.id} value={n.id} data-value={n.id}>
							<button type="button">
								{n.title}
								{n.projectId !== null && <span className="note-proj"> · project</span>}
							</button>
						</CommandItem>
					))}
				</CommandList>
				{notes !== null && notes.length === 0 && (
					<p className="empty">{query === "" ? "No notes yet." : "No matches."}</p>
				)}
				{truncated && notes !== null && notes.length > 0 && (
					<p className="empty" role="status">
						Showing the first {notes.length} matching notes — narrow the search to find the rest.
					</p>
				)}
			</Command>
		</div>
	);
}
